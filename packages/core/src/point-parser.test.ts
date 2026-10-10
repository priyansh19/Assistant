import { describe, expect, it } from 'vitest';
import { MAX_TAG_LENGTH, parsePointTag, PointStreamParser, type ParserEvent } from './point-parser.js';

function run(chunks: string[]): ParserEvent[] {
  const p = new PointStreamParser();
  const events = chunks.flatMap((c) => p.push(c)).concat(p.end());
  // Merge adjacent text events so assertions don't depend on chunking.
  const merged: ParserEvent[] = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (e.type === 'text' && last?.type === 'text') last.text += e.text;
    else merged.push(e.type === 'text' ? { ...e } : e);
  }
  return merged;
}

const spoken = (events: ParserEvent[]): string => events.map((e) => (e.type === 'text' ? e.text : '')).join('');

describe('parsePointTag', () => {
  it('parses all three forms', () => {
    expect(parsePointTag('[POINT:none]')).toEqual({ kind: 'none' });
    expect(parsePointTag('[POINT:120,45:Save button]')).toEqual({
      kind: 'point',
      x: 120,
      y: 45,
      label: 'Save button',
      screen: null,
    });
    expect(parsePointTag('[POINT:120,45:Save button:screen2]')).toEqual({
      kind: 'point',
      x: 120,
      y: 45,
      label: 'Save button',
      screen: 2,
    });
  });

  it('accepts a missing label, decimals and loose spacing', () => {
    expect(parsePointTag('[POINT: 1.5 , 2 ]')).toEqual({ kind: 'point', x: 1.5, y: 2, label: '', screen: null });
    expect(parsePointTag('[point:3,4:File menu : screen 1]')).toEqual({
      kind: 'point',
      x: 3,
      y: 4,
      label: 'File menu',
      screen: 1,
    });
  });

  it('keeps colons inside labels that are not a screen suffix', () => {
    expect(parsePointTag('[POINT:5,6:Time: 10:30]')).toMatchObject({ label: 'Time: 10:30', screen: null });
  });

  it('rejects malformed tags', () => {
    expect(parsePointTag('[POINT:abc]')).toBeNull();
    expect(parsePointTag('[POINT:1]')).toBeNull();
    expect(parsePointTag('[POINT:1,2:x:screen0]')).toBeNull();
    expect(parsePointTag('[POINTER:1,2]')).toBeNull();
  });
});

describe('PointStreamParser', () => {
  const answer = '[POINT:640,360:Export button:screen1]Click Export. Then pick PDF.';

  it('handles a tag at the start, whole', () => {
    const events = run([answer]);
    expect(events[0]).toEqual({
      type: 'point',
      tag: { kind: 'point', x: 640, y: 360, label: 'Export button', screen: 1 },
    });
    expect(spoken(events)).toBe('Click Export. Then pick PDF.');
  });

  it('gives the same result for every possible split point', () => {
    const expected = run([answer]);
    for (let i = 0; i <= answer.length; i++) {
      expect(run([answer.slice(0, i), answer.slice(i)])).toEqual(expected);
    }
  });

  it('gives the same result when fed one character at a time', () => {
    expect(run([...answer])).toEqual(run([answer]));
  });

  it('handles a tag at the end (original Clicky placement)', () => {
    const text = 'Use the Share menu. [POINT:10,20:Share]';
    for (let i = 0; i <= text.length; i++) {
      const events = run([text.slice(0, i), text.slice(i)]);
      expect(spoken(events)).toBe('Use the Share menu. ');
      expect(events.at(-1)).toMatchObject({ type: 'point', tag: { label: 'Share' } });
    }
  });

  it('never releases partial tag text early', () => {
    const p = new PointStreamParser();
    expect(p.push('Hi [POI')).toEqual([{ type: 'text', text: 'Hi ' }]);
    expect(p.push('NT:1,2')).toEqual([]);
    expect(p.push(':x]ok')).toEqual([
      { type: 'point', tag: { kind: 'point', x: 1, y: 2, label: 'x', screen: null } },
      { type: 'text', text: 'ok' },
    ]);
  });

  it('releases a held-back "[PO" as text when the stream ends', () => {
    expect(spoken(run(['Array index [PO']))).toBe('Array index [PO');
  });

  it('releases ordinary brackets immediately', () => {
    const p = new PointStreamParser();
    expect(p.push('see [1] and [note]')).toEqual([{ type: 'text', text: 'see [1] and [note]' }]);
  });

  it('drops invalid tags without speaking them', () => {
    const events = run(['Look here [POINT:left side] now.']);
    expect(spoken(events)).toBe('Look here  now.');
    expect(events).toContainEqual({ type: 'invalid-tag', raw: '[POINT:left side]' });
  });

  it('treats an unclosed opening as prose once it is too long or the stream ends', () => {
    const long = '[POINT:' + 'a'.repeat(MAX_TAG_LENGTH);
    expect(spoken(run([long]))).toBe(long);
    expect(spoken(run(['[POINT:1,2 then nothing']))).toBe('[POINT:1,2 then nothing');
  });

  it('reports none and several tags in order', () => {
    const events = run(['[POINT:none]Nothing to point at. [POINT:1,1:a][POINT:2,2:b]']);
    expect(events.filter((e) => e.type === 'point').map((e) => (e.type === 'point' ? e.tag.kind : ''))).toEqual([
      'none',
      'point',
      'point',
    ]);
  });
});
