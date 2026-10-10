import { describe, expect, it } from 'vitest';
import {
  actionNameFrom,
  addHistory,
  contextTurns,
  normalizeActionName,
  parseActions,
  parseHistory,
  searchHistory,
  type HistoryEntry,
} from './history.js';

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: 'x',
  at: 0,
  question: 'q',
  answer: 'a',
  pointLabel: null,
  source: 'voice',
  outcome: 'answered',
  ...over,
});

describe('history', () => {
  it('adds newest first and caps the list', () => {
    let list: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) list = addHistory(list, entry({ id: String(i) }), 3);
    expect(list.map((e) => e.id)).toEqual(['4', '3', '2']);
  });

  it('builds recent answered turns oldest first', () => {
    const now = 1_000_000;
    const list = [
      entry({ id: 'new', at: now - 1000, question: 'q3', answer: 'a3' }),
      entry({ id: 'err', at: now - 2000, outcome: 'error', question: 'qe' }),
      entry({ id: 'mid', at: now - 3000, question: 'q2', answer: 'a2' }),
      entry({ id: 'old', at: now - 20 * 60_000, question: 'q1', answer: 'a1' }),
    ];
    expect(contextTurns(list, now)).toEqual([
      { role: 'user', text: 'q2' },
      { role: 'assistant', text: 'a2' },
      { role: 'user', text: 'q3' },
      { role: 'assistant', text: 'a3' },
    ]);
    expect(contextTurns(list, now, 10 * 60_000, 1)).toHaveLength(2);
  });

  it('ignores future-dated entries (clock changes)', () => {
    expect(contextTurns([entry({ at: 5000 })], 1000)).toEqual([]);
  });

  it('searches question, answer and label', () => {
    const list = [entry({ id: '1', question: 'Where is Export?' }), entry({ id: '2', pointLabel: 'Save button' })];
    expect(searchHistory(list, 'export').map((e) => e.id)).toEqual(['1']);
    expect(searchHistory(list, 'SAVE').map((e) => e.id)).toEqual(['2']);
    expect(searchHistory(list, '  ')).toHaveLength(2);
  });

  it('drops malformed stored entries', () => {
    expect(parseHistory([entry({}), { id: 1 }, null, 'x'])).toHaveLength(1);
    expect(parseHistory({})).toEqual([]);
  });
});

describe('actions', () => {
  it('names actions from questions', () => {
    expect(actionNameFrom('  how do I export to pdf?  ')).toBe('How do I export to pdf');
    expect(actionNameFrom('')).toBe('Untitled action');
    expect(actionNameFrom('a'.repeat(100)).length).toBeLessThanOrEqual(58);
  });

  it('falls back to the question when the name is blank', () => {
    expect(normalizeActionName('  ', 'open settings')).toBe('Open settings');
    expect(normalizeActionName(' My  action ', 'x')).toBe('My action');
  });

  it('validates stored actions', () => {
    const ok = { id: 'a', name: 'n', question: 'q', createdAt: 1, lastRunAt: null, runCount: 0 };
    expect(parseActions([ok, { ...ok, question: ' ' }, { ...ok, runCount: '1' }])).toEqual([ok]);
  });
});
