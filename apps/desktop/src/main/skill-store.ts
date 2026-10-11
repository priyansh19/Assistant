import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import {
  DEFAULT_BRIEFING,
  STARTER_SKILLS,
  learnIntoSkill,
  matchSkills,
  parseSkill,
  serializeSkill,
  type AgentLesson,
  type AgentSkill,
} from '@clicky/core';
import { log } from './log';

/**
 * The agent's own context, as Markdown files the user can open and edit:
 * userData/agents.md (the standing briefing) and userData/skills/*.md (task skills). Skills that
 * helped a run that worked get a line in their "Learned" list, so they improve with use.
 */
export class SkillStore {
  readonly dir = join(app.getPath('userData'), 'skills');
  readonly briefingFile = join(app.getPath('userData'), 'agents.md');
  private readonly listeners = new Set<() => void>();
  private cache: { skills: AgentSkill[]; briefing: string } | null = null;
  private watchers: FSWatcher[] = [];
  private debounce: NodeJS.Timeout | null = null;

  constructor() {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
        for (const s of STARTER_SKILLS) writeFileSync(this.file(s.id), serializeSkill(s));
      }
      if (!existsSync(this.briefingFile)) writeFileSync(this.briefingFile, DEFAULT_BRIEFING);
    } catch (e) {
      log.warn('skills folder could not be set up', String(e));
    }
  }

  /** Pick up hand edits to the files. */
  start(): void {
    const changed = (): void => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.changed(), 400);
    };
    try {
      this.watchers.push(watch(this.dir, changed));
      this.watchers.push(watch(this.briefingFile, changed));
    } catch (e) {
      log.warn('skills folder could not be watched', String(e));
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private file(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  private load(): { skills: AgentSkill[]; briefing: string } {
    if (this.cache) return this.cache;
    const skills: AgentSkill[] = [];
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        try {
          skills.push(parseSkill(f.slice(0, -3), readFileSync(join(this.dir, f), 'utf8')));
        } catch (e) {
          log.warn(`skill ${f} could not be read`, String(e));
        }
      }
    } catch (e) {
      log.warn('skills folder could not be read', String(e));
    }
    let briefing = '';
    try {
      briefing = readFileSync(this.briefingFile, 'utf8');
    } catch {
      // deleted by the user: no briefing
    }
    this.cache = { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), briefing };
    return this.cache;
  }

  list(): AgentSkill[] {
    return this.load().skills;
  }

  briefing(): string {
    return this.load().briefing;
  }

  /** A run worked: add it to the skills it used. */
  learn(lesson: AgentLesson): void {
    for (const s of matchSkills(lesson.goal, this.list())) {
      try {
        writeFileSync(
          this.file(s.id),
          serializeSkill(learnIntoSkill(s, lesson.goal, lesson.steps, new Date(lesson.at))),
        );
      } catch (e) {
        log.warn(`skill ${s.id} could not be updated`, String(e));
      }
    }
    this.changed();
  }

  private changed(): void {
    this.cache = null;
    for (const fn of this.listeners) fn();
  }
}
