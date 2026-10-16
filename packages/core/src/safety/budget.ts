/**
 * Hard limits for one agent run, beyond the step ceiling: wall-clock time and model calls (each call
 * sends screenshots, so calls are the cost). At a limit the run pauses and asks the user whether
 * to keep going, instead of quietly spending more.
 */

export interface AgentBudget {
  /** Wall-clock limit for the run, in ms (default 15 minutes). */
  maxMs: number;
  /** Model calls (steps, plans, reviews, checks) before asking (default 120). */
  maxModelCalls: number;
}

export const DEFAULT_BUDGET: AgentBudget = { maxMs: 15 * 60_000, maxModelCalls: 120 };

export class BudgetMeter {
  private calls = 0;
  private readonly started: number;
  private limits: AgentBudget;

  constructor(
    budget: AgentBudget,
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...budget };
    this.started = now();
  }

  call(): void {
    this.calls++;
  }

  get modelCalls(): number {
    return this.calls;
  }

  /** The limit reached, in words for the user, or null. */
  exceeded(): string | null {
    if (this.calls >= this.limits.maxModelCalls) return `${this.calls} model calls`;
    const mins = Math.round((this.now() - this.started) / 60_000);
    if (this.now() - this.started >= this.limits.maxMs) return `${mins} minutes`;
    return null;
  }

  /** The user said keep going: give the run as much again. */
  extend(): void {
    this.limits = {
      maxMs: this.limits.maxMs + Math.max(this.now() - this.started, 60_000),
      maxModelCalls: this.limits.maxModelCalls + Math.max(this.calls, 10),
    };
  }
}
