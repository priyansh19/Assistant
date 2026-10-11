import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { AgentLesson } from '@clicky/core';
import { log } from './log';

const MAX = 60;

/** What worked in earlier agent runs (text only, userData/agent-lessons.json). */
export class LessonStore {
  private readonly file = join(app.getPath('userData'), 'agent-lessons.json');
  private lessons: AgentLesson[] = [];
  private readonly listeners = new Set<() => void>();

  constructor() {
    try {
      if (existsSync(this.file)) {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw))
          this.lessons = raw.filter(
            (l): l is AgentLesson =>
              typeof l === 'object' && l !== null && typeof l.goal === 'string' && Array.isArray(l.steps),
          );
      }
    } catch (e) {
      log.warn('agent-lessons.json could not be read', String(e));
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): AgentLesson[] {
    return this.lessons;
  }

  add(lesson: AgentLesson): void {
    // A newer run of the same task replaces the older one.
    this.lessons = [lesson, ...this.lessons.filter((l) => l.goal.toLowerCase() !== lesson.goal.toLowerCase())].slice(
      0,
      MAX,
    );
    try {
      writeFileSync(this.file, JSON.stringify(this.lessons, null, 1));
    } catch (e) {
      log.warn('agent-lessons.json could not be written', String(e));
    }
    for (const fn of this.listeners) fn();
  }

  // ---- notes the user asked Clicky to remember (userData/notes.json)

  private readonly notesFile = join(app.getPath('userData'), 'notes.json');
  private notesCache: string[] | null = null;

  notes(): string[] {
    if (this.notesCache) return this.notesCache;
    try {
      const raw: unknown = existsSync(this.notesFile) ? JSON.parse(readFileSync(this.notesFile, 'utf8')) : [];
      this.notesCache = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : [];
    } catch {
      this.notesCache = [];
    }
    return this.notesCache;
  }

  remember(note: string): void {
    const n = note.trim().slice(0, 300);
    if (!n) return;
    this.saveNotes([n, ...this.notes().filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, 50));
  }

  forget(index: number): void {
    this.saveNotes(this.notes().filter((_, i) => i !== index));
  }

  private saveNotes(notes: string[]): void {
    this.notesCache = notes;
    try {
      writeFileSync(this.notesFile, JSON.stringify(notes, null, 1));
    } catch (e) {
      log.warn('notes.json could not be written', String(e));
    }
    for (const fn of this.listeners) fn();
  }

  clear(): void {
    this.lessons = [];
    try {
      writeFileSync(this.file, '[]');
    } catch {
      // nothing to clear
    }
    for (const fn of this.listeners) fn();
  }
}
