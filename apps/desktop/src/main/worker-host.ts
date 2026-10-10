import { join } from 'node:path';
import { BrowserWindow, ipcMain, session } from 'electron';
import type { WorkerEvent, WorkerReply, WorkerRequest } from '../shared/worker-protocol';

type EventHandler = (e: WorkerEvent) => void;

/**
 * The hidden worker window and a promise-based request channel to it. It is created at startup
 * so the first key press doesn't pay for window creation.
 */
export class WorkerHost {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Set<EventHandler>();

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
      for (const h of this.handlers) h(event);
    });
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    // The worker may use the microphone and screen capture; every other permission is denied.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(wc === this.win?.webContents && (permission === 'media' || permission === 'display-capture'));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return wc === this.win?.webContents && (permission === 'media' || permission === 'display-capture');
    });
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
    win.webContents.on('render-process-gone', () => {
      // Fail everything in flight and recreate on next use.
      for (const p of this.pending.values()) p.reject(new Error('audio/capture worker crashed'));
      this.pending.clear();
      this.win = null;
      this.ready = null;
      if (!win.isDestroyed()) win.destroy();
    });
    this.ready = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e, code, desc) =>
        reject(new Error(`worker failed to load: ${code} ${desc}`)),
      );
    });
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/worker/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/worker/index.html'));
    }
    return this.ready;
  }

  async request<T = unknown>(req: WorkerRequest, timeoutMs = 15000): Promise<T> {
    await this.start();
    const win = this.win;
    if (!win || win.isDestroyed()) throw new Error('worker unavailable');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker ${req.op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      win.webContents.send('worker:request', id, req);
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
