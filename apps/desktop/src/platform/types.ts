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
    /**
     * Any mouse movement, button press, wheel turn or other key press (agent mode pauses when the
     * user takes over; walkthroughs watch left clicks). Mouse positions are physical screen pixels.
     */
    onUserInput?: (e: {
      kind: 'key' | 'move' | 'click' | 'wheel';
      x?: number;
      y?: number;
      button?: 'left' | 'right' | 'middle';
    }) => void;
  }): void;
  stop(): void;
}

export interface Platform {
  readonly name: 'win32' | 'darwin' | 'linux';
  /** Hook for the hold-to-talk key chosen in settings. */
  createHoldKeyHook(key: HoldKey, dictationKey?: HoldKey | null): HoldKeyHook;
  /**
   * Record the next key combination pressed (everything held before all keys are let go): its
   * keycodes and a label like "Win + Alt". Null if nothing is pressed within the time limit.
   */
  recordKeys(timeoutMs: number): Promise<{ codes: number[]; label: string } | null>;
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
  /** Press the left button at the first point, move through the rest (interpolated), release. */
  drag(points: { x: number; y: number }[]): Promise<void>;
  /** Positive scrolls down. */
  scroll(x: number, y: number, amount: number): Promise<void>;
  type(text: string): Promise<void>;
  backspace(count: number): Promise<void>;
  /** The app in front: lower-case process name and window title. */
  foreground(): Promise<{ process: string; title: string } | null>;
  /** Where the control with this name is right now (physical px), searched near the hint point. */
  locate(name: string, x: number, y: number): Promise<{ x: number; y: number } | null>;
  /** The controls of the window in front (UI Automation), numbered, with physical-pixel bounds. */
  elements(
    max: number,
    budgetMs: number,
  ): Promise<
    { id: number; kind: string; name: string; password?: boolean; x: number; y: number; w: number; h: number }[]
  >;
  /** Act on control number id from the last elements() list; resolves to where (physical px). */
  elementAct(id: number, op: 'click' | 'double' | 'right' | 'set', text?: string): Promise<{ x: number; y: number }>;
  /** The taskbar's buttons (pinned and running apps, Start, Search) with their centres (physical px). */
  taskbar(): Promise<{ x: number; y: number; id: string; name: string }[]>;
  /** A window's frame (physical px), or null. */
  windowBox(handle: string): Promise<{ x: number; y: number; w: number; h: number } | null>;
  /** Centre of a control by kind ("edit", "button"… or "") and part of its name; handle "0" = the window in front. */
  findControl(handle: string, kind: string, part: string, budgetMs?: number): Promise<{ x: number; y: number } | null>;
  /** The focused control's box, or the window in front (physical px). */
  focusBox(): Promise<{ x: number; y: number; w: number; h: number } | null>;
  /** A browser window's tabs, in order. */
  tabs(handle: string): Promise<{ index: number; selected: boolean; x: number; y: number; title: string }[]>;
  /** Close tab number index of a window; false if it isn't there. */
  closeTab(handle: string, index: number): Promise<boolean>;
  /** A message from a browser that another agent is driving it, or null. */
  otherAgent(): Promise<{ process: string; text: string } | null>;
  /**
   * For answer pointing: the control the model named, scored by name, kind and distance from its
   * guess (physical px), searching for at most budgetMs. Null when nothing matches well enough.
   */
  snap(name: string, x: number, y: number, budgetMs: number): Promise<{ x: number; y: number } | null>;
  /** Installed apps (Start menu, including Store apps). */
  apps(): Promise<{ name: string; id: string }[]>;
  /** Launch an installed app by its id from apps(). */
  launch(id: string): Promise<void>;
  /** Open a folder in File Explorer and bring its window to the front. */
  openFolder(path: string): Promise<void>;
  /** Visible top-level windows, front first. */
  windows(): Promise<{ handle: string; title: string; process: string }[]>;
  /** The window in front, as a handle for maximizeNew. */
  foregroundHandle(): Promise<string>;
  /** Wait up to `ms` for a different window to come to the front, then maximise it. */
  maximizeNew(before: string, ms: number, procs?: string): Promise<void>;
  /** Ask a window to close, as its X button would (the app may ask to save first). */
  closeWindow(handle: string): Promise<void>;
  /** True if the keyboard layout types characters with AltGr (Right Alt). */
  usesAltGr(): Promise<boolean>;
  /** The text caret in physical screen pixels, when the app exposes it. */
  caret(): Promise<{ x: number; y: number; height: number } | null>;
  /** Press together and release in reverse, e.g. ['ctrl', 's']. 'mask' is a no-op key. */
  keys(keys: string[]): Promise<void>;
  dispose(): void;
}
