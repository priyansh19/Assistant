import { describe, expect, it, vi } from 'vitest';
import type { DisplayGeometry } from './coordinates.js';
import type { HistoryEntry } from './history.js';
import type { InteractionState } from './interaction.js';
import { ConfigError } from './errors.js';
import type { LatencySummary } from './latency.js';
import {
  MIC_TAIL_MS,
  MIN_HOLD_MS,
  Orchestrator,
  WARM_CAPTURE_DELAY_MS,
  type OrchestratorDeps,
} from './orchestrator.js';
import type { ScreenCapture } from './ports.js';
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
    // Slow enough that the answer is still streaming when Esc arrives, however fast the machine.
    const t = setup({ chat: () => fakeChat(['Hello there. ', 'More text. ', 'Even more.'], { delayMs: 60 }) });
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

  it('lets the answer model listen to the recording directly', async () => {
    const chat = fakeChat(['[HEARD: where is export?]', '[POINT:none]', 'It is in File.']);
    const t = setup({
      listensDirectly: () => true,
      stt: () => {
        throw new Error('STT must not be used');
      },
      chat: () => chat,
      mic: {
        start: async (onFrame) => {
          for (let i = 0; i < 40; i++) onFrame(new Int16Array(320)); // 0.8 s
        },
        stop: () => undefined,
      },
    });
    t.o.keyDown();
    await tick();
    t.advance(1000);
    t.o.keyUp();
    await settle(t.o);
    expect(t.o.state).toBe('idle');
    expect(chat.requests[0]?.audio?.format).toBe('wav');
    expect(chat.requests[0]?.system).toContain('[HEARD:');
    expect(t.speech.said.join(' ')).toBe('It is in File.');
    await tick();
    expect(t.history[0]).toMatchObject({ question: 'where is export?', outcome: 'answered' });
  });

  describe('speed features', () => {
    /** STT whose interim transcript arrives as soon as the session opens; the final one takes a moment. */
    function partialStt(partial: string, final: string): SttProvider {
      return {
        id: 'fake-stt',
        async start() {
          return {
            pushAudio: () => undefined,
            finish: () => new Promise<string>((r) => setTimeout(() => r(final), 20)),
            onPartial: (fn) => fn(partial),
            close: () => undefined,
          };
        },
      };
    }

    function speedSetup(
      partial: string,
      final: string,
      speed: NonNullable<OrchestratorDeps['speed']>,
      chat = fakeChat(['It is in File. ']),
    ) {
      const latency: LatencySummary[] = [];
      const t = setup({
        stt: () => partialStt(partial, final),
        chat: () => chat,
        speed,
        onLatency: (s) => latency.push(s),
      });
      return { ...t, chat, latency };
    }

    it('answers the interim transcript at key-up when the final one matches', async () => {
      const t = speedSetup('where is the export button', 'Where is the export button?', () => ({ speculate: true }));
      t.o.keyDown();
      await tick();
      t.advance(400);
      t.o.keyUp();
      expect(t.chat.requests).toHaveLength(0);
      await tick();
      // Sent before the final transcript arrived.
      expect(t.chat.requests).toHaveLength(1);
      expect(t.o.state).toBe('transcribing');
      expect(t.speech.said).toEqual([]);
      await settle(t.o);
      expect(t.o.state).toBe('idle');
      expect(t.chat.requests).toHaveLength(1);
      expect(t.chat.requests[0]?.question).toBe('where is the export button');
      expect(t.speech.said).toEqual(['It is in File.']);
      await tick();
      expect(t.latency[0]?.meta?.['speculation']).toBe('hit');
      expect(t.history[0]).toMatchObject({ question: 'Where is the export button?', outcome: 'answered' });
    });

    it('discards the guess and asks again when the final transcript differs', async () => {
      const t = speedSetup('where is the export', 'Where is the export menu?', () => ({ speculate: true }));
      t.o.keyDown();
      await tick();
      t.advance(400);
      t.o.keyUp();
      await settle(t.o);
      expect(t.o.state).toBe('idle');
      expect(t.chat.requests.map((r) => r.question)).toEqual(['where is the export', 'Where is the export menu?']);
      expect(t.chat.requests[0]?.signal.aborted).toBe(true);
      expect(t.speech.said).toEqual(['It is in File.']);
      await tick();
      expect(t.latency[0]?.meta?.['speculation']).toBe('miss');
    });

    it('does not guess on an interim transcript that was still changing', async () => {
      let emit: (text: string) => void = () => undefined;
      const chat = fakeChat(['It is in File. ']);
      const t = setup({
        chat: () => chat,
        speed: () => ({ speculate: true }),
        stt: () => ({
          id: 'fake-stt',
          async start() {
            return {
              pushAudio: () => undefined,
              finish: () => new Promise<string>((r) => setTimeout(() => r('Where is the export button?'), 20)),
              onPartial: (fn: (text: string) => void) => {
                emit = fn;
                fn('where is the');
              },
              close: () => undefined,
            };
          },
        }),
      });
      t.o.keyDown();
      await tick();
      t.advance(400);
      emit('where is the export button'); // still talking right up to key-up
      t.advance(50);
      t.o.keyUp();
      await tick();
      expect(chat.requests).toHaveLength(0);
      await settle(t.o);
      expect(chat.requests).toHaveLength(1);
    });

    it('does nothing speculative when the setting is off', async () => {
      const t = speedSetup('where is the export', 'Where is the export menu?', () => ({}));
      t.o.keyDown();
      await tick();
      t.advance(400);
      t.o.keyUp();
      await tick();
      expect(t.chat.requests).toHaveLength(0);
      await settle(t.o);
      expect(t.chat.requests).toHaveLength(1);
    });

    it('sends the screenshot ahead and answers with the same one, marked cacheable', async () => {
      const chat = Object.assign(fakeChat(['It is in File. ']), {
        warmed: [] as Array<{ system: string; images: number }>,
        async warmCache(p: { system: string; images: readonly unknown[] }) {
          chat.warmed.push({ system: p.system, images: p.images.length });
        },
      });
      let takes = 0;
      const t = setup({
        chat: () => chat,
        speed: () => ({ warmCache: true }),
        capture: {
          begin: () => undefined,
          take: async () => {
            takes++;
            return screens;
          },
        },
      });
      t.o.keyDown();
      await new Promise((r) => setTimeout(r, WARM_CAPTURE_DELAY_MS + 30));
      expect(chat.warmed).toHaveLength(1);
      t.advance(1000);
      t.o.keyUp();
      await settle(t.o);
      expect(t.o.state).toBe('idle');
      expect(takes).toBe(1);
      expect(chat.requests[0]?.cache).toBe(true);
      expect(chat.requests[0]?.system).toBe(chat.warmed[0]?.system);
    });

    it('never warms the cache on a quick tap', async () => {
      const warm = vi.fn(async () => undefined);
      const chat = Object.assign(fakeChat(['x']), { warmCache: warm });
      const t = setup({ chat: () => chat, speed: () => ({ warmCache: true }) });
      t.o.keyDown();
      t.advance(100);
      t.o.keyUp();
      await new Promise((r) => setTimeout(r, WARM_CAPTURE_DELAY_MS + 30));
      expect(warm).not.toHaveBeenCalled();
    });

    it('starts speaking at the first clause when asked to', async () => {
      const chat = fakeChat(['Open the File menu, then ', 'click Export. ']);
      const t = setup({ chat: () => chat, speed: () => ({ eagerFirstClause: true }) });
      t.o.keyDown();
      t.advance(1000);
      t.o.keyUp();
      await settle(t.o);
      expect(t.speech.said).toEqual(['Open the File menu,', 'then click Export.']);
    });
  });
});

