/**
 * Interaction history ("memory") and saved actions. Text only: screenshots and audio are never
 * stored (AGENTS.md privacy rules). Pure data helpers; the desktop app persists them.
 */

import type { ChatTurn } from './providers.js';

export interface HistoryEntry {
  id: string;
  /** Epoch ms. */
  at: number;
  question: string;
  answer: string;
  /** What the cursor pointed at, if anything. */
  pointLabel: string | null;
  /** 'voice' for hold-to-talk, 'typed' from the dashboard, 'action' when replaying a saved action. */
  source: 'voice' | 'typed' | 'action';
  outcome: 'answered' | 'cancelled' | 'error';
  /** Short reason when outcome isn't 'answered'. */
  detail?: string;
  /** Headline latency for this interaction, if measured. */
  keyUpToFirstAudioMs?: number | null;
}

export interface SavedAction {
  id: string;
  name: string;
  /** The question Clicky is asked against the current screen when the action runs. */
  question: string;
  createdAt: number;
  lastRunAt: number | null;
  runCount: number;
}

export const MAX_HISTORY = 500;
export const MAX_ACTIONS = 100;

/** Add an entry, newest first, capped at `max`. */
export function addHistory(list: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_HISTORY): HistoryEntry[] {
  return [entry, ...list].slice(0, max);
}

/**
 * Turns to send as conversation context: answered entries from the last `windowMs`, oldest first,
 * at most `maxTurns` question/answer pairs. Follow-ups like "and where is the other one?" need this.
 */
export function contextTurns(
  list: readonly HistoryEntry[],
  now: number,
  windowMs = 10 * 60_000,
  maxTurns = 4,
): ChatTurn[] {
  const recent = list
    .filter((e) => e.outcome === 'answered' && e.answer.trim() !== '' && now - e.at <= windowMs && e.at <= now)
    .slice(0, maxTurns)
    .reverse();
  return recent.flatMap((e): ChatTurn[] => [
    { role: 'user', text: e.question },
    { role: 'assistant', text: e.answer },
  ]);
}

/** A readable default name for an action made from a question. */
export function actionNameFrom(question: string): string {
  const q = question
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?.!]+$/, '');
  if (!q) return 'Untitled action';
  const name = q.charAt(0).toUpperCase() + q.slice(1);
  return name.length > 60 ? `${name.slice(0, 57).trimEnd()}…` : name;
}

export function normalizeActionName(name: string, question: string): string {
  const n = name.trim().replace(/\s+/g, ' ').slice(0, 80);
  return n || actionNameFrom(question);
}

/** Case-insensitive search over question, answer and label. */
export function searchHistory(list: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((e) => [e.question, e.answer, e.pointLabel ?? ''].some((s) => s.toLowerCase().includes(q)));
}

/** Validate something read from disk. Drops malformed entries instead of failing. */
export function parseHistory(input: unknown): HistoryEntry[] {
  if (!Array.isArray(input)) return [];
  return input.filter((e): e is HistoryEntry => {
    if (typeof e !== 'object' || e === null) return false;
    const o = e as Record<string, unknown>;
    return (
      typeof o['id'] === 'string' &&
      typeof o['at'] === 'number' &&
      typeof o['question'] === 'string' &&
      typeof o['answer'] === 'string' &&
      (o['pointLabel'] === null || typeof o['pointLabel'] === 'string') &&
      (o['source'] === 'voice' || o['source'] === 'typed' || o['source'] === 'action') &&
      (o['outcome'] === 'answered' || o['outcome'] === 'cancelled' || o['outcome'] === 'error')
    );
  });
}

export function parseActions(input: unknown): SavedAction[] {
  if (!Array.isArray(input)) return [];
  return input.filter((e): e is SavedAction => {
    if (typeof e !== 'object' || e === null) return false;
    const o = e as Record<string, unknown>;
    return (
      typeof o['id'] === 'string' &&
      typeof o['name'] === 'string' &&
      typeof o['question'] === 'string' &&
      o['question'].trim() !== '' &&
      typeof o['createdAt'] === 'number' &&
      (o['lastRunAt'] === null || typeof o['lastRunAt'] === 'number') &&
      typeof o['runCount'] === 'number'
    );
  });
}
