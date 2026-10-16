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
  /** Called if the output gave up on its main voice and switched to a backup (see hedgedSpeech). */
  onSwitch?(fn: (reason: string) => void): void;
}

export interface SpeechFactory {
  /** Provider id for the latency trace (e.g. 'elevenlabs', 'system'). */
  readonly id?: string;
  create(signal: AbortSignal): SpeechOutput;
  prewarm?(signal: AbortSignal): void;
  /**
   * Synthesise these short lines now and keep their audio in memory, so `beat` can play them with
   * no network round trip (the "Sure, one sec." before slow work). Resolves when done; never throws.
   */
  prerender?(lines: readonly string[], signal: AbortSignal): Promise<void>;
  /** Say one short line, from pre-rendered audio when it has it. The output is already ended. */
  beat?(line: string, signal: AbortSignal): SpeechOutput;
}

/** Pre-rendered beat audio kept per voice: a few short lines, so a small cap is plenty. */
const MAX_PRERENDERED_BYTES = 2_000_000;

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
  /** Audio for short lines, rendered ahead (prerender) and played straight from memory (beat). */
  const rendered = new Map<string, TtsAudioChunk[]>();
  let renderedBytes = 0;
  const factory: SpeechFactory = {
    id: tts.id,
    prewarm: (signal) => void tts.prewarm?.(signal).catch(() => undefined),
    async prerender(lines, signal) {
      for (const line of lines) {
        if (signal.aborted || rendered.has(line) || renderedBytes >= MAX_PRERENDERED_BYTES) continue;
        try {
          const session = await tts.start({ signal });
          const chunks: TtsAudioChunk[] = [];
          let bytes = 0;
          try {
            session.pushText(line);
            session.end();
            for await (const chunk of session.audio()) {
              chunks.push(chunk);
              bytes += chunk.data.byteLength;
            }
          } finally {
            session.close();
          }
          if (bytes > 0 && !signal.aborted) {
            rendered.set(line, chunks);
            renderedBytes += bytes;
          }
        } catch {
          // a line that didn't render is synthesised live when it's needed
        }
      }
    },
    beat(line, signal) {
      const chunks = rendered.get(line);
      if (!chunks) {
        const out = factory.create(signal);
        out.say(line);
        out.end();
        return out;
      }
      const sink = openSink();
      const firstAudio: Array<() => void> = [];
      let started = false;
      sink.onStart(() => {
        if (started) return;
        started = true;
        for (const fn of firstAudio.splice(0)) fn();
      });
      const stop = (): void => sink.stop();
      signal.addEventListener('abort', stop, { once: true });
      for (const c of chunks) sink.write(c);
      const done = sink.finish().catch((e: unknown) => {
        if (!signal.aborted) throw e;
      });
      return {
        say: () => undefined,
        end: () => undefined,
        done,
        onFirstAudio(fn) {
          if (started) fn();
          else firstAudio.push(fn);
        },
        stop,
      };
    },
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
      let ended = false;
      let said = 0;
      let audioBytes = 0;
      const sessionP = tts.start({ signal });
      const pending: string[] = [];
      // Text that arrives before the session is ready is buffered; afterwards it goes straight in.
      let live: { pushText(t: string): void; end(): void; close(): void } | null = null;

      const done = (async () => {
        const session = await sessionP;
        live = session;
        if (stopped || signal.aborted) {
          session.close();
          return;
        }
        try {
          for (const s of pending.splice(0)) session.pushText(s);
          if (ended) session.end();
          for await (const chunk of session.audio()) {
            if (stopped || signal.aborted) break;
            audioBytes += chunk.data.byteLength;
            sink.write(chunk);
          }
          if (stopped || signal.aborted) return;
          // Text went in but nothing came out: the user heard silence, so this is a failure.
          if (said > 0 && audioBytes === 0) throw new Error('The voice service returned no audio.');
          await sink.finish();
        } finally {
          session.close();
        }
      })();
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        pending.length = 0;
        sink.stop();
        live?.close();
      };
      signal.addEventListener('abort', stop, { once: true });
      return {
        say(sentence) {
          if (stopped || ended || !sentence.trim()) return;
          said++;
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
        stop,
      };
    },
  };
  return factory;
}

/** How long the main voice gets to start playing after the first sentence, before the backup takes over. */
export const BACKUP_VOICE_AFTER_MS = 1200;

/**
 * A voice with a backup (architecture §7). Sentences go to `primary`; if it hasn't started playing
 * within `afterMs` of the first sentence, or fails before it starts, it is stopped and everything
 * said so far goes to `backup` instead. Once the primary has started playing it is never switched,
 * so the user never hears a sentence twice.
 */
export function hedgedSpeech(
  primary: SpeechFactory,
  backup: SpeechFactory,
  afterMs = BACKUP_VOICE_AFTER_MS,
): SpeechFactory {
  return {
    ...(primary.id ? { id: primary.id } : {}),
    prewarm(signal) {
      primary.prewarm?.(signal);
      backup.prewarm?.(signal);
    },
    // Beats come from the main voice's pre-rendered audio; they are too short to need a backup.
    ...(primary.prerender ? { prerender: primary.prerender.bind(primary) } : {}),
    ...(primary.beat ? { beat: primary.beat.bind(primary) } : {}),
    create(signal) {
      const primaryAc = new AbortController();
      const stopPrimary = (): void => primaryAc.abort();
      signal.addEventListener('abort', stopPrimary, { once: true });
      let active = primary.create(primaryAc.signal);
      let switched = false;
      let started = false;
      let stopped = false;
      let ended = false;
      const said: string[] = [];
      const firstAudio: Array<() => void> = [];
      const switchListeners: Array<(reason: string) => void> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;

      let settle!: { resolve: () => void; reject: (e: unknown) => void };
      const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));

      const audioStarted = (): void => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        for (const fn of firstAudio.splice(0)) fn();
      };

      const follow = (out: SpeechOutput, isBackup: boolean): void => {
        out.onFirstAudio(() => {
          if (isBackup === switched && !stopped) audioStarted();
        });
        out.done.then(
          () => {
            if (isBackup === switched) settle.resolve();
          },
          (e: unknown) => {
            if (isBackup !== switched) return;
            if (!isBackup && !started && !stopped && !signal.aborted) useBackup(`main voice failed: ${errorText(e)}`);
            else settle.reject(e);
          },
        );
      };

      const useBackup = (reason: string): void => {
        if (switched || started || stopped || signal.aborted) return;
        switched = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', stopPrimary);
        active.stop();
        primaryAc.abort();
        for (const fn of switchListeners) fn(reason);
        active = backup.create(signal);
        follow(active, true);
        for (const s of said) active.say(s);
        if (ended) active.end();
      };

      follow(active, false);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          settle.resolve();
        },
        { once: true },
      );

      return {
        say(sentence) {
          if (stopped || ended || !sentence.trim()) return;
          said.push(sentence);
          if (said.length === 1 && !switched) {
            timer = setTimeout(() => useBackup(`main voice silent after ${afterMs} ms`), afterMs);
          }
          active.say(sentence);
        },
        end() {
          if (ended) return;
          ended = true;
          active.end();
        },
        done,
        onFirstAudio(fn) {
          if (started) fn();
          else firstAudio.push(fn);
        },
        stop() {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          active.stop();
          primaryAc.abort();
          settle.resolve();
        },
        onSwitch(fn) {
          switchListeners.push(fn);
        },
      };
    },
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
