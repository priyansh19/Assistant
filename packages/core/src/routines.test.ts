import { describe, expect, it } from 'vitest';
import {
  applyRoutineRequest,
  describeCadence,
  markFinished,
  markStarted,
  newRoutine,
  nextRunAfter,
  parseRoutineRequest,
  PAUSE_AFTER_FAILURES,
  planTick,
  resumeRoutine,
  routineCopy,
  routineRunPrompt,
  splitCadence,
  titleFor,
  type Routine,
  type SchedulerEnv,
} from './routines.js';

// Local times, so the tests pass in any time zone.
const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime(); // October 2026; the 16th is a Friday

describe('splitCadence', () => {
  it.each([
    ['every morning summarize the inbox threads waiting on me', { everyMinutes: 1440, atHour: 8 }, 'summarize the inbox threads waiting on me'],
    ['Clicky, every 3 hours check the build status', { everyMinutes: 180 }, 'check the build status'],
    ['check flight prices every few hours', { everyMinutes: 180 }, 'check flight prices'],
    ['every Monday at 10am send me the weekly sales numbers', { everyMinutes: 10080, weekday: 1, atHour: 10 }, 'send me the weekly sales numbers'],
    ['hourly, look for new PR comments', { everyMinutes: 60 }, 'look for new PR comments'],
    ['tidy my downloads folder daily at 6pm', { everyMinutes: 1440, atHour: 18 }, 'tidy my downloads folder'],
    ['every weekday at 9 list my meetings', { everyMinutes: 1440, weekdaysOnly: true, atHour: 9 }, 'list my meetings'],
    ['twice a day check the shop orders', { everyMinutes: 720 }, 'check the shop orders'],
    ['every minute ping the server', { everyMinutes: 2 }, 'ping the server'],
    ['every other evening back up my notes', { everyMinutes: 2880, atHour: 18 }, 'back up my notes'],
  ])('%s', (text, cadence, task) => {
    expect(splitCadence(text)).toEqual({ cadence, task });
  });

  it('ignores requests without a repeat', () => {
    expect(splitCadence('summarize my inbox')).toBeNull();
    expect(splitCadence('what did I do every day last week?')).not.toBeNull(); // caller confirms before creating
    expect(splitCadence('every day')).toBeNull(); // nothing to do
  });

  it('describes cadences', () => {
    expect(describeCadence({ everyMinutes: 1440, atHour: 8 })).toBe('every day at 08:00');
    expect(describeCadence({ everyMinutes: 180 })).toBe('every 3 hours');
    expect(describeCadence({ everyMinutes: 10080, weekday: 1, atHour: 9 })).toBe('Mondays at 09:00');
    expect(describeCadence({ everyMinutes: 30 })).toBe('every 30 minutes');
    expect(routineCopy.confirm({ cadence: { everyMinutes: 60 } })).toMatch(/every hour while your PC is on/);
  });

  it('titles', () => {
    expect(titleFor('summarize the inbox threads waiting on me')).toBe('Summarize Inbox Threads');
  });
});

describe('nextRunAfter', () => {
  it('daily at an hour', () => {
    expect(nextRunAfter({ everyMinutes: 1440, atHour: 8 }, at(16, 7))).toBe(at(16, 8));
    expect(nextRunAfter({ everyMinutes: 1440, atHour: 8 }, at(16, 8, 5))).toBe(at(17, 8));
  });
  it('weekdays skip the weekend', () => {
    expect(nextRunAfter({ everyMinutes: 1440, atHour: 9, weekdaysOnly: true }, at(16, 10))).toBe(at(19, 9));
  });
  it('weekly on a day', () => {
    expect(nextRunAfter({ everyMinutes: 10080, weekday: 1, atHour: 9 }, at(16, 10))).toBe(at(19, 9));
  });
  it('every other day', () => {
    expect(nextRunAfter({ everyMinutes: 2880, atHour: 18 }, at(16, 19))).toBe(at(18, 18));
  });
  it('plain intervals', () => {
    expect(nextRunAfter({ everyMinutes: 30 }, at(16, 10))).toBe(at(16, 10, 30));
  });
});

