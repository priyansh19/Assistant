/**
 * The spoken "beat": a few words ("Sure, one sec.") played within a moment of key-up when the real
 * answer will take a while (an agent task, a hard question handed to the stronger model, a
 * drawing). HeyClicky does the same before every slow tool. The lines are pre-rendered at idle, so
 * the beat needs no network round trip, and there is at most one per question.
 */

import type { SpeechFactory, SpeechOutput } from './speech.js';

export type BeatKind = 'task' | 'deep' | 'draw';

/** Every line is five words or fewer, so it ends before the real answer is ready. */
export const BEAT_LINES: Readonly<Record<BeatKind, readonly string[]>> = {
  task: ['On it.', 'Sure, on it.', 'Okay, doing it now.'],
  deep: ['Let me think.', 'Good one, one sec.', 'Hmm, let me check.'],
  draw: ['Sure, drawing it.', 'Okay, one sec.'],
};

export const MAX_BEAT_WORDS = 5;

/** Every line, for pre-rendering. */
export function allBeatLines(): string[] {
  return [...new Set(Object.values(BEAT_LINES).flat())];
}

/** A beat that never finishes (a stuck audio device) stops holding the answer back after this long. */
export const BEAT_MAX_MS = 3000;

/** Rotates through the lines so the same words don't come back every time. */
export class BeatPicker {
  private last = '';
  private readonly next: Record<BeatKind, number> = { task: 0, deep: 0, draw: 0 };

  pick(kind: BeatKind): string {
    const lines = BEAT_LINES[kind];
    let line = lines[this.next[kind] % lines.length] ?? lines[0] ?? '';
    this.next[kind]++;
    if (line === this.last && lines.length > 1) {
      line = lines[this.next[kind] % lines.length] ?? line;
      this.next[kind]++;
    }
    this.last = line;
    return line;
  }
}

/**
 * Play a beat. Resolves when it has finished playing (or failed, or after BEAT_MAX_MS): a beat is
 * never allowed to fail or hold up the answer it introduces.
 */
export function speakBeat(
  speech: SpeechFactory,
  line: string,
  signal: AbortSignal,
  onFirstAudio?: () => void,
): Promise<void> {
  let out: SpeechOutput;
  try {
    if (speech.beat) out = speech.beat(line, signal);
    else {
      out = speech.create(signal);
      out.say(line);
      out.end();
    }
  } catch {
    return Promise.resolve();
  }
  if (onFirstAudio) out.onFirstAudio(onFirstAudio);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BEAT_MAX_MS);
  });
  return Promise.race([out.done.catch(() => undefined), capped]).finally(() => clearTimeout(timer));
}

/**
 * A voice that waits for the beat: the output is created at once (so the voice connection opens in
 * parallel), but nothing is said until the beat has finished, so the two never talk over each other.
 */
export function afterBeat(speech: SpeechFactory, beat: Promise<void>): SpeechFactory {
  return {
    ...(speech.id ? { id: speech.id } : {}),
    ...(speech.prewarm ? { prewarm: speech.prewarm.bind(speech) } : {}),
    create(signal) {
      const inner = speech.create(signal);
      let ready = false;
      const queued: string[] = [];
      let ended = false;
      let stopped = false;
      void beat.then(() => {
        ready = true;
        if (stopped) return;
        for (const s of queued.splice(0)) inner.say(s);
        if (ended) inner.end();
      });
      return {
        say(sentence) {
          if (stopped) return;
          if (ready) inner.say(sentence);
          else queued.push(sentence);
        },
        end() {
          ended = true;
          if (ready && !stopped) inner.end();
        },
        get done() {
          return inner.done;
        },
        onFirstAudio: (fn) => inner.onFirstAudio(fn),
        stop() {
          stopped = true;
          queued.length = 0;
          inner.stop();
        },
        ...(inner.onSwitch ? { onSwitch: inner.onSwitch.bind(inner) } : {}),
      };
    },
  };
}
