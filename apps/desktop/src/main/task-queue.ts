import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, Notification, powerMonitor } from 'electron';
import { agentReady, isResting, type AskResult, type InteractionState, type Settings } from '@clicky/core';
import { log } from './log';

export interface QueuedTask {
  id: string;
  goal: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  addedAt: number;
  endedAt?: number;
  /** What Clicky said at the end. */
  summary?: string;
}

export interface TaskQueueDeps {
  settings(): Settings;
  state(): InteractionState;
  ask(question: string): Promise<AskResult | null>;
}

/** Run a queued task only after the user has left the mouse and keyboard alone this long. */
const IDLE_S = 5;
const MAX_KEPT = 50;

/**
 * Background tasks: things for Clicky to do with the mouse and keyboard when the user steps away.
 * One runs at a time, only while the user is idle and agent mode is set up, with the task strip
 * visible and Windows notifications when a task starts, needs an OK, and finishes. Text only, stored
 * in userData/tasks.json.
 */
export class TaskQueue {
  private readonly file = join(app.getPath('userData'), 'tasks.json');
  private tasks: QueuedTask[] = [];
  private running: QueuedTask | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: TaskQueueDeps) {
    try {
      if (existsSync(this.file)) {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw))
          this.tasks = raw.filter(
            (t): t is QueuedTask => typeof t === 'object' && t !== null && typeof t.goal === 'string',
          );
      }
    } catch (e) {
      log.warn('tasks.json could not be read', String(e));
    }
    // A task that was running when Clicky closed didn't finish.
    for (const t of this.tasks) if (t.status === 'running') t.status = 'stopped';
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 2000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): QueuedTask[] {
    return this.tasks;
  }

  get current(): QueuedTask | null {
    return this.running;
  }

  add(goal: string): QueuedTask | null {
    const g = goal.trim().slice(0, 300);
    if (g.length < 3) return null;
    const t: QueuedTask = { id: `t${Date.now().toString(36)}`, goal: g, status: 'queued', addedAt: Date.now() };
    this.tasks.unshift(t);
    this.save();
    return t;
  }

  remove(id: string): void {
    if (this.running?.id === id) return; // stop it with Esc or the strip instead
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.save();
  }

  /** Run this task as soon as nothing else is happening, without waiting for idle. */
  runNow(id: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status === 'running') return;
    t.status = 'queued';
    void this.tick(true, id);
  }

  /** A risky step is waiting for the user's OK while a background task runs. */
  needsApproval(text: string): void {
    if (!this.running || !Notification.isSupported()) return;
    new Notification({
      title: 'Clicky needs your OK',
      body: `${text} Use Allow on the bar at the top of your screen, or press Esc to stop.`,
    }).show();
  }

  private async tick(force = false, onlyId?: string): Promise<void> {
    if (this.running) return;
    const s = this.deps.settings();
    if (!agentReady(s) || !isResting(this.deps.state())) return;
    const next = [...this.tasks].reverse().find((t) => t.status === 'queued' && (!onlyId || t.id === onlyId));
    if (!next) return;
    if (!force && powerMonitor.getSystemIdleTime() < IDLE_S) return;
    this.running = next;
    next.status = 'running';
    this.save();
    this.notify('Clicky is starting a task', `${next.goal}. Press Esc to stop it.`);
    log.info(`background task started: ${next.goal}`);
    let r: AskResult | null = null;
    try {
      r = await this.deps.ask(`Clickey, ${next.goal}`);
    } catch (e) {
      log.warn('background task failed', String(e));
    }
    next.status = !r ? 'failed' : r.outcome === 'answered' ? 'done' : r.outcome === 'cancelled' ? 'stopped' : 'failed';
    next.summary = (r?.answer || r?.detail || '').slice(0, 300);
    next.endedAt = Date.now();
    this.running = null;
    this.save();
    log.info(`background task ${next.status}: ${next.goal}`);
    this.notify(
      next.status === 'done' ? 'Task done' : next.status === 'stopped' ? 'Task stopped' : "Task didn't finish",
      next.summary || next.goal,
    );
  }

  private notify(title: string, body: string): void {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  }

  private save(): void {
    this.tasks = this.tasks.slice(0, MAX_KEPT);
    try {
      writeFileSync(this.file, JSON.stringify(this.tasks, null, 1));
    } catch (e) {
      log.warn('tasks.json could not be written', String(e));
    }
    for (const fn of this.listeners) fn();
  }
}
