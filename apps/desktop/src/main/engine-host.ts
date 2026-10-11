import { join } from 'node:path';
import { MessageChannelMain, utilityProcess, type UtilityProcess } from 'electron';
import { Engine } from '../engine/engine';
import type { EngineToMain, MainToEngine } from '../shared/engine-protocol';
import type { Platform } from '../platform';
import { log } from './log';
import type { WorkerHost } from './worker-host';

/** The engine must say it's ready within this long, or Clicky falls back to running it in main. */
const READY_TIMEOUT_MS = 5000;
/** More crashes than this within the window and the engine moves into main for the session. */
const MAX_CRASHES = 2;
const CRASH_WINDOW_MS = 60_000;

type Listener = (msg: EngineToMain) => void;

/**
 * Starts and supervises the engine (architecture §4). Normally it runs in a utilityProcess with a
 * direct MessagePort to the media renderer, so main is off the audio and key paths. If that
 * process can't start or keeps crashing, or CLICKY_ENGINE=inproc is set, the same Engine runs in
 * main over the existing worker channel, so Clicky keeps working either way.
 */
export class EngineHost {
  private child: UtilityProcess | null = null;
  private inproc: Engine | null = null;
  private readonly listeners = new Set<Listener>();
  /** Re-sent to a restarted engine so it picks up where the old one was. */
  private readonly replay = new Map<string, MainToEngine>();
  /** One-off commands sent while the engine is starting, delivered once it's ready. */
  private queued: MainToEngine[] = [];
  private crashes: number[] = [];
  private stopping = false;
  mode: 'process' | 'inproc' | 'starting' = 'starting';

  constructor(
    private readonly platform: Platform,
    private readonly worker: WorkerHost,
  ) {}

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: EngineToMain): void {
    for (const fn of this.listeners) fn(msg);
  }

  start(): void {
    if (process.env['CLICKY_ENGINE'] === 'inproc') return this.fallback('CLICKY_ENGINE=inproc');
    this.spawn();
  }

  private spawn(): void {
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(join(__dirname, 'engine.js'), [], {
        serviceName: 'Clicky engine',
        env: { ...process.env },
      });
    } catch (e) {
      return this.fallback(`could not start the engine process: ${String(e)}`);
    }
    this.child = child;
    this.mode = 'starting';
    const readyTimer = setTimeout(() => {
      if (this.child === child && this.mode === 'starting') {
        child.kill();
        this.fallback('the engine process did not start in time');
      }
    }, READY_TIMEOUT_MS);
    child.on('message', (msg: EngineToMain) => {
      if (this.child !== child) return;
      if (msg.type === 'ready') {
        clearTimeout(readyTimer);
        this.mode = 'process';
        log.info(`engine running in its own process (pid ${child.pid ?? '?'})`);
        this.connectMedia();
        for (const m of this.replay.values()) child.postMessage(m);
        for (const m of this.queued.splice(0)) child.postMessage(m);
      }
      this.emit(msg);
    });
    child.on('exit', (code) => {
      clearTimeout(readyTimer);
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) return;
      log.warn(`engine process exited (code ${code})`);
      // Stop the mic and any playback the dead engine owned.
      this.worker.send({ op: 'engine.detached' });
      // Whatever was in flight is lost: tell main's listeners so nothing waits forever.
      this.emit({ type: 'state', state: 'error', interactionId: null });
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES) this.fallback('the engine process keeps crashing');
      else this.spawn();
    });
  }

  /** Give the engine and the media renderer a direct port to each other. */
  connectMedia(): void {
    const child = this.child;
    if (!child || this.mode !== 'process') return;
    const { port1, port2 } = new MessageChannelMain();
    this.worker.attachEnginePort(port1);
    child.postMessage({ type: 'media.port' }, [port2]);
  }

  /** The media renderer died: the engine fails what it had in flight; a new port follows on restart. */
  mediaCrashed(): void {
    this.send({ type: 'media.crashed' });
  }

  private fallback(reason: string): void {
    if (this.inproc) return;
    log.warn(`running the engine inside the main process: ${reason}`);
    this.mode = 'inproc';
    this.child = null;
    this.inproc = new Engine({
      post: (msg) => this.emit(msg),
      media: this.worker,
      createHoldKeyHook: (key, dictationKey) => this.platform.createHoldKeyHook(key, dictationKey),
      recordKeys: (ms) => this.platform.recordKeys(ms),
    });
    for (const m of this.replay.values()) this.inproc.handle(m);
    for (const m of this.queued.splice(0)) this.inproc.handle(m);
  }

  send(msg: MainToEngine): void {
    // Remember the latest of each standing instruction for a restarted engine.
    if (msg.type === 'config') this.replay.set('config', msg);
    else if (msg.type === 'holdKey.start' || msg.type === 'holdKey.stop') this.replay.set('holdKey', msg);
    else if (msg.type === 'keyTest') this.replay.set('keyTest', msg);
    if (this.inproc) return this.inproc.handle(msg);
    if (this.child && this.mode === 'process') return this.child.postMessage(msg);
    // Starting (or restarting): standing instructions are already in `replay`; queue the rest.
    if (msg.type !== 'config' && msg.type !== 'holdKey.start' && msg.type !== 'holdKey.stop' && msg.type !== 'keyTest')
      this.queued.push(msg);
  }

  stop(): void {
    this.stopping = true;
    this.send({ type: 'shutdown' });
    const child = this.child;
    if (child) setTimeout(() => child.kill(), 300);
  }
}
