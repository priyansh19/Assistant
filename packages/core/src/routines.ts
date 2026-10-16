/**
 * Routines: "every morning, summarize the inbox threads waiting on me". Clicky does the job now and
 * again on a cadence, on this PC while it's awake and Clicky is open (never in the cloud, so not
 * for exact-time delivery). The scheduler decisions are pure and live here; the app supplies the
 * clock, the network state and whether the user is busy.
 *
 * Safety rules, from HeyClicky and our own runs: at least 2 minutes apart; one run at a time; a
 * run never starts while Clicky is busy (it waits for the next tick); overdue runs after sleep run
 * once, not once per missed slot; offline runs wait for the network and say so; three failures in
 * a row pause the routine; a later run reports only what changed; a retry never repeats an
 * external action that already succeeded.
 */

export interface Cadence {
  everyMinutes: number;
  /** Local hour (0-23) for daily and weekly routines. */
  atHour?: number;
  /** 0 = Sunday … 6 = Saturday, for weekly routines. */
  weekday?: number;
  /** Monday to Friday only. */
  weekdaysOnly?: boolean;
}

export interface Routine {
  id: string;
  /** The Clicky that owns it; routines without an owner run as plain Clicky. */
  clickySlug?: string;
  title: string;
  /** The self-contained instruction for every run; never restates the cadence. */
  task: string;
  cadence: Cadence;
  createdAt: number;
  paused: boolean;
  pausedReason?: 'user' | 'failures' | 'owner-gone';
  nextRunAt: number;
  runCount: number;
  lastRunStartedAt?: number;
  lastRunFinishedAt?: number;
  lastSummary?: string;
  lastFailed?: boolean;
  consecutiveFailures: number;
  /** Set while a due run is held because the PC is offline. */
  waitingForNetworkSince?: number;
  /** The last run was interrupted or failed; the next one is a retry. */
  retry?: boolean;
}

export const MIN_EVERY_MINUTES = 2;
export const PAUSE_AFTER_FAILURES = 3;
export const RETRY_AFTER_MS = 15 * 60_000;
const DAY = 1440;
const WEEK = 7 * DAY;

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
const UNIT: Record<string, number> = { minute: 1, min: 1, hour: 60, hr: 60, day: DAY, week: WEEK, month: 30 * DAY };
const PART_OF_DAY: Record<string, number> = { morning: 8, afternoon: 14, evening: 18, night: 21, tonight: 21 };

function hourFrom(text: string): number | undefined {
  const m = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text) ?? /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (!m?.[1]) return undefined;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h >= 0 && h <= 23 ? h : undefined;
}

