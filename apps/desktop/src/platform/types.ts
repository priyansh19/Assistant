import type { BrowserWindow, Rectangle } from 'electron';

/** A global key that reports both press and release (hold-to-talk). */
export interface HoldKeyHook {
  start(handlers: { onDown: () => void; onUp: () => void }): void;
  stop(): void;
}

export interface Platform {
  readonly name: 'win32' | 'darwin' | 'linux';
  /** Hook for the hold-to-talk key. Key choice becomes a setting later; each OS has a sensible default. */
  createHoldKeyHook(): HoldKeyHook;
  /** Make a freshly created overlay window cover `bounds` exactly, working around OS quirks. */
  fitOverlayToDisplay(win: BrowserWindow, bounds: Rectangle): void;
}
