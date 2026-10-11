import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { mergeStyle, STYLE_CONTEXTS, type LearnedStyle, type StyleContext, type StyleObservation } from '@clicky/core';
import { log } from './log';

/** What Clicky has learned about how the user writes, in userData/style.json (text only). */
export class StyleStore {
  private readonly file = join(app.getPath('userData'), 'style.json');
  private style: LearnedStyle = {};
  private readonly listeners = new Set<() => void>();

  constructor() {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
        for (const c of STYLE_CONTEXTS) {
          const p = raw[c] as LearnedStyle[StyleContext] | undefined;
          if (p && Array.isArray(p.notes) && Array.isArray(p.examples)) this.style[c] = p;
        }
      }
    } catch (e) {
      log.warn('style.json could not be read', String(e));
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(): LearnedStyle {
    return this.style;
  }

  learn(ctx: StyleContext, obs: StyleObservation): void {
    this.style = mergeStyle(this.style, ctx, obs, Date.now());
    this.save();
  }

  /** Forget one note or example. */
  remove(ctx: StyleContext, kind: 'notes' | 'examples', index: number): void {
    const p = this.style[ctx];
    if (!p) return;
    this.style = { ...this.style, [ctx]: { ...p, [kind]: p[kind].filter((_, i) => i !== index) } };
    this.save();
  }

  clear(): void {
    this.style = {};
    this.save();
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.style, null, 1));
    } catch (e) {
      log.warn('style.json could not be written', String(e));
    }
    for (const fn of this.listeners) fn();
  }
}
