import { describe, expect, it, vi } from 'vitest';
import { BEAT_LINES } from './beat.js';
import type { DisplayGeometry } from './coordinates.js';
import type { GuideTarget, HitArea } from './guide.js';
import type { LatencySummary } from './latency.js';
import { Orchestrator, type OrchestratorDeps } from './orchestrator.js';
import type { GuidePort, ScreenCapture } from './ports.js';
import type { VisionChatProvider, VisionChatRequest } from './providers.js';
import type { SpeechFactory, SpeechOutput } from './speech.js';

const display: DisplayGeometry = { id: 7, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1 };
const screens: ScreenCapture = {
  images: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg', width: 1000, height: 800 }],
  geometry: [{ display, imageWidth: 1000, imageHeight: 800 }],
  cursorScreen: 1,
};

/** A chat that answers request n with replies[n] (the last one repeats). */
function scriptedChat(
  id: string,
  replies: string[][],
  opts: { delayMs?: number } = {},
): VisionChatProvider & { requests: VisionChatRequest[] } {
  const requests: VisionChatRequest[] = [];
  return {
    id,
    model: id,
    requests,
    async *stream(req) {
      const chunks = replies[Math.min(requests.length, replies.length - 1)] ?? [];
      requests.push(req);
      for (const c of chunks) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (req.signal.aborted) throw new Error('aborted');
        yield c;
      }
    },
  };
}

function fakeSpeech(): SpeechFactory & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    create(): SpeechOutput {
      let first: (() => void) | null = null;
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      return {
        say(s) {
          said.push(s);
          const fn = first;
          first = null;
          fn?.();
        },
        end: () => setTimeout(resolve, 1),
        done,
        onFirstAudio(fn) {
          first = fn;
        },
        stop: () => resolve(),
      };
    },
  };
}

function fakeGuide(): GuidePort & { armed: GuideTarget[]; disarms: number } {
  const g = {
    armed: [] as GuideTarget[],
    disarms: 0,
    async arm(t: GuideTarget): Promise<HitArea> {
      g.armed.push(t);
      // Event space = global DIP in these tests.
      return { x: t.at.global.x, y: t.at.global.y, r: t.radius };
    },
    disarm() {
      g.disarms++;
    },
    foreground: async () => 'blender',
  };
  return g;
}

