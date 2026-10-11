/**
 * Speculative answer start (architecture §7). At key-up the interim transcript usually already
 * holds the whole question; the final one arrives a few hundred milliseconds later. The answer
 * request goes out on the interim text at once, its events are held back, and the final
 * transcript decides: same question, and the held answer is used; different, and it is aborted
 * and asked again. A wrong guess costs one discarded request, never a wrong answer.
 */

import type { LatencyMark, LatencyRecorder } from '../latency.js';
import type { Stage } from '../errors.js';

/** The interim transcript must not have changed for this long before key-up to be worth a guess. */
export const SPECULATE_STABLE_MS = 250;
/** Fewer words than this is rarely the whole question. */
export const SPECULATE_MIN_WORDS = 3;

/** Lower case, letters and digits only, single spaces: what STT finalisation tends to change. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True if the final transcript asks the same thing as the interim one the answer was started on. */
export function sameQuestion(interim: string, final: string): boolean {
  const a = normalizeQuestion(interim);
  return a.length > 0 && a === normalizeQuestion(final);
}

/** Is this interim transcript worth starting an answer on? */
export function worthSpeculating(partial: string, stableForMs: number): boolean {
  return stableForMs >= SPECULATE_STABLE_MS && normalizeQuestion(partial).split(' ').length >= SPECULATE_MIN_WORDS;
}

/** The part of the trace the answer path writes to. */
export type AnswerTrace = Pick<LatencyRecorder, 'mark' | 'setMeta' | 'event'>;

/**
 * Holds a speculative run's trace entries until the guess is confirmed, so a discarded request
 * doesn't leave its marks (request sent, first token) on the real interaction. Marks keep their
 * original times when committed.
 */
export class HeldTrace implements AnswerTrace {
  private target: AnswerTrace | null = null;
  private readonly held: Array<(t: AnswerTrace) => void> = [];

  constructor(private readonly now: () => number) {}

  mark(name: LatencyMark, at: number = this.now()): void {
    if (this.target) this.target.mark(name, at);
    else this.held.push((t) => t.mark(name, at));
  }

  setMeta(key: string, value: string | number | boolean): void {
    if (this.target) this.target.setMeta(key, value);
    else this.held.push((t) => t.setMeta(key, value));
  }

  event(stage: Stage, name: string, data?: Record<string, string | number | boolean>): void {
    if (this.target) this.target.event(stage, name, data);
    else this.held.push((t) => t.event(stage, name, data));
  }

  /** The guess was right: write everything held to the real trace, and pass later entries through. */
  commit(target: AnswerTrace): void {
    this.target = target;
    for (const fn of this.held.splice(0)) fn(target);
  }

  /** The guess was wrong: forget it. */
  drop(): void {
    this.held.length = 0;
  }
}
