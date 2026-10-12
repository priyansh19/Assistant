import type { BrowserWindow } from 'electron';

/**
 * Clicky's own windows that screenshots should leave out (the official Clicky filters its windows
 * out of every capture). On Windows 10 2004 and later, content protection removes a window from all
 * screen capture, Clicky's included; the change applies from the next frame the desktop composes.
 */
const windows = new Set<BrowserWindow>();
let hidden = true;

export function keepOutOfScreenshots(win: BrowserWindow): void {
  windows.add(win);
  win.once('closed', () => windows.delete(win));
  win.setContentProtection(hidden);
}

export function setHideFromCapture(on: boolean): void {
  hidden = on;
  for (const w of windows) if (!w.isDestroyed()) w.setContentProtection(on);
}