const CADENCE =
  /\b(?:(every|each)\s+(?:(other|few|couple of|\d+|one|two|three|four|five|six|ten|twelve|fifteen|twenty|thirty)\s+)?(minutes?|mins?|hours?|hrs?|days?|weeks?|months?|mornings?|afternoons?|evenings?|nights?|weekdays?|sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?|(hourly|daily|nightly|weekly|monthly)|(once|twice|three times)\s+(?:a|per)\s+(hour|day|week|month))\b/i;

/**
 * The cadence in the user's words and the task with the cadence taken out: "every morning at 7
 * summarize my inbox" → daily at 7, "summarize my inbox". Null when no repeat was asked for.
 */
export function splitCadence(text: string): { cadence: Cadence; task: string } | null {
  const m = CADENCE.exec(text);
  if (!m) return null;
  const at = hourFrom(text);
  let cadence: Cadence | null = null;
  if (m[1]) {
    const qty = (m[2] ?? '').toLowerCase();
    const unitWord = (m[3] ?? '').toLowerCase().replace(/s$/, '');
    const dayIdx = DAYS.indexOf(unitWord);
    if (dayIdx >= 0) cadence = { everyMinutes: WEEK, weekday: dayIdx, atHour: at ?? 9 };
    else if (unitWord === 'weekday') cadence = { everyMinutes: DAY, weekdaysOnly: true, atHour: at ?? 9 };
    else if (unitWord in PART_OF_DAY) cadence = { everyMinutes: qty === 'other' ? 2 * DAY : DAY, atHour: at ?? PART_OF_DAY[unitWord] ?? 9 };
    else {
      const unit = UNIT[unitWord] ?? UNIT[unitWord.replace(/s$/, '')];
      if (!unit) return null;
      const n = qty === 'other' ? 2 : qty === 'few' ? 3 : qty === 'couple of' ? 2 : qty ? Number(qty) || NUM[qty] || 1 : 1;
      cadence = { everyMinutes: n * unit };
      if (unit >= DAY && at !== undefined) cadence.atHour = at;
      else if (unit >= DAY) cadence.atHour = 9;
    }
  } else if (m[4]) {
    const w = m[4].toLowerCase();
    cadence =
      w === 'hourly'
        ? { everyMinutes: 60 }
        : w === 'nightly'
          ? { everyMinutes: DAY, atHour: at ?? 21 }
          : w === 'weekly'
            ? { everyMinutes: WEEK, weekday: 1, atHour: at ?? 9 }
            : w === 'monthly'
              ? { everyMinutes: 30 * DAY, atHour: at ?? 9 }
              : { everyMinutes: DAY, atHour: at ?? 9 };
  } else if (m[5] && m[6]) {
    const times = m[5].toLowerCase() === 'once' ? 1 : m[5].toLowerCase() === 'twice' ? 2 : 3;
    const unit = UNIT[m[6].toLowerCase()] ?? DAY;
    cadence = { everyMinutes: Math.round(unit / times) };
    if (times === 1 && unit >= DAY) cadence.atHour = at ?? 9;
  }
  if (!cadence) return null;
  cadence.everyMinutes = Math.max(MIN_EVERY_MINUTES, Math.round(cadence.everyMinutes));
  const task = text
    .replace(m[0], ' ')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, ' ')
    .replace(/^\s*(?:(?:hey|ok(?:ay)?)\s+)?(?:clickey|clicky)?[\s,:]*/i, '')
    .replace(/^\s*(?:,|and|then|please)\s+/i, '')
    .replace(/\s*,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,.]+$/g, '')
    .trim();
  return task.length >= 3 ? { cadence, task } : null;
}

/** "every day at 8:00", "every 3 hours", "Mondays at 9:00", for the dashboard and the voice. */
export function describeCadence(c: Cadence): string {
  const at = c.atHour !== undefined ? ` at ${String(c.atHour).padStart(2, '0')}:00` : '';
  const day = c.weekday !== undefined ? DAYS[c.weekday] : undefined;
  if (day) return `${day.charAt(0).toUpperCase()}${day.slice(1)}s${at}`;
  if (c.weekdaysOnly) return `weekdays${at}`;
  const m = c.everyMinutes;
  if (m % DAY === 0) return m === DAY ? `every day${at}` : `every ${m / DAY} days${at}`;
  if (m % 60 === 0) return m === 60 ? 'every hour' : `every ${m / 60} hours`;
  return `every ${m} minutes`;
}

/** The first run time at or after `after` that fits the cadence (local time). */
export function nextRunAfter(c: Cadence, after: number): number {
  if (c.atHour === undefined) return after + c.everyMinutes * 60_000;
  const d = new Date(after);
  d.setMinutes(0, 0, 0);
  d.setHours(c.atHour);
  if (d.getTime() <= after) d.setDate(d.getDate() + 1);
  for (let i = 0; i < 400; i++) {
    const wd = d.getDay();
    const okDay = c.weekday !== undefined ? wd === c.weekday : c.weekdaysOnly ? wd >= 1 && wd <= 5 : true;
    if (okDay) break;
    d.setDate(d.getDate() + 1);
  }
  // Every N days (every other evening, monthly): N-1 more days after the next slot.
  if (c.weekday === undefined && !c.weekdaysOnly) d.setDate(d.getDate() + Math.max(0, Math.round(c.everyMinutes / DAY) - 1));
  return d.getTime();
}

