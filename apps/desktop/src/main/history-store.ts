import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import {
  addHistory,
  normalizeActionName,
  parseActions,
  parseHistory,
  percentile,
  MAX_ACTIONS,
  type HistoryEntry,
  type LatencySummary,
  type SavedAction,
} from '@clicky/core';

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export interface LatencyStats {
  count: number;
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

type Listener = () => void;

/** Text-only history, saved actions and latency log in userData. */
export class HistoryStore {
  private history: HistoryEntry[];
  private actions: SavedAction[];
  private latencies: number[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly dir = app.getPath('userData');

  constructor() {
    this.history = parseHistory(readJson(join(this.dir, 'history.json')));
    this.actions = parseActions(readJson(join(this.dir, 'actions.json')));
    this.latencies = this.loadLatencies();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  list(): HistoryEntry[] {
    return [...this.history];
  }

  add(entry: Omit<HistoryEntry, 'id' | 'at'>, remember: boolean): void {
    if (!remember) return;
    this.history = addHistory(this.history, { ...entry, id: randomUUID(), at: Date.now() });
    writeJson(join(this.dir, 'history.json'), this.history);
    this.changed();
  }

  remove(id: string): void {
    this.history = this.history.filter((e) => e.id !== id);
    writeJson(join(this.dir, 'history.json'), this.history);
    this.changed();
  }

  clear(): void {
    this.history = [];
    writeJson(join(this.dir, 'history.json'), this.history);
    this.changed();
  }

  listActions(): SavedAction[] {
    return [...this.actions];
  }

  getAction(id: string): SavedAction | undefined {
    return this.actions.find((a) => a.id === id);
  }

  saveAction(input: { id?: string; name: string; question: string }): SavedAction | { error: string } {
    const question = input.question.trim().slice(0, 1000);
    if (!question) return { error: 'An action needs a question.' };
    const name = normalizeActionName(input.name, question);
    const existing = input.id ? this.actions.find((a) => a.id === input.id) : undefined;
    let saved: SavedAction;
    if (existing) {
      saved = { ...existing, name, question };
      this.actions = this.actions.map((a) => (a.id === existing.id ? saved : a));
    } else {
      if (this.actions.length >= MAX_ACTIONS) return { error: `You can save up to ${MAX_ACTIONS} actions.` };
      saved = { id: randomUUID(), name, question, createdAt: Date.now(), lastRunAt: null, runCount: 0 };
      this.actions = [saved, ...this.actions];
    }
    writeJson(join(this.dir, 'actions.json'), this.actions);
    this.changed();
    return saved;
  }

  markActionRun(id: string): void {
    this.actions = this.actions.map((a) =>
      a.id === id ? { ...a, lastRunAt: Date.now(), runCount: a.runCount + 1 } : a,
    );
    writeJson(join(this.dir, 'actions.json'), this.actions);
    this.changed();
  }

  removeAction(id: string): void {
    this.actions = this.actions.filter((a) => a.id !== id);
    writeJson(join(this.dir, 'actions.json'), this.actions);
    this.changed();
  }

  /** One JSON line per interaction (plan §3.3 instrumentation). */
  logLatency(summary: LatencySummary): void {
    const file = join(this.dir, 'logs', 'latency.jsonl');
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Keep the log small: start over past 2 MB.
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // no file yet
      }
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...summary })}\n`;
      if (size > 2_000_000) writeFileSync(file, line);
      else appendFileSync(file, line);
    } catch {
      // logging must never break an interaction
    }
    if (summary.keyUpToFirstAudioMs !== null) {
      this.latencies = [...this.latencies, summary.keyUpToFirstAudioMs].slice(-50);
      this.changed();
    }
  }

  stats(): LatencyStats {
    const recent = this.latencies.slice(-20);
    return {
      count: this.history.filter((e) => e.outcome === 'answered').length,
      lastMs: this.latencies.at(-1) ?? null,
      p50Ms: percentile(recent, 50),
      p95Ms: percentile(recent, 95),
    };
  }

  private loadLatencies(): number[] {
    try {
      const lines = readFileSync(join(this.dir, 'logs', 'latency.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .slice(-50);
      return lines
        .map((l) => (JSON.parse(l) as { keyUpToFirstAudioMs?: number | null }).keyUpToFirstAudioMs)
        .filter((v): v is number => typeof v === 'number');
    } catch {
      return [];
    }
  }
}
