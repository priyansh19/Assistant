import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '@clicky/core';

type Listener = (next: Settings, prev: Settings) => void;

/** Non-secret settings in `<userData>/settings.json`. API keys never go here. */
export class SettingsStore {
  private settings: Settings;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly file = join(app.getPath('userData'), 'settings.json')) {
    this.settings = this.load();
  }

  get(): Settings {
    return { ...this.settings };
  }

  /** Apply a partial update. Invalid fields are ignored. Returns the saved settings. */
  update(partial: unknown): Settings {
    const prev = this.settings;
    const next = normalizeSettings(partial, prev);
    this.settings = next;
    this.save();
    for (const fn of this.listeners) fn({ ...next }, { ...prev });
    return { ...next };
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private load(): Settings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.settings, null, 2));
    renameSync(tmp, this.file); // atomic replace so a crash can't leave a half-written file
  }
}