describe('dictation and agent mode', () => {
  it('dictation types the transcript, takes no screenshot and keeps no history', async () => {
    const typed: unknown[] = [];
    const t = setup({
      stt: () => fakeStt('ignored'),
      dictationStt: () => fakeStt('Dear team, the report is ready'),
      input: { run: async (a) => void typed.push(a) },
    });
    t.o.dictateDown();
    t.advance(MIN_HOLD_MS + 50);
    t.o.keyUp();
    await settle(t.o);
    expect(typed).toEqual([{ kind: 'type', text: 'Dear team, the report is ready ' }]);
    expect(t.deps.capture.begin).not.toHaveBeenCalled();
    expect(t.chat.requests).toHaveLength(0);
    await tick();
    expect(t.history).toEqual([]);
    expect(t.o.state).toBe('idle');
  });

  it('dictation without an input port fails visibly', async () => {
    const t = setup({ dictationStt: () => fakeStt('hello') });
    t.o.dictateDown();
    t.advance(MIN_HOLD_MS + 50);
    t.o.keyUp();
    await settle(t.o);
    expect(t.o.state).toBe('error');
    expect(t.messages.at(-1)).toMatch(/Typing into other apps/);
  });

  it('a question starting with "agent" runs the agent and speaks its summary', async () => {
    const actions: unknown[] = [];
    const chat = fakeChat(['{"action":"done","say":"All done."}']);
    const t = setup({
      chat: () => chat,
      input: { run: async (a) => void actions.push(a) },
      agent: () => ({ enabled: true, confirm: 'risky' }),
      confirm: async () => true,
    });
    const r = await t.o.ask('Agent, close this window', 'typed');
    expect(r?.outcome).toBe('answered');
    expect(r?.answer).toBe('All done.');
    expect(t.speech.said).toEqual(['All done.']);
    expect(chat.requests[0]?.question).toContain('Task: close this window');
  });

  it('agent requests are answered normally when agent mode is off', async () => {
    const t = setup({ agent: () => ({ enabled: false, confirm: 'risky' }), input: { run: async () => undefined } });
    const r = await t.o.ask('Agent, close this window', 'typed');
    expect(r?.answer).toBe('Click Export. Then choose PDF.');
  });
});