function setup(chat: VisionChatProvider, over: Partial<OrchestratorDeps> = {}) {
  let clock = 0;
  const speech = fakeSpeech();
  const guide = fakeGuide();
  const logs: string[] = [];
  const latencies: LatencySummary[] = [];
  const deps: OrchestratorDeps = {
    chat: () => chat,
    stt: () => {
      throw new Error('no stt in these tests');
    },
    speech: () => speech,
    capture: { begin: vi.fn(), take: async () => screens },
    mic: { start: async () => undefined, stop: vi.fn() },
    overlay: { state: () => undefined, point: () => undefined, message: () => undefined },
    recentTurns: () => [],
    record: () => undefined,
    log: (m) => logs.push(m),
    onLatency: (l) => latencies.push(l),
    now: () => clock,
    guide,
    guideSettings: { settleMs: 1, settleStepMs: 1, settleTries: 1 },
    features: () => ({ walkthroughs: true, beats: true, deep: true }),
    ...over,
  };
  const o = new Orchestrator(deps);
  return { o, speech, guide, logs, latencies, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('guided walkthroughs', () => {
  it('rings a step, waits for the click, looks again and asks for the next step until done', async () => {
    const chat = scriptedChat('fast', [
      ['[TARGET:500,500,30:Export] ', 'Click Export.'],
      ['[TARGET:200,250,20:PDF] Choose PDF.'],
      ['[POINT:none] Done, your file is exported.'],
    ]);
    const t = setup(chat);
    await t.o.ask('how do I export this as a PDF', 'typed');
    expect(chat.requests[0]?.system).toContain('Guided walkthroughs:');
    await until(() => t.guide.armed.length === 1, 'the first target');
    expect(t.guide.armed[0]).toMatchObject({ kind: 'click', label: 'Export', instruction: 'Click Export.' });
    expect(t.guide.armed[0]?.radius).toBeCloseTo(30, 0);
    expect(t.o.guiding).toBe(true);

    // A click outside the ring would end it; this one is inside.
    t.o.userInput({ kind: 'click', x: 505, y: 400 });
    await until(() => chat.requests.length === 2, 'the follow-up');
    const follow = chat.requests[1];
    expect(follow?.system).toContain('This is a guided walkthrough step');
    expect(follow?.system).not.toContain('Hard questions:');
    expect(follow?.question).toContain('clicked inside the target "Export"');
    expect(follow?.question).toContain('how do I export this as a PDF');
    expect(follow?.history).toEqual([]);
    await until(() => t.guide.armed.length === 2, 'the second target');

    t.o.userInput({ kind: 'click', x: 200, y: 200 });
    await until(() => chat.requests.length === 3, 'the last step');
    await until(() => t.speech.said.join('').includes('Done, your file is exported.'), 'the finish');
    // No target: the walkthrough waits a while for "next", then ends on its own.
    expect(t.guide.armed).toHaveLength(2);
    expect(t.speech.said.join('')).toContain('Choose PDF.');
    t.o.cancel('escape');
    expect(t.o.guiding).toBe(false);
  });

  it('ends quietly on a click elsewhere, with no follow-up request and nothing said', async () => {
    const chat = scriptedChat('fast', [['[TARGET:500,500,30:Export] Click Export.']]);
    const t = setup(chat);
    await t.o.ask('how do I export', 'typed');
    await until(() => t.guide.armed.length === 1, 'the target');
    const said = t.speech.said.length;
    t.o.userInput({ kind: 'click', x: 50, y: 50 });
    expect(t.o.guiding).toBe(false);
    expect(t.guide.disarms).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(chat.requests).toHaveLength(1);
    expect(t.speech.said).toHaveLength(said);
    expect(t.logs.some((l) => l.includes('walkthrough over (off-target)'))).toBe(true);
  });

  it('enforces the step limit in code even when the model keeps ringing', async () => {
    const chat = scriptedChat('fast', [['[TARGET:500,500,30:A] Click A.'], ['[TARGET:500,500,30:B] Click B.']]);
    const t = setup(chat, { guideSettings: { settleMs: 1, settleStepMs: 1, settleTries: 1, maxRounds: 1 } });
    await t.o.ask('how do I do it', 'typed');
    await until(() => t.guide.armed.length === 1, 'the target');
    t.o.userInput({ kind: 'click', x: 500, y: 400 });
    await until(() => chat.requests.length === 2, 'the follow-up');
    expect(chat.requests[1]?.question).toContain('may not ring any more targets');
    await until(() => !t.o.guiding, 'the end');
    expect(t.guide.armed).toHaveLength(1);
    expect(t.logs.some((l) => l.includes('round-limit'))).toBe(true);
  });

  it('a new question ends the walkthrough', async () => {
    const chat = scriptedChat('fast', [['[TARGET:500,500,30:Export] Click Export.'], ['[POINT:none] Sure.']]);
    const t = setup(chat);
    await t.o.ask('how do I export', 'typed');
    await until(() => t.guide.armed.length === 1, 'the target');
    await t.o.ask('what is this app', 'typed');
    expect(t.o.guiding).toBe(false);
    expect(chat.requests[1]?.question).toBe('what is this app');
  });

  it('after a manual step, "next" carries the walkthrough on', async () => {
    const chat = scriptedChat('fast', [
      ['[TARGET:500,500,30:Name box] Click the name box.'],
      ['[POINT:500,500:Name box] Type your name, then say next.'],
      ['[TARGET:700,700,20:Save] Click Save.'],
    ]);
    const t = setup(chat);
    await t.o.ask('how do I rename this', 'typed');
    await until(() => t.guide.armed.length === 1, 'the target');
    t.o.userInput({ kind: 'click', x: 500, y: 400 });
    await until(() => t.speech.said.join('').includes('say next'), 'the manual step');
    await until(() => t.logs.some((l) => l.includes('waiting for "next"')), 'parking');
    expect(t.o.guiding).toBe(true);
    await t.o.ask('okay next', 'typed');
    expect(chat.requests[2]?.question).toContain('Type your name, then say next.');
    await until(() => t.guide.armed.length === 2, 'the next target');
    expect(t.guide.armed[1]?.label).toBe('Save');
  });

  it('looks again once when the user clicks while the next step is being worked out', async () => {
    let calls = 0;
    const chat: VisionChatProvider & { requests: VisionChatRequest[] } = {
      id: 'fast',
      requests: [],
      async *stream(req) {
        chat.requests.push(req);
        calls++;
        if (calls === 1) {
          yield '[TARGET:500,500,30:Export] Click Export.';
          return;
        }
        // The follow-ups take a moment, so the user's second click lands meanwhile.
        await new Promise((r) => setTimeout(r, 30));
        if (req.signal.aborted) throw new Error('aborted');
        yield '[POINT:none] All done.';
      },
    };
    const t = setup(chat);
    await t.o.ask('how do I export', 'typed');
    await until(() => t.guide.armed.length === 1, 'the target');
    t.o.userInput({ kind: 'click', x: 500, y: 400 });
    await until(() => chat.requests.length === 2, 'the follow-up');
    t.o.userInput({ kind: 'click', x: 10, y: 10 });
    await until(() => chat.requests.length === 3, 'the refreshed follow-up');
    expect(chat.requests[2]?.question).toContain('clicked again while you were thinking');
    // Only once per step.
    t.o.userInput({ kind: 'click', x: 10, y: 10 });
    await until(() => t.speech.said.join('').includes('All done.'), 'the answer');
    expect(chat.requests).toHaveLength(3);
  });

  it('without walkthroughs, a TARGET only points and nothing is armed', async () => {
    const chat = scriptedChat('fast', [['[TARGET:500,500,30:Export] Click Export.']]);
    const t = setup(chat, { features: () => ({}) });
    const r = await t.o.ask('how do I export', 'typed');
    expect(chat.requests[0]?.system).not.toContain('Guided walkthroughs:');
    expect(r?.pointLabel).toBe('Export');
    expect(t.guide.armed).toHaveLength(0);
  });
});

describe('hard questions go to the stronger model', () => {
  it('[DEEP] from the fast model: a beat at once, then the stronger model answers after it', async () => {
    const fast = scriptedChat('fast', [['[DEEP]']]);
    const deep = scriptedChat('deep', [['[POINT:none] ', 'Plan B is cheaper over a year.']]);
    const t = setup(fast, { deepChat: () => deep });
    const r = await t.o.ask('which of these two plans works out cheaper over a year', 'typed');
    expect(fast.requests[0]?.system).toContain('Hard questions:');
    expect(deep.requests).toHaveLength(1);
    expect(deep.requests[0]?.system).not.toContain('Hard questions:');
    expect(deep.requests[0]?.question).toBe('which of these two plans works out cheaper over a year');
    expect(BEAT_LINES.deep).toContain(t.speech.said[0]);
    expect(t.speech.said.slice(1).join('')).toBe('Plan B is cheaper over a year.');
    expect(r).toMatchObject({ outcome: 'answered', answer: 'Plan B is cheaper over a year.' });
    const l = t.latencies.at(-1);
    expect(l?.meta?.['deep']).toBe('deep');
    expect(l?.keyUpToFirstSoundMs).not.toBeNull();
  });

  it('a request that plainly asks for depth skips the fast model', async () => {
    const fast = scriptedChat('fast', [['[POINT:none] quick']]);
    const deep = scriptedChat('deep', [['[POINT:none] Here it is, step by step.']]);
    const t = setup(fast, { deepChat: () => deep });
    await t.o.ask('explain it step by step', 'typed');
    expect(fast.requests).toHaveLength(0);
    expect(deep.requests).toHaveLength(1);
    expect(t.latencies.at(-1)?.meta?.['routedBy']).toBe('request');
  });

  it('with no stronger model the fast model is not offered [DEEP], and a stray one is ignored', async () => {
    const fast = scriptedChat('fast', [['[DEEP]', 'Plan B.']]);
    const t = setup(fast);
    const r = await t.o.ask('which plan is cheaper', 'typed');
    expect(fast.requests[0]?.system).not.toContain('Hard questions:');
    expect(r).toMatchObject({ outcome: 'answered', answer: 'Plan B.' });
  });

  it('[DEEP] after the answer has started is ignored', async () => {
    const fast = scriptedChat('fast', [['[POINT:none] Plan B. ', '[DEEP]']]);
    const deep = scriptedChat('deep', [['never']]);
    const t = setup(fast, { deepChat: () => deep });
    const r = await t.o.ask('which plan is cheaper', 'typed');
    expect(deep.requests).toHaveLength(0);
    expect(r?.answer).toBe('Plan B.');
  });

  it('without beats, the stronger model still answers, with nothing said first', async () => {
    const fast = scriptedChat('fast', [['[DEEP]']]);
    const deep = scriptedChat('deep', [['[POINT:none] Answer.']]);
    const t = setup(fast, { deepChat: () => deep, features: () => ({ deep: true }) });
    await t.o.ask('which plan is cheaper', 'typed');
    expect(t.speech.said).toEqual(['Answer.']);
  });
});
