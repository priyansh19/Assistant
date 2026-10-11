import type { HoldKey } from '@clicky/core';
import type { BrowserWindow, Rectangle } from 'electron';

/** A global key that reports both press and release (hold-to-talk). */
export interface HoldKeyHook {
  /**
   * `onCancel` fires on Esc, so an answer can be stopped from anywhere. The dictation handlers fire
   * for the second key passed to createHoldKeyHook, if any.
   */
  start(handlers: {
    onDown: () => void;
    onUp: () => void;
    onCancel?: () => void;
    onDictateDown?: () => void;
    onDictateUp?: () => void;
  }): void;
  stop(): void;
}

export interface Platform {
  readonly name: 'win32' | 'darwin' | 'linux';
  /** Hook for the hold-to-talk key chosen in settings. */
  createHoldKeyHook(key: HoldKey, dictationKey?: HoldKey | null): HoldKeyHook;
  /** Mouse and keyboard injection; null where the OS doesn't allow it. */
  createInputDriver(): InputDriver | null;
  /** Make a freshly created overlay window cover `bounds` exactly, working around OS quirks. */
  fitOverlayToDisplay(win: BrowserWindow, bounds: Rectangle): void;
  /**
   * Physical width in centimetres of each active monitor, in display order, so on-screen distances
   * can be kept physically constant. Empty when the OS can't tell.
   */
  monitorWidthsCm(): Promise<number[]>;
}

/** Mouse and keyboard injection (agent mode, dictation). Coordinates are physical screen pixels. */
export interface InputDriver {
  /** Start the helper ahead of first use. */
  warm(): void;
  click(x: number, y: number, button: 'left' | 'right', count: 1 | 2): Promise<void>;
  /** Positive scrolls down. */
  scroll(x: number, y: number, amount: number): Promise<void>;
  type(text: string): Promise<void>;
  backspace(count: number): Promise<void>;
  /** The app in front: lower-case process name and window title. */
  foreground(): Promise<{ process: string; title: string } | null>;
  /** The text caret in physical screen pixels, when the app exposes it. */
  caret(): Promise<{ x: number; y: number; height: number } | null>;
  /** Press together and release in reverse, e.g. ['ctrl', 's']. 'mask' is a no-op key. */
  keys(keys: string[]): Promise<void>;
  dispose(): void;
}
