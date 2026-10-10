import { join } from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import type { InteractionState, MappedPoint, OverlayPort } from '@clicky/core';
import type { Platform } from '../platform';
import { IPC } from '../shared/ipc';
import type { OverlayConfig, OverlayCursor, OverlayMessage, OverlayPoint } from '../shared/overlay-protocol';

const CURSOR_INTERVAL_MS = 16;
/** Mic level updates are throttled; the waveform doesn't need more than ~30 fps. */
const LEVEL_INTERVAL_MS = 33;

/** One transparent, click-through, always-on-top window per display, running the companion cursor. */
export class OverlayManager implements OverlayPort {
  private readonly windows = new Map<number, BrowserWindow>();
  private cursorTimer: NodeJS.Timeout | null = null;
  private current: InteractionState = 'idle';
  private lastCursor = '';
  private lastLevelAt = 0;
  private rebuildTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: Platform,
    private config: OverlayConfig,
  ) {}

  start(): void {
    this.rebuild();
    screen.on('display-added', this.scheduleRebuild);
    screen.on('display-removed', this.scheduleRebuild);
    screen.on('display-metrics-changed', this.scheduleRebuild);
    this.cursorTimer = setInterval(() => this.pushCursor(), CURSOR_INTERVAL_MS);
  }

  stop(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    screen.off('display-added', this.scheduleRebuild);
    screen.off('display-removed', this.scheduleRebuild);
    screen.off('display-metrics-changed', this.scheduleRebuild);
    this.destroyAll();
  }

  setConfig(config: OverlayConfig): void {
    this.config = config;
    this.broadcast(IPC.overlayConfig, config);
  }

  // ---- OverlayPort

  state(state: InteractionState): void {
    this.current = state;
    this.broadcast(IPC.overlayState, state);
  }

  point(target: MappedPoint, label: string): void {
    // Re-read the topology: a display may have changed since the screenshot (plan Phase 3).
    const display = screen.getAllDisplays().find((d) => d.id === target.displayId);
    const win = this.windows.get(target.displayId);
    if (!display || !win || win.isDestroyed()) return;
    const p: OverlayPoint = { x: target.local.x, y: target.local.y, label };
    win.webContents.send(IPC.overlayPoint, p);
  }

  message(text: string, kind: 'error' | 'info'): void {
    const m: OverlayMessage = { text, kind };
    const win = this.windows.get(this.cursorDisplay().id);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.overlayMessage, m);
  }

  level(level: number): void {
    const now = Date.now();
    if (now - this.lastLevelAt < LEVEL_INTERVAL_MS && level > 0) return;
    this.lastLevelAt = now;
    const win = this.windows.get(this.cursorDisplay().id);
    if (win && !win.isDestroyed()) win.webContents.send(IPC.overlayLevel, level);
  }

  // ---- windows

  private cursorDisplay(): Display {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }

  /** Display events often come in bursts (docking, scaling); rebuild once they settle. */
  private readonly scheduleRebuild = (): void => {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), 250);
  };

  private rebuild(): void {
    this.destroyAll();
    for (const display of screen.getAllDisplays()) this.windows.set(display.id, this.create(display));
    this.lastCursor = '';
  }

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
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true);
    this.platform.fitOverlayToDisplay(win, bounds);
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.overlayConfig, this.config);
      win.webContents.send(IPC.overlayState, this.current);
      this.lastCursor = '';
    });
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    }
    return win;
  }

  private pushCursor(): void {
    const point = screen.getCursorScreenPoint();
    const key = `${point.x},${point.y}`;
    // Nothing moved: skip the IPC (and let idle overlays stop animating).
    if (key === this.lastCursor) return;
    this.lastCursor = key;
    const current = screen.getDisplayNearestPoint(point);
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue;
      const cursor: OverlayCursor =
        id === current.id ? { x: point.x - current.bounds.x, y: point.y - current.bounds.y } : null;
      win.webContents.send(IPC.overlayCursor, cursor);
    }
  }
}
