import { describe, expect, it } from 'vitest';
import { afterBeat, allBeatLines, BEAT_LINES, BeatPicker, MAX_BEAT_WORDS, speakBeat } from './beat.js';
import type { TtsAudioChunk, TtsProvider, TtsSession } from './providers.js';
import { cloudSpeech, hedgedSpeech, type AudioSink, type SpeechFactory, type SpeechOutput } from './speech.js';

function fakeTts(): TtsProvider & { starts: number; texts: string[] } {
  const tts = {
    id: 'fake',
    starts: 0,
    texts: [] as string[],
    async start(): Promise<TtsSession> {
      tts.starts++;
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | null = null;
      return {
        pushText(t) {
          tts.texts.push(t);
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
    },
  };
  return tts;
}

function fakeSink(log: string[]): AudioSink {
  let start: (() => void) | null = null;
  return {
    write(c) {
      log.push(new TextDecoder().decode(c.data));
      start?.();
      start = null;
    },
    finish: async () => undefined,
    onStart(fn) {
      start = fn;
    },
    stop: () => undefined,
  };
}

describe('beat lines', () => {
  it('are all five words or fewer', () => {
    for (const line of allBeatLines()) expect(line.split(/\s+/).length).toBeLessThanOrEqual(MAX_BEAT_WORDS);
  });

  it('rotate and never repeat the previous line back to back', () => {
    const p = new BeatPicker();
    const seen = Array.from({ length: 7 }, () => p.pick('task'));
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    expect(new Set(seen).size).toBe(BEAT_LINES.task.length);
  });
});

describe('pre-rendered beats', () => {
  it('render once at idle, then play from memory with no new voice request', async () => {
    const tts = fakeTts();
    const played: string[] = [];
    const speech = cloudSpeech(tts, () => fakeSink(played));
    await speech.prerender?.(['On it.', 'Let me think.'], new AbortController().signal);
    expect(tts.starts).toBe(2);
    let first = 0;
    await speakBeat(speech, 'On it.', new AbortController().signal, () => first++);
    expect(tts.starts).toBe(2);
    expect(played).toEqual(['On it.']);
    expect(first).toBe(1);
  });

  it('synthesise live when a line was not rendered', async () => {
    const tts = fakeTts();
    const played: string[] = [];
    await speakBeat(
      cloudSpeech(tts, () => fakeSink(played)),
      'Okay, one sec.',
      new AbortController().signal,
    );
    expect(tts.starts).toBe(1);
    expect(played).toEqual(['Okay, one sec.']);
  });

  it('pass through a backup-voice wrapper', async () => {
    const tts = fakeTts();
    const played: string[] = [];
    const primary = cloudSpeech(tts, () => fakeSink(played));
    const backup: SpeechFactory = { create: () => primary.create(new AbortController().signal) };
    const hedged = hedgedSpeech(primary, backup);
    await hedged.prerender?.(['On it.'], new AbortController().signal);
    await speakBeat(hedged, 'On it.', new AbortController().signal);
    expect(tts.starts).toBe(1);
    expect(played).toEqual(['On it.']);
  });
});

describe('speakBeat', () => {
  it('never throws or hangs when the voice fails', async () => {
    const broken: SpeechFactory = {
      create(): SpeechOutput {
        return {
          say: () => undefined,
          end: () => undefined,
          done: Promise.reject(new Error('no audio device')),
          onFirstAudio: () => undefined,
          stop: () => undefined,
        };
      },
    };
    await expect(speakBeat(broken, 'On it.', new AbortController().signal)).resolves.toBeUndefined();
    const throwing: SpeechFactory = {
      create() {
        throw new Error('no voice configured');
      },
    };
    await expect(speakBeat(throwing, 'On it.', new AbortController().signal)).resolves.toBeUndefined();
  });
});

describe('afterBeat', () => {
  it('holds the answer until the beat has finished, so they never overlap', async () => {
    const tts = fakeTts();
    const played: string[] = [];
    let finishBeat!: () => void;
    const beat = new Promise<void>((r) => (finishBeat = r));
    const out = afterBeat(
      cloudSpeech(tts, () => fakeSink(played)),
      beat,
    ).create(new AbortController().signal);
    out.say('The answer.');
    out.end();
    await new Promise((r) => setTimeout(r, 5));
    expect(played).toEqual([]);
    finishBeat();
    await out.done;
    expect(played).toEqual(['The answer.']);
  });

  it('drops queued text when stopped before the beat ends', async () => {
    const tts = fakeTts();
    const played: string[] = [];
    let finishBeat!: () => void;
    const out = afterBeat(
      cloudSpeech(tts, () => fakeSink(played)),
      new Promise<void>((r) => (finishBeat = r)),
    ).create(new AbortController().signal);
    out.say('Never heard.');
    out.stop();
    finishBeat();
    await new Promise((r) => setTimeout(r, 5));
    expect(played).toEqual([]);
  });
});
