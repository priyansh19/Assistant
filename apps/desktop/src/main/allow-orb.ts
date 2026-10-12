import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { IPC } from '../shared/ipc';
import { keepOutOfScreenshots } from './capture-privacy';

const WIDTH = 250;
const HEIGHT = 110;
/** The orb's centre sits about 1 cm in from the right edge of the screen (96 DIP per inch). */
const FROM_RIGHT = 38;

/**
 * While "Allow all" is on, a small pulsing red orb near the right edge of the screen says so.
 * Hovering it opens a little card with a button to turn Allow all off. The window lets clicks
 * through everywhere except the orb and the card.
 */
export class AllowOrb {
  private win: BrowserWindow | null = null;

  constructor(onOff: () => void) {
    // Only the orb's own window may send these.
    const mine = (e: IpcMainEvent): boolean =>
      !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.on(IPC.orbOff, (e) => mine(e) && onOff());
    ipcMain.on(IPC.orbHover, (e, on: unknown) => {
      // Catch the mouse only while it's over the orb or its card.
      if (mine(e)) this.win?.setIgnoreMouseEvents(on !== true, { forward: true });
    });
  }

  show(): void {
    const win = this.ensure();
    const d = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: Math.round(d.x + d.width - FROM_RIGHT - WIDTH + 10),
      y: Math.round(d.y + (d.height - HEIGHT) / 2),
      width: WIDTH,
      height: HEIGHT,
    });
    if (!win.isVisible()) win.showInactive();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Hide for a moment while a screenshot is taken, so the model never sees the orb. */
  hideForCapture(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setOpacity(0);
    setTimeout(() => {
      if (!win.isDestroyed() && process.env['CLICKY_HIDE_OVERLAY'] !== '1') win.setOpacity(1);
    }, 700);
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/orb.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    keepOutOfScreenshots(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    if (process.env['CLICKY_HIDE_OVERLAY'] === '1') win.setOpacity(0);
    if (process.env['ELECTRON_RENDERER_URL'])
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/orb/index.html`);
    else void win.loadFile(join(__dirname, '../renderer/orb/index.html'));
    this.win = win;
    return win;
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
