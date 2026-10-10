/**
 * Speech output for one interaction: sentences go in as soon as they're ready, audio comes out
 * as soon as the first sentence is synthesised (plan §3.3). Cloud TTS and the offline system
 * voice both sit behind `SpeechOutput`, so the orchestrator doesn't care which is used.
 */

import type { TtsAudioChunk, TtsProvider } from './providers.js';

export interface SpeechOutput {
  /** Queue a sentence to be spoken after the ones before it. */
  say(sentence: string): void;
  /** No more sentences are coming. */
  end(): void;
  /** Resolves when everything queued has finished playing; rejects if speech failed. */
  readonly done: Promise<void>;
  /** Called once, when the first audio actually starts playing. */
  onFirstAudio(fn: () => void): void;
  /** Stop immediately (cancel). `done` then resolves. */
  stop(): void;
}

export interface SpeechFactory {
  create(signal: AbortSignal): SpeechOutput;
  prewarm?(signal: AbortSignal): void;
}

/** Where decoded audio chunks are played (the desktop app's audio worker). */
export interface AudioSink {
  write(chunk: TtsAudioChunk): void;
  /** No more chunks: resolves when the last one has finished playing. */
  finish(): Promise<void>;
  /** Called when the first chunk starts playing. */
  onStart(fn: () => void): void;
  stop(): void;
}

/** Wire a streaming cloud TTS provider to an audio sink. */
export function cloudSpeech(tts: TtsProvider, openSink: () => AudioSink): SpeechFactory {
  return {
    prewarm: (signal) => void tts.prewarm?.(signal).catch(() => undefined),
    create(signal) {
      const sink = openSink();
      const firstAudio: Array<() => void> = [];
      let started = false;
      sink.onStart(() => {
        if (started) return;
        started = true;
        for (const fn of firstAudio) fn();
      });
      let stopped = false;
      const sessionP = tts.start({ signal });
      const pending: string[] = [];
      let ended = false;
      // Text that arrives before the session is ready is buffered; afterwards it goes straight in.
      let live: { pushText(t: string): void; end(): void } | null = null;

      const done = (async () => {
        const session = await sessionP;
        live = session;
        try {
          for (const s of pending.splice(0)) session.pushText(s);
          if (ended) session.end();
          for await (const chunk of session.audio()) {
            if (stopped || signal.aborted) break;
            sink.write(chunk);
          }
          if (!stopped && !signal.aborted) await sink.finish();
        } finally {
          session.close();
        }
      })();
      return {
        say(sentence) {
          if (stopped || ended) return;
          if (live) live.pushText(sentence);
          else pending.push(sentence);
        },
        end() {
          if (ended) return;
          ended = true;
          live?.end();
        },
        done: done.catch((e: unknown) => {
          if (stopped || signal.aborted) return;
          throw e;
        }),
        onFirstAudio(fn) {
          if (started) fn();
          else firstAudio.push(fn);
        },
        stop() {
          if (stopped) return;
          stopped = true;
          sink.stop();
        },
      };
    },
  };
}
