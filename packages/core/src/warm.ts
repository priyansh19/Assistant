/**
 * Keep the voice path warm between key presses (HeyClicky section 2.4). Without this the first
 * press after a pause pays for a TLS handshake to the answer model, a new voice socket and a new
 * speech-recognition token, all on the key-up → first audio path.
 *
 * While Clicky is in use (a press, an answer, the app starting, the PC waking) every target is
 * warmed at once and then again on its own interval, with backoff after a failure. After a quiet
 * spell the keeper lets go (aborting its signal, which closes spare sockets) unless something is
 * still busy, such as an agent task. A press always warms again on its own, so letting go only
 * costs the first press after a long break what it cost before.
 */

export interface WarmTarget {
  /** For the log: 'chat', 'voice', 'stt'. */
  name: string;
  /** How often to warm it again while in use (connections and spare sockets age out). */
  everyMs: number;
  /** Open or refresh the connection. The signal aborts when the keeper lets go. */
  warm(signal: AbortSignal): Promise<void> | void;
}

export interface WarmKeeperOptions {
  /** What to keep warm; read on every start, so it follows settings changes. */
  targets(): WarmTarget[];
  /** How long after the last use to stay warm. */
  idleMs?: number;
  now?(): number;
  log?(message: string): void;
}

/** Stay warm this long after the last use. */
export const WARM_IDLE_MS = 10 * 60_000;
/** Retry delays after a failed warm-up (then the target's own interval). */
export const WARM_BACKOFF_MS = [2000, 5000, 15_000, 60_000] as const;

export class WarmKeeper {
  private ac: AbortController | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private until = 0;
  private busyCount = 0;
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(private readonly opts: WarmKeeperOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.idleMs = opts.idleMs ?? WARM_IDLE_MS;
  }

  /** True while the keeper is holding connections open. */
  get active(): boolean {
    return this.ac !== null;
  }

  /** Clicky was used (or launched, or the PC woke): warm everything now and stay warm for a while. */
  touch(reason: string): void {
    this.until = this.now() + this.idleMs;
    if (!this.ac) this.start(reason);
  }

  /** Settings or keys changed: drop what's warm (it belongs to the old providers) and warm the new ones. */
  restart(reason: string): void {
    this.stop();
    this.touch(reason);
  }

  /** Something long-running (an agent task, a walkthrough) is going on: don't let go meanwhile. */
  busy(on: boolean): void {
    this.busyCount = Math.max(0, this.busyCount + (on ? 1 : -1));
    if (!on) this.until = Math.max(this.until, this.now() + this.idleMs);
  }

  /** Let go of everything (quit, pause, or the quiet spell ran out). */
  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ac?.abort();
    this.ac = null;
  }

  private start(reason: string): void {
    const ac = new AbortController();
    this.ac = ac;
    const targets = this.opts.targets();
    this.opts.log?.(`keeping the voice path warm (${reason}): ${targets.map((t) => t.name).join(', ') || 'nothing'}`);
    for (const t of targets) void this.run(t, ac, 0);
  }

  private schedule(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private async run(target: WarmTarget, ac: AbortController, failures: number): Promise<void> {
    if (ac.signal.aborted || this.ac !== ac) return;
    if (this.now() > this.until && this.busyCount === 0) {
      this.opts.log?.('voice path idle: letting the warm connections go');
      this.stop();
      return;
    }
    let ok = true;
    try {
      await target.warm(ac.signal);
    } catch (e) {
      ok = false;
      if (!ac.signal.aborted)
        this.opts.log?.(
          `warm-up of ${target.name} failed (${failures + 1}): ${e instanceof Error ? e.message : String(e)}`,
        );
    }
    if (ac.signal.aborted || this.ac !== ac) return;
    const next = ok
      ? target.everyMs
      : Math.min(target.everyMs, WARM_BACKOFF_MS[Math.min(failures, WARM_BACKOFF_MS.length - 1)] ?? target.everyMs);
    this.schedule(next, () => void this.run(target, ac, ok ? 0 : failures + 1));
  }
}
