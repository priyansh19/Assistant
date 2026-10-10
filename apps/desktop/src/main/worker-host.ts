import { join } from 'node:path';
import { BrowserWindow, ipcMain, session } from 'electron';
import type { WorkerEvent, WorkerReply, WorkerRequest } from '../shared/worker-protocol';

type EventHandler = (e: WorkerEvent) => void;

/**
 * The hidden worker window and a promise-based request channel to it. It is created at startup
 * so the first key press doesn't pay for window creation, and recreated if it crashes.
 */
export class WorkerHost {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private loaded = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Set<EventHandler>();
  /** Called after the worker had to be recreated, e.g. to re-arm the warm microphone. */
  onRestart: (() => void) | null = null;

  constructor() {
    ipcMain.on('worker:reply', (e, reply: WorkerReply) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new Error(reply.error ?? 'worker error'));
    });
    ipcMain.on('worker:event', (e, event: WorkerEvent) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      this.emit(event);
    });
    // The worker may use the microphone and screen capture; every other permission is denied.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(wc === this.win?.webContents && (permission === 'media' || permission === 'display-capture'));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return wc === this.win?.webContents && (permission === 'media' || permission === 'display-capture');
    });
  }

  private emit(event: WorkerEvent): void {
    for (const h of this.handlers) h(event);
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/worker.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win = win;
    this.loaded = false;
    const ready = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => {
        this.loaded = true;
        resolve();
      });
      win.webContents.once('did-fail-load', (_e, code, desc) => {
        if (this.ready === ready) this.ready = null; // try again on next use
        reject(new Error(`worker failed to load: ${code} ${desc}`));
      });
      win.webContents.once('render-process-gone', () => reject(new Error('audio/capture worker crashed')));
    });
    ready.catch(() => undefined);
    this.ready = ready;
    win.webContents.on('render-process-gone', () => {
      // Fail everything in flight, tell every stream waiter, and bring a new worker up.
      for (const p of this.pending.values()) p.reject(new Error('audio/capture worker crashed'));
      this.pending.clear();
      if (this.win === win) {
        this.win = null;
        this.ready = null;
        this.loaded = false;
      }
      if (!win.isDestroyed()) win.destroy();
      this.emit({ type: 'worker.crashed' });
      setTimeout(() => {
        this.start()
          .then(() => this.onRestart?.())
          .catch(() => undefined);
      }, 500);
    });
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/worker/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/worker/index.html'));
    }
    return ready;
  }

  /** Send a request; the timeout covers starting the worker too, so nothing can wait forever. */
  request<T = unknown>(req: WorkerRequest, timeoutMs = 15000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker ${req.op} timed out`));
      }, timeoutMs);
      const fail = (e: unknown): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: fail,
      });
      const sendNow = (): void => {
        const win = this.win;
        if (!win || win.isDestroyed()) return fail(new Error('worker unavailable'));
        win.webContents.send('worker:request', id, req);
      };
      // Already loaded: send synchronously, so a key-down request isn't queued behind other work.
      if (this.loaded && this.win && !this.win.isDestroyed()) sendNow();
      else this.start().then(sendNow, fail);
    });
  }

  /** Fire-and-forget (audio chunks): errors are reported through events instead. */
  send(req: WorkerRequest): void {
    void this.request(req).catch(() => undefined);
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
