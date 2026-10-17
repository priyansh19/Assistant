/**
 * The run's ledger of steps that changed something outside Clicky (sent, posted, moved, deleted,
 * ran, saved). Retries and new approaches read it so they never repeat an outside action that
 * already went through; an outcome Clicky couldn't confirm is checked before trying again.
 */

import type { RiskLevel } from './risk.js';

export interface LedgerEntry {
  /** What was done, as shown to the user. */
  what: string;
  /** Same key as approvals: the exact action, target and window. */
  key: string;
  level: RiskLevel;
  /** "done": the input went through; "uncertain": it may or may not have (an error mid-way). */
  status: 'done' | 'uncertain';
  at: number;
}

export class ActionLedger {
  readonly entries: LedgerEntry[] = [];

  record(entry: LedgerEntry): void {
    if (entry.level === 'safe') return;
    this.entries.push(entry);
  }

  /** The same outside action already went through (or may have) in this run. */
  find(key: string): LedgerEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  /** The prompt block: what not to repeat. Empty when nothing outside changed yet. */
  text(): string {
    if (!this.entries.length) return '';
    return `Outside actions already done in this run (never repeat them; if one is marked "may have happened", check the screen to see whether it did before doing anything about it):\n${this.entries
      .map((e) => `- ${e.what}${e.status === 'uncertain' ? ' (may have happened)' : ''}`)
      .join('\n')}`;
  }
}
