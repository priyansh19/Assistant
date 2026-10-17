import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, net, Notification } from 'electron';
import {
  markFinished,
  markOwnerGone,
  markStarted,
  markWaitingForNetwork,
  newRoutine,
  nextRunAfter,
  planTick,
  resumeRoutine,
  routineCopy,
  routineRunPrompt,
  type Cadence,
  type Routine,
} from '@clicky/core';
import { log } from './log';
import type { TaskFinished, TaskQueue } from './task-queue';

export interface RoutineDeps {
  tasks: TaskQueue;
  /** Agent mode is set up and on. */
  agentReady(): boolean;
  /** Clicky is answering, listening or running a task. */
  busy(): boolean;
  /** The quiet gate (calls, presentations, Focus): hold background work. Owned by the safety layer. */
  quiet(): boolean;
  /** Slugs of helpers that still exist. */
  clickys(): ReadonlySet<string>;
  /** The helper's name for a routine's prompt ("Ask Pitch Lab to …"). */
  clickyName(slug: string): string | undefined;
}

const TICK_MS = 30_000;

/**
 * Routines in userData/routines.json, and the scheduler that runs them through the background task
 * queue (one at a time, only while the user is away from the mouse, since Clicky works on the
 * real screen). The decisions are core's `planTick`; this file only supplies the clock, the
 * network and the queue.
 */
export class RoutineStore {
  private readonly file = join(app.getPath('userData'), 'routines.json');
  private routines: Routine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: RoutineDeps) {
    try {
      if (existsSync(this.file)) {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw))
          this.routines = raw.filter(
            (r): r is Routine =>
              typeof r === 'object' && r !== null && typeof r.id === 'string' && typeof r.task === 'string',
          );
      }
    } catch (e) {
      log.warn('routines.json could not be read', String(e));
    }
    deps.tasks.onFinished((f) => this.finished(f));
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    setTimeout(() => this.tick(), 5000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): Routine[] {
    return this.routines;
  }

  titlesByOwner(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const r of this.routines) (out[r.clickySlug ?? ''] ??= []).push(r.title);
    return out;
  }

  /**
   * A routine asked for by voice or the dashboard. When `ranNow` is set the first run is the task
   * running right now, so the schedule starts after it. A routine with the same title and owner is
   * updated instead of doubled.
   */
  create(
    input: { title: string; task: string; cadence: Cadence; owner?: string | undefined },
    ranNow: boolean,
  ): Routine {
    const now = Date.now();
    const same = this.routines.find(
      (r) => r.clickySlug === input.owner && r.title.toLowerCase() === input.title.toLowerCase(),
    );
    if (same) {
      Object.assign(same, { task: input.task, cadence: input.cadence, nextRunAt: nextRunAfter(input.cadence, now) });
      this.save();
      return same;
    }
    const r = newRoutine(
      { title: input.title, task: input.task, cadence: input.cadence, clickySlug: input.owner },
      now,
    );
    if (ranNow) {
      r.runCount = 1;
      r.lastRunStartedAt = now;
      r.nextRunAt = nextRunAfter(r.cadence, now);
    }
    this.routines.push(r);
    this.save();
    log.info(`routine made: ${r.title}`);
    return r;
  }

  setPaused(id: string, paused: boolean): void {
    this.update(id, (r) => (paused ? { ...r, paused: true, pausedReason: 'user' } : resumeRoutine(r, Date.now())));
  }

  runNow(id: string): void {
    this.update(id, (r) => ({ ...resumeRoutine(r, Date.now()), nextRunAt: Date.now() }));
    this.tick();
  }

  remove(id: string): void {
    this.routines = this.routines.filter((r) => r.id !== id);
    this.save();
  }

  private update(id: string, fn: (r: Routine) => Routine): void {
    this.routines = this.routines.map((r) => (r.id === id ? fn(r) : r));
    this.save();
  }

  private tick(): void {
    const decisions = planTick(this.routines, {
      now: Date.now(),
      online: net.isOnline(),
      busy: this.deps.busy() || this.deps.tasks.current !== null,
      quiet: this.deps.quiet(),
      agentReady: this.deps.agentReady(),
      clickys: this.deps.clickys(),
    });
    for (const d of decisions) {
      if (d.kind === 'pause-owner-gone') {
        this.update(d.routine.id, markOwnerGone);
        this.notify(routineCopy.ownerGone(d.routine.title));
      } else if (d.kind === 'wait-network') {
        this.update(d.routine.id, (r) => markWaitingForNetwork(r, Date.now()));
        if (d.firstTime) this.notify(routineCopy.offline(d.routine.title));
      } else if (d.kind === 'run') {
        const r = d.routine;
        const name = r.clickySlug ? this.deps.clickyName(r.clickySlug) : undefined;
        const when = (ms: number): string => new Date(ms).toLocaleString();
        const prompt = routineRunPrompt(r, when);
        const queued = this.deps.tasks.add(name ? `ask ${name} to ${prompt}` : prompt, {
          routineId: r.id,
          label: `${r.title} (routine)`,
        });
        if (queued) {
          this.update(r.id, (x) => markStarted(x, Date.now()));
          log.info(`routine ${r.title} run #${r.runCount + 1} queued`);
        }
      }
    }
  }

  private finished(f: TaskFinished): void {
    const id = f.task.routineId;
    if (!id) return;
    const r = this.routines.find((x) => x.id === id);
    if (!r) return;
    const summary = f.task.summary ?? '';
    const transient =
      f.outcome !== 'answered' &&
      (!net.isOnline() || /network|offline|ENOTFOUND|fetch failed|timed out/i.test(summary));
    const next = markFinished(
      r,
      { ok: f.outcome === 'answered', stopped: f.outcome === 'cancelled', transient, summary },
      Date.now(),
    );
    this.update(id, () => next);
    if (next.paused && next.pausedReason === 'failures')
      this.notify(routineCopy.paused(next.title, next.consecutiveFailures));
  }

  private notify(body: string): void {
    log.info(`routine: ${body}`);
    if (Notification.isSupported()) new Notification({ title: 'Clicky routines', body, silent: true }).show();
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.routines, null, 1));
    } catch (e) {
      log.warn('routines.json could not be written', String(e));
    }
    for (const fn of this.listeners) fn();
  }
}