const env = (o: Partial<SchedulerEnv> = {}): SchedulerEnv => ({
  now: at(16, 12),
  online: true,
  busy: false,
  quiet: false,
  agentReady: true,
  clickys: new Set(['clicky-inbox-desk']),
  ...o,
});

const routine = (o: Partial<Routine> = {}): Routine => ({
  ...newRoutine({ title: 'Morning Inbox', task: 'summarize my inbox', cadence: { everyMinutes: 1440, atHour: 8 }, clickySlug: 'clicky-inbox-desk' }, at(10, 9)),
  nextRunAt: at(16, 8),
  runCount: 3,
  ...o,
});

describe('planTick', () => {
  it('runs the most overdue routine, one at a time', () => {
    const a = routine({ id: 'a', nextRunAt: at(16, 9) });
    const b = routine({ id: 'b', nextRunAt: at(16, 8) });
    const c = routine({ id: 'c', nextRunAt: at(17, 8) });
    expect(planTick([a, b, c], env())).toEqual([{ kind: 'run', routine: b }]);
  });

  it('holds while busy, quiet or agent mode is off', () => {
    expect(planTick([routine()], env({ busy: true }))).toEqual([{ kind: 'hold', why: 'busy' }]);
    expect(planTick([routine()], env({ quiet: true }))).toEqual([{ kind: 'hold', why: 'quiet' }]);
    expect(planTick([routine()], env({ agentReady: false }))).toEqual([{ kind: 'hold', why: 'agent-off' }]);
  });

  it('waits for the network and says so once', () => {
    const r = routine();
    expect(planTick([r], env({ online: false }))).toEqual([{ kind: 'wait-network', routine: r, firstTime: true }]);
    const waiting = routine({ waitingForNetworkSince: at(16, 8) });
    expect(planTick([waiting], env({ online: false }))[0]).toMatchObject({ firstTime: false });
    expect(routineCopy.offline('Morning Inbox')).toMatch(/haven't started it yet/);
  });

  it('pauses routines whose helper was deleted', () => {
    const r = routine({ clickySlug: 'clicky-gone' });
    expect(planTick([r], env())).toEqual([{ kind: 'pause-owner-gone', routine: r }]);
  });

  it('skips paused and not-yet-due routines', () => {
    expect(planTick([routine({ paused: true }), routine({ nextRunAt: at(17, 8) })], env())).toEqual([]);
  });

  it('runs an overdue routine once after sleep, not once per missed day', () => {
    let r = routine({ nextRunAt: at(12, 8) }); // asleep four days
    expect(planTick([r], env())).toHaveLength(1);
    r = markFinished(markStarted(r, at(16, 12)), { ok: true }, at(16, 12, 5));
    expect(r.nextRunAt).toBe(at(17, 8));
    expect(planTick([r], env())).toEqual([]);
  });
});

describe('after a run', () => {
  it('counts runs and clears the retry', () => {
    const r = markFinished(markStarted(routine({ retry: true }), at(16, 8)), { ok: true, summary: '3 new threads' }, at(16, 8, 2));
    expect(r).toMatchObject({ runCount: 4, retry: false, lastFailed: false, consecutiveFailures: 0, lastSummary: '3 new threads' });
  });

  it('retries soon after a failure and pauses after repeated failures', () => {
    let r = routine();
    for (let i = 1; i < PAUSE_AFTER_FAILURES; i++) {
      r = markFinished(r, { ok: false }, at(16, 8));
      expect(r.paused).toBe(false);
      expect(r.nextRunAt).toBe(at(16, 8, 15));
    }
    r = markFinished(r, { ok: false }, at(16, 9));
    expect(r).toMatchObject({ paused: true, pausedReason: 'failures', consecutiveFailures: PAUSE_AFTER_FAILURES });
    r = resumeRoutine(r, at(16, 10));
    expect(r).toMatchObject({ paused: false, consecutiveFailures: 0 });
    expect(r.pausedReason).toBeUndefined();
  });

  it("a dropped connection isn't a failure", () => {
    const r = markFinished(routine(), { ok: false, transient: true }, at(16, 8));
    expect(r).toMatchObject({ consecutiveFailures: 0, retry: true, nextRunAt: at(16, 8), waitingForNetworkSince: at(16, 8) });
  });

  it('stopping a run is not a failure', () => {
    expect(markFinished(routine(), { ok: false, stopped: true }, at(16, 8))).toMatchObject({ consecutiveFailures: 0, retry: false });
  });
});

describe('run prompts', () => {
  const when = (ms: number): string => new Date(ms).toISOString();
  it('first run does the full job', () => {
    expect(routineRunPrompt(routine({ runCount: 0 }), when)).toMatch(/first run.*fully/);
  });
  it('later runs report only what changed', () => {
    const p = routineRunPrompt(routine({ lastRunStartedAt: at(15, 8), lastSummary: '2 threads' }), when);
    expect(p).toMatch(/run #4/);
    expect(p).toMatch(/only what is new or changed/);
    expect(p).toMatch(/found: "2 threads"/);
  });
  it('retries never repeat outside actions', () => {
    expect(routineRunPrompt(routine({ retry: true }), when)).toMatch(/Do not repeat any message, post, upload/);
  });
});

describe('<ROUTINE> requests', () => {
  it('validates', () => {
    expect(parseRoutineRequest('{"action":"create","every_minutes":60,"title":"PR Mentions","task":"list new PR mentions"}').ok).toBe(true);
    expect(parseRoutineRequest('{"action":"create","every_minutes":1,"title":"Too Fast","task":"list it"}')).toMatchObject({ ok: false });
    expect(parseRoutineRequest('{"action":"create","every_minutes":60.5,"title":"Half Hour","task":"list it"}')).toMatchObject({ ok: false });
    expect(parseRoutineRequest('{"action":"create","every_minutes":60,"title":"Mentions","task":"list it"}')).toMatchObject({ ok: false, error: 'title must be two to four words' });
    expect(parseRoutineRequest('{"action":"explode","title":"x"}')).toMatchObject({ ok: false });
    expect(parseRoutineRequest('nope')).toMatchObject({ ok: false });
  });

  it('a second create updates instead of making a twin', () => {
    const r = parseRoutineRequest('{"action":"create","every_minutes":1440,"title":"Morning Inbox","task":"summarize unread mail"}');
    if (!r.ok) throw new Error(r.error);
    const existing = routine();
    const out = applyRoutineRequest([existing], r.request, 'clicky-inbox-desk', at(16, 12));
    expect(out.routines).toHaveLength(1);
    expect(out.changed?.task).toBe('summarize unread mail');
    const other = applyRoutineRequest([existing], r.request, 'clicky-other', at(16, 12));
    expect(other.routines).toHaveLength(2);
    expect(other.changed).toMatchObject({ runCount: 1, clickySlug: 'clicky-other' });
  });

  it('pause, resume, update, delete', () => {
    let list = [routine()];
    const apply = (json: string): void => {
      const r = parseRoutineRequest(json);
      if (!r.ok) throw new Error(r.error);
      list = applyRoutineRequest(list, r.request, 'clicky-inbox-desk', at(16, 12)).routines;
    };
    apply('{"action":"pause","title":"morning inbox"}');
    expect(list[0]!.paused).toBe(true);
    apply('{"action":"resume","title":"Morning Inbox"}');
    expect(list[0]!.paused).toBe(false);
    apply('{"action":"update","title":"Morning Inbox","new_title":"Inbox Digest","every_minutes":720}');
    expect(list[0]).toMatchObject({ title: 'Inbox Digest', cadence: { everyMinutes: 720 } });
    apply('{"action":"delete","title":"Inbox Digest"}');
    expect(list).toEqual([]);
    const missing = parseRoutineRequest('{"action":"pause","title":"Nope Nope"}');
    if (!missing.ok) throw new Error();
    expect(applyRoutineRequest([], missing.request, undefined, 0).error).toMatch(/no routine/);
  });
});
