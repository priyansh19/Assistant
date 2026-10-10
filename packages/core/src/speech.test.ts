import { describe, expect, it } from 'vitest';
import type { TtsAudioChunk, TtsProvider, TtsSession } from './providers.js';
import { cloudSpeech, type AudioSink } from './speech.js';

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
