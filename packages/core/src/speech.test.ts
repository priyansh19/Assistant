import { describe, expect, it } from 'vitest';
import type { TtsAudioChunk, TtsProvider, TtsSession } from './providers.js';
import { cloudSpeech, hedgedSpeech, type AudioSink, type SpeechFactory } from './speech.js';

function fakeTts(delayStartMs = 0): TtsProvider & { texts: string[] } {
  const texts: string[] = [];
  return {
    id: 'fake',
    texts,
    async start() {
      await new Promise((r) => setTimeout(r, delayStartMs));
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | null = null;
      const session: TtsSession = {
        pushText(t) {
          texts.push(t);
          queue.push(t);
          wake?.();
        },
        end() {
          ended = true;
          wake?.();
        },
        async *audio(): AsyncIterable<TtsAudioChunk> {
          for (;;) {
            const t = queue.shift();
            if (t !== undefined) {
              yield { data: new TextEncoder().encode(t), format: 'pcm_24000' };
              continue;
            }
            if (ended) return;
            await new Promise<void>((r) => (wake = r));
          }
        },
        close: () => undefined,
      };
      return session;
    },
  };
}

function fakeSink(): AudioSink & { written: string[]; stopped: boolean } {
  let start: (() => void) | null = null;
  const sink = {
    written: [] as string[],
    stopped: false,
    write(c: TtsAudioChunk) {
      sink.written.push(new TextDecoder().decode(c.data));
      start?.();
      start = null;
    },
    finish: async () => undefined,
    onStart(fn: () => void) {
      start = fn;
    },
    stop() {
      sink.stopped = true;
    },
  };
  return sink;
}

describe('cloudSpeech', () => {
  it('plays sentences in order, including ones sent before the session was ready', async () => {
    const tts = fakeTts(5);
    const sink = fakeSink();
    const out = cloudSpeech(tts, () => sink).create(new AbortController().signal);
    let first = 0;
    out.onFirstAudio(() => first++);
    out.say('One.');
    out.say('Two.');
    await new Promise((r) => setTimeout(r, 10));
    out.say('Three.');
    out.end();
    await out.done;
    expect(sink.written).toEqual(['One.', 'Two.', 'Three.']);
    expect(first).toBe(1);
  });

  it('stop ends playback and resolves done', async () => {
    const sink = fakeSink();
    const out = cloudSpeech(fakeTts(), () => sink).create(new AbortController().signal);
    out.say('Hello.');
    out.stop();
    out.end();
    await out.done;
    expect(sink.stopped).toBe(true);
  });

  it('rejects done when TTS fails', async () => {
    const tts: TtsProvider = { id: 'bad', start: async () => Promise.reject(new Error('401')) };
    const out = cloudSpeech(tts, () => fakeSink()).create(new AbortController().signal);
    out.end();
    await expect(out.done).rejects.toThrow('401');
  });

  it('fails when text went in but no audio came out', async () => {
    const tts: TtsProvider = {
      id: 'silent',
      async start() {
        let ended = false;
        return {
          pushText: () => undefined,
          end: () => (ended = true),
          async *audio() {
            while (!ended) await new Promise((r) => setTimeout(r, 1));
          },
          close: () => undefined,
        };
      },
    };
    const out = cloudSpeech(tts, () => fakeSink()).create(new AbortController().signal);
    out.say('Hello.');
    out.end();
    await expect(out.done).rejects.toThrow(/no audio/);
  });

  it('resolves done when the interaction is aborted', async () => {
    const ac = new AbortController();
    const out = cloudSpeech(fakeTts(), () => fakeSink()).create(ac.signal);
    out.say('Hello.');
    ac.abort();
    await out.done;
  });
});

/** A voice that starts playing `startMs` after its first sentence (never if null), or fails at `failMs`. */
function fakeVoice(opts: { startMs: number | null; failMs?: number }): SpeechFactory & {
  said: string[];
  stopped: number;
} {
  const v = {
    said: [] as string[],
    stopped: 0,
    create(signal: AbortSignal) {
      let started = false;
      let ended = false;
      const first: Array<() => void> = [];
      let finish!: () => void;
      let fail!: (e: Error) => void;
      const done = new Promise<void>((res, rej) => {
        finish = res;
        fail = rej;
      });
      const maybeDone = (): void => {
        if (started && ended) setTimeout(finish, 5);
      };
      signal.addEventListener('abort', () => finish(), { once: true });
      return {
        say(t: string) {
          v.said.push(t);
          if (v.said.length !== 1) return;
          if (opts.failMs !== undefined) setTimeout(() => fail(new Error('voice down')), opts.failMs);
          if (opts.startMs !== null)
            setTimeout(() => {
              if (signal.aborted) return;
              started = true;
              for (const fn of first) fn();
              maybeDone();
            }, opts.startMs);
        },
        end() {
          ended = true;
          maybeDone();
        },
        done,
        onFirstAudio: (fn: () => void) => void first.push(fn),
        stop() {
          v.stopped++;
          finish();
        },
      };
    },
  };
  return v;
}

describe('hedgedSpeech', () => {
  it('uses the main voice when it starts in time', async () => {
    const main = fakeVoice({ startMs: 10 });
    const backup = fakeVoice({ startMs: 10 });
    const out = hedgedSpeech(main, backup, 100).create(new AbortController().signal);
    let firstAudio = 0;
    out.onFirstAudio(() => firstAudio++);
    out.say('Hello there.');
    out.end();
    await out.done;
    expect(firstAudio).toBe(1);
    expect(main.said).toEqual(['Hello there.']);
    expect(backup.said).toEqual([]);
  });

  it('switches to the backup with everything said so far when the main voice is silent', async () => {
    const main = fakeVoice({ startMs: null });
    const backup = fakeVoice({ startMs: 5 });
    const out = hedgedSpeech(main, backup, 30).create(new AbortController().signal);
    const reasons: string[] = [];
    out.onSwitch?.((r) => reasons.push(r));
    let firstAudio = 0;
    out.onFirstAudio(() => firstAudio++);
    out.say('One.');
    out.say('Two.');
    await new Promise((r) => setTimeout(r, 40));
    out.say('Three.');
    out.end();
    await out.done;
    expect(backup.said).toEqual(['One.', 'Two.', 'Three.']);
    expect(main.stopped).toBe(1);
    expect(reasons[0]).toMatch(/silent/);
    expect(firstAudio).toBe(1);
  });

  it('switches when the main voice fails before it starts', async () => {
    const main = fakeVoice({ startMs: null, failMs: 5 });
    const backup = fakeVoice({ startMs: 5 });
    const out = hedgedSpeech(main, backup, 1000).create(new AbortController().signal);
    out.say('One.');
    out.end();
    await out.done;
    expect(backup.said).toEqual(['One.']);
  });

  it('never switches once the main voice has started; a later failure is reported', async () => {
    const main = fakeVoice({ startMs: 5, failMs: 20 });
    const backup = fakeVoice({ startMs: 5 });
    const out = hedgedSpeech(main, backup, 10).create(new AbortController().signal);
    out.say('One.');
    await expect(out.done).rejects.toThrow('voice down');
    expect(backup.said).toEqual([]);
  });

  it('stops both voices on cancel', async () => {
    const main = fakeVoice({ startMs: null });
    const backup = fakeVoice({ startMs: null });
    const ac = new AbortController();
    const out = hedgedSpeech(main, backup, 10).create(ac.signal);
    out.say('One.');
    ac.abort();
    await out.done;
    await new Promise((r) => setTimeout(r, 20));
    expect(backup.said).toEqual([]);
  });
});
