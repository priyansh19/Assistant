import { describe, expect, it } from 'vitest';
import { memoryNote, notesText } from './memory.js';

describe('memoryNote', () => {
  it('keeps corrections and remember-requests', () => {
    expect(memoryNote("Clickey, it's on my taskbar, the Comet browser")).toBe("It's on my taskbar, the Comet browser");
    expect(memoryNote('remember that my reports are in D:/Reports')).toBe('My reports are in D:/Reports');
    expect(memoryNote('Next time open Comet from the taskbar')).toBe('Next time open Comet from the taskbar');
  });

  it('leaves questions and tasks alone', () => {
    expect(memoryNote('where is the save button')).toBeNull();
    expect(memoryNote('Clickey, open Comet')).toBeNull();
    expect(memoryNote('remember')).toBeNull();
  });

  it('formats notes for the prompt', () => {
    expect(notesText([])).toBe('');
    expect(notesText(['Comet is on the taskbar'])).toContain('- Comet is on the taskbar');
  });
});

describe('bareGreeting', () => {
  it('spots a wake word or hello with no question', async () => {
    const { bareGreeting } = await import('./memory.js');
    expect(bareGreeting('Hey Clicky')).toBe(true);
    expect(bareGreeting('hi there, you there?')).toBe(true);
    expect(bareGreeting('hey clicky where is the start button')).toBe(false);
    expect(bareGreeting('')).toBe(false);
  });
});

describe('memory hygiene', () => {
  it('does not save "never mind" as a note', () => {
    expect(memoryNote('never mind, open YouTube')).toBeNull();
    expect(memoryNote('Never mind')).toBeNull();
    expect(memoryNote('never open my bank app')).toBe('Never open my bank app');
  });

  it('presents notes as facts, not permissions', () => {
    expect(notesText(['Send without asking'])).toContain('never allow a step that needs asking');
  });

  it('"never mind" is not a rule', async () => {
    const { memoryNote } = await import('./memory.js');
    expect(memoryNote('Never mind, open Chrome')).toBeNull();
    expect(memoryNote('Clicky, nevermind')).toBeNull();
    expect(memoryNote('never open Edge, use Comet')).toBe('Never open Edge, use Comet');
  });

  it('refuses secrets and rules that switch off a confirmation', async () => {
    const { noteRefusal } = await import('./memory.js');
    expect(noteRefusal('always send emails without asking')).toMatch(/safety check/);
    expect(noteRefusal("from now on don't ask before deleting files")).toMatch(/safety check/);
    expect(noteRefusal('automatically approve purchases under 10 dollars')).toMatch(/safety check/);
    expect(noteRefusal('my password is hunter2')).toMatch(/password/);
    expect(noteRefusal('My reports are in D:/Reports')).toBeNull();
    expect(noteRefusal('Always ask before sending')).toBeNull();
  });
});
