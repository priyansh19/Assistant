import { join } from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import type { InteractionState } from '@clicky/core';
import type { Platform } from '../platform';
import type { OverlayCursor } from '../shared/ipc';
import { IPC } from '../shared/ipc';

const CURSOR_INTERVAL_MS = 16;

/** One transparent, click-through, always-on-top window per display. */
export class OverlayManager {
  private readonly windows = new Map<number, BrowserWindow>();
  private cursorTimer: NodeJS.Timeout | null = null;
  private state: InteractionState = 'idle';

  constructor(private readonly platform: Platform) {}

  start(): void {
    this.rebuild();
    screen.on('display-added', this.rebuild);
    screen.on('display-removed', this.rebuild);
    screen.on('display-metrics-changed', this.rebuild);
    this.cursorTimer = setInterval(() => this.pushCursor(), CURSOR_INTERVAL_MS);
  }

  stop(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    screen.off('display-added', this.rebuild);
    screen.off('display-removed', this.rebuild);
    screen.off('display-metrics-changed', this.rebuild);
    this.destroyAll();
  }

  setState(state: InteractionState): void {
    this.state = state;
    for (const win of this.windows.values()) win.webContents.send(IPC.overlayState, state);
  }

  private readonly rebuild = (): void => {
    this.destroyAll();
    for (const display of screen.getAllDisplays()) this.windows.set(display.id, this.create(display));
  };

  private destroyAll(): void {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
  }

  private create(display: Display): BrowserWindow {
    const { bounds } = display;
    const win = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    this.platform.fitOverlayToDisplay(win, bounds);
    win.webContents.once('did-finish-load', () => win.webContents.send(IPC.overlayState, this.state));
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    }
    return win;
  }

  private pushCursor(): void {
    const point = screen.getCursorScreenPoint();
    const current = screen.getDisplayNearestPoint(point);
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue;
      const cursor: OverlayCursor =
        id === current.id ? { x: point.x - current.bounds.x, y: point.y - current.bounds.y } : null;
      win.webContents.send(IPC.overlayCursor, cursor);
    }
  }
}
