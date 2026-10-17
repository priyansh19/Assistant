import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import type { StripState } from '../preload/strip';
import { IPC } from '../shared/ipc';
import { keepOutOfScreenshots } from './capture-privacy';

const WIDTH = 600;
const HEIGHT = 46;

/**
 * A slim bar at the top of the screen while Clicky does a task: the goal, the current step, and
 * Pause / Stop / Allow / Allow all. It's non-focusable, so clicking it never takes focus from the app Clicky
 * is working in.
 */
export class TaskStrip {
  private win: BrowserWindow | null = null;
  private state: StripState = { goal: '', step: 0, max: 0, say: '', ask: null, paused: false, color: '#2f8cff' };
  private hideTimer: NodeJS.Timeout | null = null;

  constructor(handlers: { pause(on: boolean): void; stop(): void; allow(): void; allowAll(on: boolean): void }) {
    // Allow and Allow all let Clicky act without asking: only the strip's own window may send them.
    const mine = (e: IpcMainEvent): boolean =>
      !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.on(IPC.stripPause, (e, on: unknown) => mine(e) && handlers.pause(on === true));
    ipcMain.on(IPC.stripStop, (e) => mine(e) && handlers.stop());
    ipcMain.on(IPC.stripAllow, (e) => mine(e) && handlers.allow());
    ipcMain.on(IPC.stripAllowAll, (e, on: unknown) => mine(e) && handlers.allowAll(on === true));
  }

  update(patch: Partial<StripState>): void {
    this.state = { ...this.state, ...patch };
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    const win = this.ensure();
    if (!win.isVisible()) {
      this.place(win);
      win.showInactive();
    }
    win.webContents.send(IPC.stripState, this.state);
  }

  /** The task ended: leave the last line up briefly, then hide and reset. */
  end(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.win?.hide();
      this.state = { ...this.state, goal: '', step: 0, max: 0, say: '', ask: null, paused: false };
    }, 1500);
  }

  /** Hide for a moment while a screenshot is taken, so the model never mistakes the notch for the app. */
  hideForCapture(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setOpacity(0);
    setTimeout(() => {
      if (!win.isDestroyed() && process.env['CLICKY_HIDE_OVERLAY'] !== '1') win.setOpacity(1);
    }, 700);
  }

  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  private place(win: BrowserWindow): void {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // A notch: flush with the top edge of the screen the user is on, centred.
    const { x, y, width } = d.bounds;
    win.setBounds({ x: Math.round(x + (width - WIDTH) / 2), y, width: WIDTH, height: HEIGHT });
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/strip.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    keepOutOfScreenshots(win);
    if (process.env['CLICKY_HIDE_OVERLAY'] === '1') win.setOpacity(0); // smoke tests
    win.webContents.once('did-finish-load', () => win.webContents.send(IPC.stripState, this.state));
    if (process.env['ELECTRON_RENDERER_URL'])
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/strip/index.html`);
    else void win.loadFile(join(__dirname, '../renderer/strip/index.html'));
    this.win = win;
    return win;
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
