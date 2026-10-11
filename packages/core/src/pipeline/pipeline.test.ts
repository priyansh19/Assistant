import { describe, expect, it, vi } from 'vitest';
import type { DisplayGeometry } from '../coordinates.js';
import { StageError } from '../errors.js';
import { LatencyRecorder } from '../latency.js';
import type { ScreenCapture } from '../ports.js';
import type { SttSession, VisionChatProvider, VisionChatRequest } from '../providers.js';
import type { SpeechFactory, SpeechOutput } from '../speech.js';
import { answerEvents, type AnswerEvent } from './answer-stage.js';
import { runAnswer, type AnswerRunHooks, type AnswerRunInput } from './answer-runner.js';
import { ListenStage } from './listen-stage.js';
import { SpeechStage } from './speech-stage.js';

const display: DisplayGeometry = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 1 };
const screens: ScreenCapture = {
  images: [{ data: new Uint8Array(10), mediaType: 'image/jpeg', width: 1280, height: 800 }],
  geometry: [{ display, imageWidth: 1280, imageHeight: 800 }],
  cursorScreen: 1,
};

function chatOf(chunks: string[], opts: { delayMs?: number; fail?: Error } = {}) {
  const requests: VisionChatRequest[] = [];
  let returned = false;
  const chat: VisionChatProvider & { requests: VisionChatRequest[]; returned: () => boolean } = {
    id: 'fake',
    requests,
    returned: () => returned,
    async *stream(req) {
      requests.push(req);
      try {
        for (const c of chunks) {
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          yield c;
        }
        if (opts.fail) throw opts.fail;
      } finally {
        returned = true;
      }
    },
  };
  return chat;
}

function request(over: Partial<VisionChatRequest> = {}): VisionChatRequest {
  return {
    system: '',
    history: [],
    question: 'q',
    images: [],
    maxTokens: 10,
    signal: new AbortController().signal,
    ...over,
  };
}

