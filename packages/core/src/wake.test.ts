import { describe, expect, it } from 'vitest';
import { agentGoal } from './agent.js';
import { bareGreeting } from './memory.js';
import { splitWake } from './wake.js';
import { planDictation } from './write.js';

describe('the name as speech recognition hears it', () => {
  it('finds the name and what follows', () => {
    expect(splitWake('Plicky, open note bed.')).toEqual({ woke: true, rest: 'open note bed.' });
    expect(splitWake('High-clicky.')).toEqual({ woke: true, rest: '' });
    expect(splitWake('Click here, open Notepad.')).toEqual({ woke: true, rest: 'open Notepad.' });
    expect(splitWake('Hey Clickey what is this')).toEqual({ woke: true, rest: 'what is this' });
    expect(splitWake('quickly open the file').woke).toBe(false);
    expect(splitWake('Where is the start button?').woke).toBe(false);
  });

  it('drives tasks, greetings and the write key', () => {
    expect(agentGoal('Plicky, open note bed.')).toBe('open note bed');
    expect(bareGreeting('High-clicky.')).toBe(true);
    const o = { hasSelection: false, last: null, now: 0 };
    expect(planDictation('High-clicky.', o)).toEqual({ kind: 'greet' });
    expect(planDictation('Right a short thank you note to Sam for the help', o).kind).toBe('write');
  });
});

describe('write key with punctuation from speech recognition', () => {
  it('reads "Right, a short note…" as a writing request', () => {
    expect(
      planDictation('Right, a short, thank you, no, to Sam for the help', { hasSelection: false, last: null, now: 0 })
        .kind,
    ).toBe('write');
  });
});

describe('write key, as speech recognition really hears "write"', () => {
  it('reads "Right a short thank you note…" as a writing request', () => {
    expect(
      planDictation('Right a short thank you no to Sam for the help.', { hasSelection: false, last: null, now: 0 })
        .kind,
    ).toBe('write');
  });
});

describe('misheard "write" is corrected in the instruction', () => {
  it('turns "Right a…" into "Write a…"', () => {
    expect(planDictation('Right a short note to Sam', { hasSelection: false, last: null, now: 0 })).toEqual({
      kind: 'write',
      instruction: 'Write a short note to Sam',
    });
  });
});

describe('splitWake keeps the request exactly as said', () => {
  it('keeps hyphens in file names and words', () => {
    expect(splitWake('Clicky, save it as clicky-shopping.txt and play lo-fi').rest).toBe(
      'save it as clicky-shopping.txt and play lo-fi',
    );
    expect(splitWake('Hi-Clicky open Notepad').rest).toBe('open Notepad');
  });
});

describe('"Clicking." before a pause is the name', () => {
  it('starts a task, but the verb alone does not', () => {
    expect(splitWake('Clicking. Open calculator, work out 18% of 2,450.').woke).toBe(true);
    expect(splitWake('clicking the save button saves it').woke).toBe(false);
  });
});
