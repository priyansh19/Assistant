import { describe, expect, it, vi } from 'vitest';
import type { DisplayGeometry } from './coordinates.js';
import type { HistoryEntry } from './history.js';
import type { InteractionState } from './interaction.js';
import {
  ConfigError,
  MIC_TAIL_MS,
  MIN_HOLD_MS,
  Orchestrator,
  type OrchestratorDeps,
  type ScreenCapture,
} from './orchestrator.js';
import type { SttProvider, SttSession, VisionChatProvider, VisionChatRequest } from './providers.js';
import type { SpeechFactory, SpeechOutput } from './speech.js';

const display: DisplayGeometry = { id: 7, bounds: { x: 0, y: 0, width: 1536, height: 960 }, scaleFactor: 1.25 };
const screens: ScreenCapture = {
  images: [{ data: new Uint8Array([1]), mediaType: 'image/jpeg', width: 1280, height: 800 }],
  geometry: [{ display, imageWidth: 1280, imageHeight: 800 }],
  cursorScreen: 1,
};

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeStt(transcript: string, opts: { failStart?: boolean; frames?: Int16Array[] } = {}): SttProvider {
  return {
    id: 'fake-stt',
    async start() {
      if (opts.failStart) throw new Error('401 Unauthorized');
      const session: SttSession = {
        pushAudio: (f) => opts.frames?.push(f),
        finish: async () => transcript,
        close: () => undefined,
      };
      return session;
    },
  };
}

