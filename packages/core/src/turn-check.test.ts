import { describe, expect, it } from 'vitest';
import { checkTurn, fitTurn, TURN_RULES, wordCount } from './turn-check.js';

describe('checkTurn', () => {
  it('passes a good line', () => {
    expect(checkTurn('Nice to meet you, Sam. Hold the key whenever you want me.', TURN_RULES.hello)).toEqual([]);
  });

  it('finds each violation', () => {
    expect(checkTurn('', {})).toEqual([{ kind: 'empty' }]);
    expect(checkTurn('word '.repeat(26), { maxWords: 25 })).toEqual([{ kind: 'words', count: 26, max: 25 }]);
    expect(checkTurn('One. Two. Three.', { maxSentences: 2 })).toEqual([{ kind: 'sentences', count: 3, max: 2 }]);
    expect(checkTurn('Hi — there', { noDashes: true })).toEqual([{ kind: 'dash' }]);
    expect(checkTurn('Hi – there', { noDashes: true })).toEqual([{ kind: 'dash' }]);
    expect(checkTurn('Hi - there', { noDashes: true })).toEqual([{ kind: 'dash' }]);
    expect(checkTurn('A well-known fact', { noDashes: true })).toEqual([]);
    expect(checkTurn('Why? How?', { maxQuestions: 1 })).toEqual([{ kind: 'questions', count: 2, max: 1 }]);
    expect(checkTurn("Hi! I'm Clicky, your helper.", { noSelfIntro: true })).toEqual([{ kind: 'self-intro' }]);
    expect(checkTurn('Hi', { mustInclude: ['tray'] })).toEqual([{ kind: 'missing', text: 'tray' }]);
    expect(checkTurn('Pitch Lab is working on it', TURN_RULES.suggestion)).toEqual([
      { kind: 'forbidden', text: 'working on it' },
    ]);
  });

  it('counts words, not punctuation', () => {
    expect(wordCount('Hi , there !  3 apples')).toBe(4);
  });
});

describe('fitTurn', () => {
  it('repairs dashes, length and extra questions', () => {
    expect(
      fitTurn('Got it — you build robots. What do you build first? And why?', TURN_RULES.onboarding, 'fallback'),
    ).toBe('Got it, you build robots. What do you build first?');
    expect(fitTurn(`Short one. Long ${'long '.repeat(30)}end.`, { maxWords: 10 }, 'fallback')).toBe('Short one.');
  });

  it('falls back when it cannot be repaired', () => {
    expect(fitTurn("Hey! I'm Clicky.", TURN_RULES.hello, 'Hey there.')).toBe('Hey there.');
    expect(fitTurn('word '.repeat(40), { maxWords: 10 }, 'fallback')).toBe('fallback');
  });
});
