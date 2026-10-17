import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { bundlePaths } from '../bundle-paths';
import { log } from '../log';
import { findModel } from '../../engine/local-speech/catalog';
import { ModelFiles } from '../../engine/local-speech/files';

export interface DownloadState {
  id: string;
  /** 0–1, or null while extracting. */
  progress: number | null;
  error?: string;
}

type Listener = () => void;

/**
 * Downloads, verifies and unpacks local models into `<userData>/models`. Only one download per
 * model at a time; progress is reported to listeners (the dashboard).
 */
export class ModelStore extends ModelFiles {
  private readonly downloads = new Map<string, DownloadState>();
  private readonly listeners = new Set<Listener>();

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  constructor() {
    super(join(app.getPath('userData'), 'models'), bundlePaths.models());
  }

  state(id: string): DownloadState | undefined {
    return this.downloads.get(id);
  }

  allStates(): DownloadState[] {
    return [...this.downloads.values()];
  }

  remove(id: string): void {
    const spec = findModel(id);
    if (!spec || this.downloads.get(id)?.progress !== undefined || this.isBundled(spec)) return;
    rmSync(this.dirOf(spec), { recursive: true, force: true });
    this.changed();
  }

  /** Download + verify + extract. Resolves when the model is ready; rejects with a readable error. */
  async download(id: string): Promise<void> {
    const spec = findModel(id);
    if (!spec) throw new Error('Unknown model.');
    if (this.isInstalled(spec)) return;
    const existing = this.downloads.get(id);
    if (existing && !existing.error) throw new Error('Already downloading.');
    const state: DownloadState = { id, progress: 0 };
    this.downloads.set(id, state);
    this.changed();
    mkdirSync(this.root, { recursive: true });
    const archive = join(this.root, `${spec.dir}.tar.bz2.part`);
    try {
      const res = await fetch(spec.url);
      if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || spec.sizeMb * 1e6;
      const hash = createHash('sha256');
      const file = createWriteStream(archive);
      let got = 0;
      let lastPush = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.byteLength;
        if (!file.write(value)) await new Promise<void>((r) => file.once('drain', () => r()));
        if (Date.now() - lastPush > 250) {
          lastPush = Date.now();
          state.progress = Math.min(0.99, got / total);
          this.changed();
        }
      }
      await new Promise<void>((resolve, reject) => file.end((e?: Error | null) => (e ? reject(e) : resolve())));
      const digest = hash.digest('hex');
      if (digest !== spec.sha256) throw new Error('the download was corrupted (checksum mismatch)');
      state.progress = null; // extracting
      this.changed();
      // Windows 10/11 ship bsdtar, which handles .tar.bz2.
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xjf', archive, '-C', this.root], { windowsHide: true, timeout: 10 * 60_000 }, (e) =>
          e ? reject(new Error(`could not unpack the model (${e.message})`)) : resolve(),
        );
      });
      if (!this.isInstalled(spec)) throw new Error('the model files are missing after unpacking');
      log.info(`model ${id} installed (${Math.round(statSync(archive).size / 1e6)} MB)`);
      this.downloads.delete(id);
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      log.warn(`model ${id} download failed`, state.error);
      // Only ever the user's own folder: the shipped models are read-only.
      rmSync(join(this.root, spec.dir), { recursive: true, force: true });
      throw new Error(`Couldn't download ${spec.name}: ${state.error}`, { cause: e });
    } finally {
      rmSync(archive, { force: true });
      this.changed();
    }
  }
}
