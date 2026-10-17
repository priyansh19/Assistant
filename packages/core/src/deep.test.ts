import { describe, expect, it } from 'vitest';
import { wantsDeep } from './deep.js';

describe('wantsDeep', () => {
  it.each([
    'Can you think this through and tell me which plan is cheaper?',
    'Explain it step by step',
    'summarise this whole document for me',
    "What's wrong with this code?",
    'proofread my email',
    'what are the pros and cons of these two laptops',
    'review my draft please',
  ])('sends "%s" to the stronger model', (q) => expect(wantsDeep(q)).toBe(true));

  it.each([
    'where is the save button',
    'what time is it in Tokyo',
    'how do I turn on dark mode',
    'summarise this',
    'open Notepad',
    'explain this error',
  ])('keeps "%s" on the fast model (it can still say [DEEP])', (q) => expect(wantsDeep(q)).toBe(false));
});
