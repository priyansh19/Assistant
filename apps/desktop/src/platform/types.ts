import type { HoldKey } from '@clicky/core';
import type { BrowserWindow, Rectangle } from 'electron';

/** A global key that reports both press and release (hold-to-talk). */
export interface HoldKeyHook {
  /** `onCancel` fires on Esc, so an answer can be stopped from anywhere. */
  start(handlers: { onDown: () => void; onUp: () => void; onCancel?: () => void }): void;
  stop(): void;
}

export interface Platform {
  readonly name: 'win32' | 'darwin' | 'linux';
  /** Hook for the hold-to-talk key chosen in settings. */
  createHoldKeyHook(key: HoldKey): HoldKeyHook;
  /** Make a freshly created overlay window cover `bounds` exactly, working around OS quirks. */
  fitOverlayToDisplay(win: BrowserWindow, bounds: Rectangle): void;
  /**
   * Physical width in centimetres of each active monitor, in display order, so on-screen distances
   * can be kept physically constant. Empty when the OS can't tell.
   */
  monitorWidthsCm(): Promise<number[]>;
}
