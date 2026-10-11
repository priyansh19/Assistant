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
