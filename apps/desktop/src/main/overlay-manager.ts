import { join } from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import {
  drawingDemo,
  scaleShape,
  shapeOnDisplay,
  type InteractionState,
  type MappedPoint,
  type MappedShape,
  type OverlayPort,
} from '@clicky/core';
import type { Platform } from '../platform';
import { IPC } from '../shared/ipc';
import { keepOutOfScreenshots } from './capture-privacy';
import type {
  OverlayAnchor,
  OverlayConfig,
  OverlayCursor,
  OverlayDrawing,
  OverlayMessage,
  OverlayPoint,
} from '../shared/overlay-protocol';

const CURSOR_INTERVAL_MS = 16;
/** How long a display keeps the companion after a drawing starts there (it draws, then goes back). */
const DRAW_OWN_MS = 15000;
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
  /**
   * There is only ever one companion. While it points at something or sits at the text caret on one
   * display, every other display hides its follower, even if the mouse moves there.
   */
  private owner: number | null = null;
  private ownerTimer: NodeJS.Timeout | null = null;
  private anchored = false;

  constructor(
    private readonly platform: Platform,
    private config: OverlayConfig,
  ) {}

  start(): void {
    this.rebuild();
    void this.platform.monitorWidthsCm().then((w) => {
      this.widthsCm = w;
      this.setConfig(this.config);
    });
    screen.on('display-added', this.scheduleRebuild);
    screen.on('display-removed', this.scheduleRebuild);
    screen.on('display-metrics-changed', this.onMetrics);
    this.cursorTimer = setInterval(() => this.pushCursor(), CURSOR_INTERVAL_MS);
  }

  stop(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    screen.off('display-added', this.scheduleRebuild);
    screen.off('display-removed', this.scheduleRebuild);
    screen.off('display-metrics-changed', this.onMetrics);
    this.destroyAll();
  }

  setConfig(config: OverlayConfig): void {
    this.config = config;
    for (const [id, win] of this.windows)
      if (!win.isDestroyed()) win.webContents.send(IPC.overlayConfig, this.configFor(id));
  }

  /** Physical monitor widths, used to keep the companion's gap from the pointer ~1 cm on any screen. */
  private widthsCm: number[] = [];

  private configFor(displayId: number): OverlayConfig {
    const displays = screen.getAllDisplays();
    const i = displays.findIndex((d) => d.id === displayId);
    const d = displays[i];
    // Match by order when the counts agree; otherwise fall back to Windows' nominal 96 DPI.
    const cm =
      displays.length === this.widthsCm.length
        ? this.widthsCm[i]
        : displays.length === 1
          ? this.widthsCm[0]
          : undefined;
    const pxPerCm = d && cm ? d.bounds.width / cm : 96 / 2.54;
    return { ...this.config, pxPerCm, displayId };
  }

  // ---- OverlayPort

  state(state: InteractionState): void {
    this.current = state;
    this.broadcast(IPC.overlayState, state);
    // Other always-on-top windows can end up above the overlay; put it back on top while working.
    if (state === 'listening' || state === 'thinking')
      for (const win of this.windows.values())
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(true, 'screen-saver');
          win.moveTop();
        }
    // A new question: the companion comes back to the pointer (unless it's sitting at the caret).
    if (state === 'listening' && !this.anchored) this.setOwner(null);
    // Mirrors the overlay: a point is let go a few seconds after the answer ends.
    if ((state === 'idle' || state === 'cancelled' || state === 'error') && this.owner !== null && !this.anchored)
      this.setOwner(this.owner, 3500);
  }

  private setOwner(displayId: number | null, releaseAfterMs?: number): void {
    if (this.ownerTimer) clearTimeout(this.ownerTimer);
    this.ownerTimer = null;
    if (displayId !== null && releaseAfterMs !== undefined)
      this.ownerTimer = setTimeout(() => this.setOwner(null), releaseAfterMs);
    if (this.owner === displayId) return;
    this.owner = displayId;
    this.broadcast(IPC.overlayOwner, displayId);
  }

  point(target: MappedPoint, label: string): void {
    // Re-read the topology: a display may have changed since the screenshot (plan Phase 3).
    const display = screen.getAllDisplays().find((d) => d.id === target.displayId);
    const win = this.windows.get(target.displayId);
    if (!display || !win || win.isDestroyed()) return;
    const p: OverlayPoint = { x: target.local.x, y: target.local.y, label };
    // A click target takes the companion off the caret, then the pointing display owns it (≤ 12 s).
    if (this.anchored) this.anchor(null);
    this.setOwner(target.displayId, 12500);
    win.webContents.send(IPC.overlayPoint, p);
  }

  /** Sit the companion beside the text caret (write mode), or go back to following the pointer. */
  anchor(caret: { displayId: number; x: number; y: number; height: number } | null): void {
    this.anchored = caret !== null;
    this.setOwner(caret ? caret.displayId : null);
    for (const [id, win] of this.windows) {
      if (win.isDestroyed()) continue;
      const a: OverlayAnchor =
        caret && caret.displayId === id ? { x: caret.x, y: caret.y, height: caret.height } : null;
      win.webContents.send(IPC.overlayAnchor, a);
    }
  }

  draw(shape: MappedShape): void {
    const win = this.windows.get(shape.displayId);
    if (!win || win.isDestroyed()) return;
    // The companion is the pen: it moves to the display being drawn on (unless it's pointing).
    if (this.owner === null && !this.anchored) this.setOwner(shape.displayId, DRAW_OWN_MS);
    const d: OverlayDrawing = {
      kind: shape.kind,
      points: shape.points,
      label: shape.label,
      ...(shape.r !== undefined ? { r: shape.r } : {}),
    };
    win.webContents.send(IPC.overlayDraw, d);
  }

  /** The built-in drawing example, on the display with the mouse (tray: "Show me a drawing"). */
  sketch(): void {
    const d = this.cursorDisplay();
    const { width, height } = d.bounds;
    if (!this.anchored) this.setOwner(d.id, DRAW_OWN_MS);
    for (const s of drawingDemo(width / height))
      this.draw(shapeOnDisplay(scaleShape(s, width / 1000, height / 1000), d.id));
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

  /** Taskbar moves and app bars change only the work area; overlays cover full bounds, so ignore those. */
  private readonly onMetrics = (_e: unknown, _d: Display, changed: string[]): void => {
    if (changed.some((c) => c === 'bounds' || c === 'scaleFactor' || c === 'rotation')) this.scheduleRebuild();
  };

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
    keepOutOfScreenshots(win);
    win.setVisibleOnAllWorkspaces(true);
    // Smoke tests run beside the user's own Clicky: keep their overlay invisible (it still renders).
    if (process.env['CLICKY_HIDE_OVERLAY'] === '1') win.setOpacity(0);
    this.platform.fitOverlayToDisplay(win, bounds);
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.overlayConfig, this.configFor(display.id));
      win.webContents.send(IPC.overlayState, this.current);
      win.webContents.send(IPC.overlayOwner, this.owner);
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
