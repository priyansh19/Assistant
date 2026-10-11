/** Time budgets for pipeline stages (architecture §8.2). */

import { StageTimeoutError, type Stage } from '../errors.js';

/**
 * Settle with `p`, or reject with a StageTimeoutError after `ms`, or with the abort reason when
 * `signal` aborts first. Listeners and timers are always cleaned up.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, stage: Stage, what: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      reject(new StageTimeoutError(stage, what));
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