async function collect(it: AsyncIterable<AnswerEvent>): Promise<AnswerEvent[]> {
  const out: AnswerEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('answerEvents', () => {
  it('splits POINT tags from text across chunk boundaries', async () => {
    const events = await collect(
      answerEvents({
        chat: chatOf(['[POI', 'NT:10,20:Save]', 'Click ', 'Save.']),
        request: request(),
        firstTokenMs: 1000,
        answerMs: 1000,
        now: () => 0,
      }),
    );
    expect(events[0]).toMatchObject({ type: 'point', tag: { x: 10, y: 20, label: 'Save' } });
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Click Save.');
  });

  it('reports [POINT:none] as a null tag and the first token once', async () => {
    const onFirstToken = vi.fn();
    const events = await collect(
      answerEvents({
        chat: chatOf(['[POINT:none]', 'Hi.']),
        request: request(),
        firstTokenMs: 1000,
        answerMs: 1000,
        now: () => 0,
        onFirstToken,
      }),
    );
    expect(events[0]).toEqual({ type: 'point', tag: null });
    expect(onFirstToken).toHaveBeenCalledTimes(1);
  });

  it('strips a leading HEARD tag and reports it when the model listened', async () => {
    const events = await collect(
      answerEvents({
        chat: chatOf(['[HEARD:where is ', 'export] ', '[POINT:none]Top right.']),
        request: request({ audio: { data: new Uint8Array(4), format: 'wav' } }),
        firstTokenMs: 1000,
        answerMs: 1000,
        now: () => 0,
      }),
    );
    expect(events).toContainEqual({ type: 'heard', text: 'where is export' });
    expect(JSON.stringify(events)).not.toContain('HEARD');
  });

  it('times out waiting for the first token with a typed error', async () => {
    const err: unknown = await collect(
      answerEvents({
        chat: chatOf(['late'], { delayMs: 50 }),
        request: request(),
        firstTokenMs: 5,
        answerMs: 1000,
        now: () => 0,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ stage: 'answer', kind: 'timeout' });
  });

  it('closes the provider stream when the consumer stops early', async () => {
    const chat = chatOf(['a ', 'b ', 'c.'], { delayMs: 1 });
    for await (const _ of answerEvents({ chat, request: request(), firstTokenMs: 1000, answerMs: 1000, now: () => 0 }))
      break;
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.returned()).toBe(true);
  });
});

function speechOutput() {
  const said: string[] = [];
  let firstAudio: (() => void) | null = null;
  let resolve!: () => void;
  const out: SpeechOutput & { said: string[]; ended: boolean; stopped: boolean; play: () => void } = {
    said,
    ended: false,
    stopped: false,
    play: () => firstAudio?.(),
    say: (s) => void said.push(s),
    end() {
      out.ended = true;
      resolve();
    },
    done: new Promise<void>((r) => (resolve = r)),
    onFirstAudio: (fn) => void (firstAudio = fn),
    stop() {
      out.stopped = true;
      resolve();
    },
  };
  return out;
}

describe('SpeechStage', () => {
  it('chunks text, reports the first chunk once and flushes on end', () => {
    const out = speechOutput();
    const onFirstSpeech = vi.fn();
    const s = new SpeechStage(out, { onFirstSpeech });
    s.push('Click the button. Then ');
    expect(out.said).toEqual(['Click the button.']);
    s.push('choose PDF');
    s.end();
    expect(out.said).toEqual(['Click the button.', 'Then choose PDF']);
    expect(out.ended).toBe(true);
    expect(onFirstSpeech).toHaveBeenCalledTimes(1);
  });
});

describe('ListenStage', () => {
  it('buffers frames until STT is ready, then streams them in order', async () => {
    let onFrame!: (f: Int16Array) => void;
    const pushed: number[] = [];
    let resolveSession!: (s: SttSession) => void;
    const partials: string[] = [];
    let partialFn: ((t: string) => void) | undefined;
    const listen = new ListenStage({
      mic: {
        start: async (fn) => void (onFrame = fn),
        stop: vi.fn(),
      },
      stt: { id: 's', start: () => new Promise((r) => (resolveSession = r)) },
      signal: new AbortController().signal,
      onError: () => undefined,
      onPartial: (t) => partials.push(t),
    });
    await Promise.resolve();
    onFrame(new Int16Array([1]));
    onFrame(new Int16Array([2]));
    resolveSession({
      pushAudio: (f) => void pushed.push(f[0] ?? -1),
      finish: async () => 'done',
      onPartial: (fn) => void (partialFn = fn),
      close: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
    onFrame(new Int16Array([3]));
    partialFn?.('where is');
    expect(pushed).toEqual([1, 2, 3]);
    expect(listen.partial).toBe('where is');
    expect(partials).toEqual(['where is']);
    await expect(listen.transcript(100)).resolves.toBe('done');
  });

  it('keeps the whole recording when there is no STT service', async () => {
    let onFrame!: (f: Int16Array) => void;
    const listen = new ListenStage({
      mic: { start: async (fn) => void (onFrame = fn), stop: vi.fn() },
      stt: null,
      signal: new AbortController().signal,
      onError: () => undefined,
    });
    await Promise.resolve();
    onFrame(new Int16Array([1, 2]));
    onFrame(new Int16Array([3]));
    expect(listen.direct).toBe(true);
    expect(Array.from(listen.takeRecording())).toEqual([1, 2, 3]);
  });

  it('reports a refused STT connection as an stt failure', async () => {
    const onError = vi.fn();
    new ListenStage({
      mic: { start: async () => undefined, stop: vi.fn() },
      stt: { id: 's', start: async () => Promise.reject(new Error('401')) },
      signal: new AbortController().signal,
      onError,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'stt');
  });
});

function runInput(chat: VisionChatProvider, over: Partial<AnswerRunInput> = {}) {
  const out = speechOutput();
  const factory: SpeechFactory = { id: 'fake-voice', create: () => out };
  const hooks: AnswerRunHooks & { points: string[] } = {
    points: [],
    point: (_t, label) => void hooks.points.push(label),
    firstAudio: vi.fn(),
    speechFailed: vi.fn(),
  };
  const trace = new LatencyRecorder('i', () => 0);
  const input: AnswerRunInput = {
    chat,
    speech: factory,
    screens: Promise.resolve(screens),
    question: 'where?',
    history: [],
    maxTokens: 100,
    timeouts: { firstTokenMs: 1000, answerMs: 1000 },
    signal: new AbortController().signal,
    now: () => 0,
    trace,
    hooks,
    ...over,
  };
  return { input, out, hooks, trace };
}

describe('runAnswer', () => {
  it('points once, speaks the text and marks the trace', async () => {
    const { input, out, hooks, trace } = runInput(chatOf(['[POINT:640,400:Save]', 'There. ', '[POINT:1,1:Other]']));
    const result = await runAnswer(input);
    expect(result).toMatchObject({ outcome: 'answered', answer: 'There.', pointLabel: 'Save' });
    expect(hooks.points).toEqual(['Save']);
    expect(out.said).toEqual(['There.']);
    for (const m of ['captureReady', 'requestSent', 'firstToken', 'firstPoint', 'firstSpeech'] as const)
      expect(trace.get(m)).toBeDefined();
    expect(trace.summary().meta).toMatchObject({ imageBytes: 10, imageEdge: 1280 });
  });

  it('throws a typed bad-output error for an empty answer', async () => {
    const { input } = runInput(chatOf(['[POINT:none]']));
    await expect(runAnswer(input)).rejects.toMatchObject({ stage: 'answer', kind: 'bad-output', provider: 'fake' });
  });

  it('returns no-speech when the model listened and heard nothing', async () => {
    const { input } = runInput(chatOf(['']), { audio: { data: new Uint8Array(4), format: 'wav' } });
    await expect(runAnswer(input)).resolves.toMatchObject({ outcome: 'no-speech' });
  });

  it('tags a capture failure with the capture stage', async () => {
    const { input } = runInput(chatOf(['x.']), { screens: Promise.reject(new Error('protected screen')) });
    await expect(runAnswer(input)).rejects.toMatchObject({ stage: 'capture' });
  });

  it('stops the voice and returns quietly when aborted', async () => {
    const ac = new AbortController();
    const { input, out } = runInput(chatOf(['One. ', 'Two. ', 'Three.'], { delayMs: 20 }), { signal: ac.signal });
    const p = runAnswer(input);
    setTimeout(() => ac.abort(new Error('cancelled')), 5);
    await expect(p).resolves.toMatchObject({ outcome: 'answered' });
    expect(out.stopped).toBe(true);
  });
});
