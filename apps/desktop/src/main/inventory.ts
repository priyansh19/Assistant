import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { InputDriver } from '../platform/types';
import { log } from './log';

/** Rescan this often (apps get installed, projects appear). */
const REFRESH_MS = 6 * 60 * 60_000;

/**
 * What's on this PC, so "open Grok bot" launches the installed app instead of hunting for it:
 * every Start menu app (Store apps included) and the common folders plus the folders inside them
 * (projects). Names and paths only; nothing leaves the PC except the names, sent with agent requests.
 */
export class Inventory {
  private apps: { name: string; id: string }[] = [];
  private folders: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly driver: InputDriver | null) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  view(): { apps: string[]; folders: string[] } {
    return { apps: this.apps.map((a) => a.name), folders: this.folders };
  }

  /** The installed app whose name best matches (exact, then contains, then shares a word). */
  find(name: string): { name: string; id: string } | null {
    const n = name.toLowerCase().trim();
    if (!n) return null;
    const words = n.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return (
      this.apps.find((a) => a.name.toLowerCase() === n) ??
      this.apps.find((a) => a.name.toLowerCase().includes(n) || n.includes(a.name.toLowerCase())) ??
      this.apps.find((a) =>
        words.some((w) =>
          a.name
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .includes(w),
        ),
      ) ??
      null
    );
  }

  async scan(): Promise<void> {
    try {
      if (this.driver) {
        const apps = await this.driver.apps();
        // Uninstallers and help links aren't things anyone asks to open.
        this.apps = apps.filter((a) => !/\b(uninstall|readme|help|documentation|release notes)\b/i.test(a.name));
      }
    } catch (e) {
      log.warn('app inventory scan failed', String(e));
    }
    const roots = ['desktop', 'downloads', 'documents', 'music', 'pictures', 'videos'] as const;
    const folders: string[] = [];
    for (const r of roots) {
      let base: string;
      try {
        base = app.getPath(r);
      } catch {
        continue;
      }
      folders.push(base);
      try {
        for (const f of readdirSync(base).slice(0, 200)) {
          if (f.startsWith('.')) continue;
          const full = join(base, f);
          try {
            if (statSync(full).isDirectory()) folders.push(full);
          } catch {
            // unreadable entry
          }
        }
      } catch {
        // folder missing
      }
    }
    this.folders = folders.slice(0, 120);
    log.info(`inventory: ${this.apps.length} apps, ${this.folders.length} folders`);
    for (const fn of this.listeners) fn();
  }
}
