import { describe, expect, it } from 'vitest';
import { LatencyRecorder } from '../latency.js';
import { HeldTrace, normalizeQuestion, sameQuestion, SPECULATE_STABLE_MS, worthSpeculating } from './speculation.js';

describe('speculation', () => {
  it('treats casing and punctuation changes from finalisation as the same question', () => {
    expect(sameQuestion('where is the export button', 'Where is the export button?')).toBe(true);
    expect(sameQuestion("what's this", 'What’s this?')).toBe(true); // straight vs curly apostrophe
    expect(normalizeQuestion('  Hello,   WORLD! ')).toBe('hello world');
  });

  it('treats added or changed words as a different question', () => {
    expect(sameQuestion('where is the export', 'Where is the export menu?')).toBe(false);
    expect(sameQuestion('', '')).toBe(false);
  });

  it('only guesses on a stable interim transcript with a few words', () => {
    expect(worthSpeculating('where is export', SPECULATE_STABLE_MS)).toBe(true);
    expect(worthSpeculating('where is export', SPECULATE_STABLE_MS - 1)).toBe(false);
    expect(worthSpeculating('where is', 1000)).toBe(false);
    expect(worthSpeculating('', 1000)).toBe(false);
  });

  it('holds trace entries until committed, keeping their times', () => {
    let clock = 0;
    const real = new LatencyRecorder('i1', () => clock);
    real.mark('keyUp');
    const held = new HeldTrace(() => clock);
    clock = 5;
    held.mark('requestSent');
    held.setMeta('imageBytes', 10);
    expect(real.get('requestSent')).toBeUndefined();
    clock = 50;
    held.commit(real);
    expect(real.get('requestSent')).toBe(5);
    held.mark('firstToken');
    expect(real.get('firstToken')).toBe(50);
    expect(real.summary().meta).toMatchObject({ imageBytes: 10 });
  });

  it('drops a wrong guess without touching the real trace', () => {
    const real = new LatencyRecorder('i1', () => 0);
    const held = new HeldTrace(() => 3);
    held.mark('requestSent');
    held.drop();
    expect(real.get('requestSent')).toBeUndefined();
  });
});
