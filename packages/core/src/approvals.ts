/**
 * Approvals inside one agent run. Allowing a step allows exactly that step (same action, same
 * target, same text, same window) for the rest of the run, so Clicky doesn't ask twice for the
 * same click. Nothing carries over to another run, and steps that can't be taken back (sends,
 * payments, deletes, merges, programs) are asked every time, whatever was allowed before and even
 * with Allow all on.
 */

import type { RiskLevel } from './safety/risk.js';

export class RunApprovals {
  private readonly allowed = new Set<string>();

  /** Remember that the user allowed this exact step (never for irreversible ones). */
  allow(key: string, level: RiskLevel): void {
    if (level === 'confirm') this.allowed.add(key);
  }

  /** True if this exact step was allowed earlier in the run and may run again without asking. */
  covers(key: string, level: RiskLevel): boolean {
    return level === 'confirm' && this.allowed.has(key);
  }
}

/**
 * Whether a step runs without asking. `allowAll` (the notch's Allow all, for this run) covers
 * "confirm" steps only.
 */
export function needsAsking(level: RiskLevel, key: string, approvals: RunApprovals, allowAll: boolean): boolean {
  if (level === 'safe') return false;
  if (level === 'irreversible' || level === 'forbidden') return true;
  return !(allowAll || approvals.covers(key, level));
}