function fakeChat(
  chunks: string[],
  opts: { delayMs?: number; hang?: boolean } = {},
): VisionChatProvider & {
  requests: VisionChatRequest[];
} {
  const requests: VisionChatRequest[] = [];
  return {
    id: 'fake-chat',
    requests,
    async *stream(req) {
      requests.push(req);
      if (opts.hang)
        await new Promise((_r, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      for (const c of chunks) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (req.signal.aborted) throw new Error('aborted');
        yield c;
      }
    },
  };
}

function fakeSpeech(): SpeechFactory & { said: string[]; stopped: number } {
  const said: string[] = [];
  const f = {
    said,
    stopped: 0,
    create(): SpeechOutput {
      let first: (() => void) | null = null;
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      return {
        say(s) {
          said.push(s);
          if (first) {
            const fn = first;
            first = null;
            fn();
          }
        },
        end: () => setTimeout(resolve, 1),
        done,
        onFirstAudio(fn) {
          first = fn;
        },
        stop() {
          f.stopped++;
          resolve();
        },
      };
    },
  };
  return f;
}

function setup(over: Partial<OrchestratorDeps> = {}) {
  let clock = 0;
  const states: InteractionState[] = [];
  const points: Array<{ x: number; y: number; label: string }> = [];
  const messages: string[] = [];
  const history: Array<Omit<HistoryEntry, 'id' | 'at'>> = [];
  const speech = fakeSpeech();
  const chat = fakeChat(['[POINT:640,400:Export button]', 'Click Export. ', 'Then choose PDF.']);
  const micStop = vi.fn();
  const deps: OrchestratorDeps = {
    chat: () => chat,
    stt: () => fakeStt('where is export'),
    speech: () => speech,
    capture: { begin: vi.fn(), take: async () => screens },
    mic: { start: async () => undefined, stop: micStop },
    overlay: {
      state: (s) => states.push(s),
      point: (p, label) => points.push({ x: p.local.x, y: p.local.y, label }),
      message: (m) => messages.push(m),
    },
    recentTurns: () => [],
    record: (e) => history.push(e),
    now: () => clock,
    ...over,
  };
  const o = new Orchestrator(deps);
  return {
    o,
    deps,
    chat,
    speech,
    states,
    points,
    messages,
    history,
    micStop,
    advance: (ms: number) => (clock += ms),
  };
}

async function settle(o: Orchestrator) {
  for (let i = 0; i < 50 && !['idle', 'cancelled', 'error'].includes(o.state); i++)
    await new Promise((r) => setTimeout(r, 2));
}

describe('Orchestrator', () => {
  it('runs the full voice loop: point, speak, record', async () => {
    const t = setup();
    t.o.keyDown();
    expect(t.deps.capture.begin).toHaveBeenCalled();
    t.advance(1000);
    t.o.keyUp();
    await settle(t.o);
    expect(t.states).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'idle']);
    expect(t.points).toEqual([{ x: 768, y: 480, label: 'Export button' }]);
    expect(t.speech.said).toEqual(['Click Export.', 'Then choose PDF.']);
    expect(t.chat.requests[0]?.question).toBe('where is export');
    expect(t.chat.requests[0]?.system).toContain('screen1: 1280x800 px');
    expect(t.history).toEqual([
      expect.objectContaining({
        question: 'where is export',
        answer: 'Click Export. Then choose PDF.',
        pointLabel: 'Export button',
        outcome: 'answered',
        source: 'voice',
      }),
    ]);
    expect(t.micStop).toHaveBeenCalled();
  });

  it('streams mic frames recorded before STT connected', async () => {
    const frames: Int16Array[] = [];
    const t = setup({
      stt: () => fakeStt('hi', { frames }),
      mic: {
        start: async (onFrame) => {
          onFrame(new Int16Array([1]));
          onFrame(new Int16Array([2]));
        },
        stop: () => undefined,
      },
    });
    t.o.keyDown();
    await tick();
    expect(frames.map((f) => f[0])).toEqual([1, 2]);
  });

  it('treats a quick tap as an accident', async () => {
    const t = setup();
    t.o.keyDown();
    t.advance(MIN_HOLD_MS - 1);
    t.o.keyUp();
    await settle(t.o);
    expect(t.states).toEqual(['listening', 'cancelled']);
    expect(t.history).toEqual([]);
  });

  it('tells the user when nothing was heard', async () => {
    const t = setup({ stt: () => fakeStt('  ') });
    t.o.keyDown();
    t.advance(1000);
    t.o.keyUp();
    await settle(t.o);
    expect(t.o.state).toBe('cancelled');
    expect(t.messages[0]).toMatch(/didn't catch/);
  });

  it('shows a config error and never looks successful', async () => {
    const t = setup({
      chat: () => {
        throw new ConfigError('Add your Anthropic key in Settings.');
      },
    });
    t.o.keyDown();
    t.advance(1000);
    t.o.keyUp();
    await settle(t.o);
    expect(t.o.state).toBe('error');
    expect(t.messages).toContain('Add your Anthropic key in Settings.');
    expect(t.history[0]?.outcome).toBe('error');
  });

  it('maps HTTP auth failures to a helpful message', async () => {
    const t = setup({ stt: () => fakeStt('x', { failStart: true }) });
    t.o.keyDown();
    await settle(t.o);
    expect(t.o.state).toBe('error');
    expect(t.messages[0]).toMatch(/key was rejected/);
  });

  it('cancels mid-answer and stops speech', async () => {
    const t = setup({ chat: () => fakeChat(['Hello there. ', 'More text. ', 'Even more.'], { delayMs: 5 }) });
    t.o.keyDown();
    t.advance(1000);
    t.o.keyUp();
    await new Promise((r) => setTimeout(r, MIC_TAIL_MS + 20));
    t.o.cancel('escape');
    await settle(t.o);
    expect(t.o.state).toBe('cancelled');
    expect(t.speech.stopped).toBeGreaterThan(0);
    expect(t.history[0]?.outcome).toBe('cancelled');
  });

  it('a new key press interrupts the current answer', async () => {
    const t = setup({ chat: () => fakeChat(['One. ', 'Two. ', 'Three.'], { delayMs: 5 }) });
    t.o.keyDown();
    t.advance(1000);
    t.o.keyUp();
    await new Promise((r) => setTimeout(r, MIC_TAIL_MS + 15));
    t.o.keyDown();
    expect(t.o.state).toBe('listening');
    await tick(); // history is written after the new mic has started
    expect(t.history[0]?.outcome).toBe('cancelled');
  });

  it('times out a stalled model', async () => {
    const t = setup({ chat: () => fakeChat([], { hang: true }), timeouts: { firstTokenMs: 20 } });
    t.o.keyDown();
    t.advance(1000);
    t.o.keyUp();
    await new Promise((r) => setTimeout(r, MIC_TAIL_MS + 80));
    expect(t.o.state).toBe('error');
    expect(t.messages[0]).toMatch(/took too long/);
  });

  it('skips an out-of-bounds point but still speaks', async () => {
    const t = setup({ chat: () => fakeChat(['[POINT:5000,10:Nowhere]Here you go.']) });
    t.o.keyDown();
    t.advance(1000);
    t.o.keyUp();
    await settle(t.o);
    expect(t.points).toEqual([]);
    expect(t.speech.said).toEqual(['Here you go.']);
    expect(t.o.state).toBe('idle');
  });

  it('answers typed questions and actions without the mic', async () => {
    const micStart = vi.fn(async () => undefined);
    const t = setup({ mic: { start: micStart, stop: () => undefined } });
    await t.o.ask('  where is export? ', 'action');
    await settle(t.o);
    expect(micStart).not.toHaveBeenCalled();
    expect(t.o.state).toBe('idle');
    expect(t.history[0]).toMatchObject({ question: 'where is export?', source: 'action', outcome: 'answered' });
  });

  it('passes recent turns as context', async () => {
    const t = setup({
      recentTurns: () => [
        { role: 'user', text: 'prev' },
        { role: 'assistant', text: 'ans' },
      ],
    });
    await t.o.ask('and now?', 'typed');
    await settle(t.o);
    expect(t.chat.requests[0]?.history).toHaveLength(2);
  });

  it('fails on an empty model answer instead of going silent', async () => {
    const t = setup({ chat: () => fakeChat(['[POINT:none]']) });
    await t.o.ask('hello', 'typed');
    await settle(t.o);
    expect(t.o.state).toBe('error');
  });
});
