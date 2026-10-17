import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { BUILTIN_BRAIN, brainExitReason, brainRestartDelayMs, brainServerArgs } from '@clicky/core';
import { bundlePaths } from './bundle-paths';
import { log } from './log';

export type BrainState =
  /** This build has no built-in model (dev without `pnpm fetch-bundle`, or a non-Windows build). */
  | { status: 'absent' }
  | { status: 'off' }
  | { status: 'starting' }
  | { status: 'ready'; url: string }
  | { status: 'failed'; reason: string };

/** Loading 1.5 GB from a slow disk on first launch can take a while. */
const READY_TIMEOUT_MS = 180_000;
/** After this many crashes in a row, stop retrying until the user switches it on again. */
const MAX_FAILURES = 5;

/**
 * The built-in answer model: llama.cpp's llama-server running the bundled open-source vision model
 * on 127.0.0.1, started only while it is the chosen answer model. It speaks the OpenAI API, so the
 * engine talks to it like any other provider.
 */
export class LocalBrain {
  private state: BrainState = { status: 'off' };
  private child: ChildProcess | null = null;
  private wanted = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly exeSuffix: '.exe' | '') {
    if (!this.files()) this.state = { status: 'absent' };
  }

  get(): BrainState {
    return this.state;
  }

  /** The server's address once it answers, else ''. */
  url(): string {
    return this.state.status === 'ready' ? this.state.url : '';
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run while `on`; stop (and free its memory) otherwise. Safe to call on every settings change. */
  want(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) {
      this.failures = 0;
      void this.start();
    } else this.stop();
  }

  stop(): void {
    this.wanted = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) c.kill();
    if (this.state.status !== 'absent') this.set({ status: 'off' });
  }

  private files(): { exe: string; cwd: string; model: string; mmproj: string } | null {
    const cwd = bundlePaths.server();
    const exe = join(cwd, `llama-server${this.exeSuffix}`);
    const model = join(bundlePaths.brain(), BUILTIN_BRAIN.model);
    const mmproj = join(bundlePaths.brain(), BUILTIN_BRAIN.mmproj);
    return [exe, model, mmproj].every((f) => existsSync(f)) ? { exe, cwd, model, mmproj } : null;
  }

  private set(next: BrainState): void {
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  private async start(): Promise<void> {
    if (this.child || !this.wanted) return;
    const f = this.files();
    if (!f) return this.set({ status: 'absent' });
    this.set({ status: 'starting' });
    let port: number;
    try {
      port = await freePort();
    } catch (e) {
      return this.failed(`no free port (${String(e)})`);
    }
    if (!this.wanted || this.child) return;
    const child = spawn(f.exe, brainServerArgs({ modelPath: f.model, mmprojPath: f.mmproj, port }), {
      cwd: f.cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    let tail = '';
    child.stderr?.on('data', (b: Buffer) => {
      tail = (tail + b.toString('utf8')).slice(-4000);
    });
    child.on('error', (e) => log.warn('built-in AI could not start', e.message));
    child.on('exit', (code) => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      const reason = brainExitReason(code, tail);
      log.warn(`built-in AI stopped: ${reason}`, tail.slice(-800));
      this.failed(reason);
    });
    log.info(`built-in AI starting on port ${port}`);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (this.child === child && Date.now() < deadline) {
      // llama-server answers 503 while it loads the model, 200 once it can take questions.
      if (await healthy(url)) {
        this.failures = 0;
        log.info('built-in AI ready');
        return this.set({ status: 'ready', url });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.child === child) {
      this.child = null;
      child.kill();
      this.failed('it took too long to load');
    }
  }

  private failed(reason: string): void {
    this.failures++;
    this.set({ status: 'failed', reason });
    if (!this.wanted || this.failures >= MAX_FAILURES) return;
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null;
        void this.start();
      },
      brainRestartDelayMs(this.failures - 1),
    );
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A port nothing is listening on right now, on loopback. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}