export function newRoutine(input: { title: string; task: string; cadence: Cadence; clickySlug?: string | undefined }, now: number): Routine {
  return {
    id: `r${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    ...(input.clickySlug ? { clickySlug: input.clickySlug } : {}),
    title: input.title.trim().slice(0, 40),
    task: input.task.trim().slice(0, 1000),
    cadence: { ...input.cadence, everyMinutes: Math.max(MIN_EVERY_MINUTES, input.cadence.everyMinutes) },
    createdAt: now,
    paused: false,
    // The first run happens now, with the request; the schedule starts after it.
    nextRunAt: now,
    runCount: 0,
    consecutiveFailures: 0,
  };
}

/** A short title from the task: "summarize my inbox threads" → "Summarize Inbox Threads". */
export function titleFor(task: string): string {
  const w = task
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x && !/^(the|a|an|my|me|for|to|of|and|on|in|what|whats|that|is|are|any|all|please|new)$/i.test(x));
  return (
    w
      .slice(0, 3)
      .map((x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase())
      .join(' ') || 'Routine'
  );
}

// ---- requests from the agent's <ROUTINE> block

export type RoutineRequest =
  | { action: 'create'; everyMinutes: number; title: string; task: string }
  | { action: 'update'; title: string; everyMinutes?: number; newTitle?: string; task?: string }
  | { action: 'delete' | 'pause' | 'resume'; title: string };

/** Validate a <ROUTINE> JSON block: whole minutes of at least 2, a 2-4 word title, a task. */
export function parseRoutineRequest(json: string): { ok: true; request: RoutineRequest } | { ok: false; error: string } {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  if (typeof o !== 'object' || o === null) return { ok: false, error: 'not an object' };
  const r = o as Record<string, unknown>;
  const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
  if (!title) return { ok: false, error: 'title is missing' };
  const every = r['every_minutes'];
  const everyOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_EVERY_MINUTES;
  const titleWords = title.split(/\s+/).length;
  switch (r['action']) {
    case 'create': {
      if (!everyOk(every)) return { ok: false, error: `every_minutes must be a whole number of at least ${MIN_EVERY_MINUTES}` };
      if (titleWords < 2 || titleWords > 4) return { ok: false, error: 'title must be two to four words' };
      const task = typeof r['task'] === 'string' ? r['task'].trim() : '';
      if (task.length < 5) return { ok: false, error: 'task is missing' };
      return { ok: true, request: { action: 'create', everyMinutes: every, title, task } };
    }
    case 'update': {
      if (every !== undefined && !everyOk(every)) return { ok: false, error: 'every_minutes must be a whole number of at least 2' };
      const req: RoutineRequest = { action: 'update', title };
      if (every !== undefined) req.everyMinutes = every;
      if (typeof r['new_title'] === 'string' && r['new_title'].trim()) req.newTitle = r['new_title'].trim();
      if (typeof r['task'] === 'string' && r['task'].trim()) req.task = r['task'].trim();
      return { ok: true, request: req };
    }
    case 'delete':
    case 'pause':
    case 'resume':
      return { ok: true, request: { action: r['action'], title } };
    default:
      return { ok: false, error: 'unknown action' };
  }
}

const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Apply a request to the routine list. A create that matches an existing routine of the same
 * owner by title updates it instead of making a twin.
 */
export function applyRoutineRequest(
  routines: readonly Routine[],
  req: RoutineRequest,
  owner: string | undefined,
  now: number,
): { routines: Routine[]; changed: Routine | null; error?: string } {
  const idx = routines.findIndex((r) => r.clickySlug === owner && sameTitle(r.title, req.title));
  const list = [...routines];
  const found = list[idx];
  if (req.action === 'create') {
    if (found) {
      const cur = found;
      const cadence = { ...cur.cadence, everyMinutes: req.everyMinutes };
      const updated: Routine = { ...cur, task: req.task, cadence, nextRunAt: nextRunAfter(cadence, now) };
      list[idx] = updated;
      return { routines: list, changed: updated };
    }
    const created = newRoutine({ title: req.title, task: req.task, cadence: { everyMinutes: req.everyMinutes }, clickySlug: owner }, now);
    // The agent did the first run in this same turn; the schedule starts after it.
    created.runCount = 1;
    created.lastRunStartedAt = now;
    created.lastRunFinishedAt = now;
    created.nextRunAt = nextRunAfter(created.cadence, now);
    return { routines: [...list, created], changed: created };
  }
  if (!found) return { routines: list, changed: null, error: `no routine called "${req.title}"` };
  const cur = found;
  if (req.action === 'delete') {
    list.splice(idx, 1);
    return { routines: list, changed: cur };
  }
  let next: Routine;
  if (req.action === 'pause') next = { ...cur, paused: true, pausedReason: 'user' };
  else if (req.action === 'resume') next = resumeRoutine(cur, now);
  else if (req.action === 'update') {
    const cadence = req.everyMinutes ? { ...cur.cadence, everyMinutes: req.everyMinutes } : cur.cadence;
    next = {
      ...cur,
      title: req.newTitle ?? cur.title,
      task: req.task ?? cur.task,
      cadence,
      nextRunAt: req.everyMinutes ? nextRunAfter(cadence, now) : cur.nextRunAt,
    };
  } else next = cur;
  list[idx] = next;
  return { routines: list, changed: next };
}

export function resumeRoutine(r: Routine, now: number): Routine {
  const { pausedReason: _drop, ...rest } = r;
  void _drop;
  return { ...rest, paused: false, consecutiveFailures: 0, nextRunAt: Math.max(r.nextRunAt, now) };
}

// ---- the scheduler

export interface SchedulerEnv {
  now: number;
  online: boolean;
  /** Something is running (an answer, an agent task, another routine). */
  busy: boolean;
  /** The quiet gate says hold background work (a call, a presentation, Focus). */
  quiet: boolean;
  /** Agent mode is set up and allowed. */
  agentReady: boolean;
  /** Slugs of Clickys that still exist (not deleted). Archived ones still run their routines. */
  clickys: ReadonlySet<string>;
}

export type TickDecision =
  | { kind: 'run'; routine: Routine }
  | { kind: 'wait-network'; routine: Routine; firstTime: boolean }
  | { kind: 'pause-owner-gone'; routine: Routine }
  | { kind: 'hold'; why: 'busy' | 'quiet' | 'agent-off' };

/**
 * What to do this tick. At most one routine runs; the most overdue goes first. Overdue routines
 * after sleep are not replayed per missed slot: each runs once, then its next time is computed
 * from now.
 */
export function planTick(routines: readonly Routine[], env: SchedulerEnv): TickDecision[] {
  const out: TickDecision[] = [];
  const due = routines
    .filter((r) => !r.paused && r.nextRunAt <= env.now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
  const live: Routine[] = [];
  for (const r of due) {
    if (r.clickySlug && !env.clickys.has(r.clickySlug)) out.push({ kind: 'pause-owner-gone', routine: r });
    else live.push(r);
  }
  if (!live.length) return out;
  if (!env.agentReady) return [...out, { kind: 'hold', why: 'agent-off' }];
  if (!env.online) {
    for (const r of live) out.push({ kind: 'wait-network', routine: r, firstTime: r.waitingForNetworkSince === undefined });
    return out;
  }
  if (env.busy) return [...out, { kind: 'hold', why: 'busy' }];
  if (env.quiet) return [...out, { kind: 'hold', why: 'quiet' }];
  const first = live[0];
  return first ? [...out, { kind: 'run', routine: first }] : out;
}

export function markWaitingForNetwork(r: Routine, now: number): Routine {
  return r.waitingForNetworkSince === undefined ? { ...r, waitingForNetworkSince: now } : r;
}

export function markOwnerGone(r: Routine): Routine {
  return { ...r, paused: true, pausedReason: 'owner-gone' };
}

export function markStarted(r: Routine, now: number): Routine {
  const { waitingForNetworkSince: _w, ...rest } = r;
  void _w;
  return { ...rest, lastRunStartedAt: now, runCount: r.runCount + 1 };
}

export interface RunOutcome {
  ok: boolean;
  /** The run failed because the network dropped, not because the task failed. */
  transient?: boolean;
  /** Stopped by the user: not a failure, and no retry. */
  stopped?: boolean;
  summary?: string;
}

/** The routine after a run: counters, next time, retry, and the pause after repeated failures. */
export function markFinished(r: Routine, outcome: RunOutcome, now: number): Routine {
  const base: Routine = { ...r, lastRunFinishedAt: now };
  if (outcome.summary) base.lastSummary = outcome.summary.slice(0, 300);
  if (outcome.ok || outcome.stopped) {
    return { ...base, lastFailed: false, consecutiveFailures: 0, retry: false, nextRunAt: nextRunAfter(r.cadence, now) };
  }
  if (outcome.transient) {
    // Not counted against the routine: run again once the network is back.
    return { ...base, lastFailed: true, retry: true, nextRunAt: now, waitingForNetworkSince: now };
  }
  const failures = r.consecutiveFailures + 1;
  if (failures >= PAUSE_AFTER_FAILURES)
    return { ...base, lastFailed: true, consecutiveFailures: failures, paused: true, pausedReason: 'failures', retry: true };
  const regular = nextRunAfter(r.cadence, now);
  return { ...base, lastFailed: true, consecutiveFailures: failures, retry: true, nextRunAt: Math.min(regular, now + RETRY_AFTER_MS) };
}

/** The instruction for one run: the full job first, then only what changed, retries idempotent. */
export function routineRunPrompt(r: Routine, when: (ms: number) => string): string {
  const head = `[Routine "${r.title}" run #${r.runCount + 1}] ${r.task}`;
  const rules: string[] = [];
  if (r.runCount === 0) rules.push('This is the first run of a repeating routine. Do the task fully this time; later runs report only what changed.');
  else if (r.lastRunStartedAt)
    rules.push(
      `The previous run started ${when(r.lastRunStartedAt)}${r.lastSummary ? ` and found: "${r.lastSummary}"` : ''}. Report only what is new or changed since then, keep it short, and say so in one line if nothing changed.`,
    );
  if (r.retry)
    rules.push(
      'The previous attempt failed or was interrupted. Check what is already done first and finish only what is still missing. Do not repeat any message, post, upload or other outside action that already succeeded. If you are not sure whether one went through, check before trying again.',
    );
  rules.push('Answer with the result. Do not create files unless the task asks for one, and do not set up another repeat.');
  return [head, ...rules].join('\n');
}

/** Honest lines for the voice, notifications and the dashboard. */
export const routineCopy = {
  confirm: (r: Pick<Routine, 'cadence'>): string =>
    `I'll do this ${describeCadence(r.cadence)} while your PC is on and I'm running.`,
  offline: (title: string): string =>
    `I couldn't get online when "${title}" was due, so I haven't started it yet. I'll run it as soon as the internet is back.`,
  paused: (title: string, n: number): string => `"${title}" failed ${n} times in a row, so I paused it. Fix what's wrong, then resume it.`,
  ownerGone: (title: string): string => `"${title}" is paused because the helper that owned it was deleted.`,
  noTwin: (title: string): string => `You already have a routine called "${title}", so I updated it instead of adding another.`,
  tooOften: `Routines run at most every ${MIN_EVERY_MINUTES} minutes.`,
};
