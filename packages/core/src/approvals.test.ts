import { describe, expect, it } from 'vitest';
import { RunApprovals, allowAllAnswers, keyMayAllow, needsAsking } from './approvals.js';

describe('RunApprovals', () => {
  it('covers only the exact step that was allowed', () => {
    const a = new RunApprovals();
    a.allow('close the window "notepad"|notepad', 'confirm');
    expect(a.covers('close the window "notepad"|notepad', 'confirm')).toBe(true);
    expect(a.covers('close the window "paint"|paint', 'confirm')).toBe(false);
  });

  it('never remembers an irreversible approval', () => {
    const a = new RunApprovals();
    a.allow('press enter|slack', 'irreversible');
    expect(a.covers('press enter|slack', 'irreversible')).toBe(false);
  });
});

describe('needsAsking', () => {
  const none = new RunApprovals();
  it('never asks for safe steps and always asks for irreversible or forbidden ones', () => {
    expect(needsAsking('safe', 'k', none, false)).toBe(false);
    expect(needsAsking('irreversible', 'k', none, true)).toBe(true);
    expect(needsAsking('forbidden', 'k', none, true)).toBe(true);
  });

  it('lets Allow all or an earlier approval cover a confirm step', () => {
    expect(needsAsking('confirm', 'k', none, false)).toBe(true);
    expect(needsAsking('confirm', 'k', none, true)).toBe(false);
    const a = new RunApprovals();
    a.allow('k', 'confirm');
    expect(needsAsking('confirm', 'k', a, false)).toBe(false);
  });
});

describe('answering a pending question', () => {
  it('lets the hold key allow only undoable steps, and not a press already on its way', () => {
    expect(keyMayAllow('confirm', 1000)).toBe(true);
    expect(keyMayAllow('confirm', 100)).toBe(false);
    expect(keyMayAllow('irreversible', 5000)).toBe(false);
  });

  it('lets Allow all answer only steps it covers', () => {
    expect(allowAllAnswers('confirm')).toBe(true);
    expect(allowAllAnswers('irreversible')).toBe(false);
  });
});
