/**
 * Ports: what the pipeline needs from the outside world (microphone, screen capture, overlay).
 * The desktop app implements them; tests use fakes. Nothing here touches Electron or the OS.
 */

import type { CaptureGeometry, MappedPoint } from './coordinates.js';
import type { InteractionState } from './interaction.js';
import type { MappedShape } from './shapes.js';
import type { ImageInput } from './providers.js';

export interface ScreenCapture {
  /** images[i] is screen i+1 in the prompt. */
  images: ImageInput[];
  geometry: CaptureGeometry[];
  /** 1-based index of the screen with the cursor. */
  cursorScreen: number;
}

export interface CapturePort {
  /** Key down: start capturing (open the stream) so a frame is ready at key up. */
  begin(signal: AbortSignal): void;
  /** Return the latest frame(s). Must work even if `begin` wasn't called (typed questions). */
  take(signal: AbortSignal): Promise<ScreenCapture>;
}

export interface MicPort {
  /** Start the microphone; frames are 16 kHz mono PCM16. Resolves once recording has started. */
  start(onFrame: (frame: Int16Array) => void, signal: AbortSignal, onError?: (e: Error) => void): Promise<void>;
  stop(): void;
}

export interface OverlayPort {
  state(state: InteractionState): void;
  /**
   * Fly the companion to a point. `snap`: the point is the answer model's guess at a named control,
   * so the app may move it onto that control's real position (agent clicks look theirs up already).
   */
  point(target: MappedPoint, label: string, opts?: { snap?: boolean }): void;
  /** Draw an arrow, box or circle on the screen (optional UI). */
  draw?(shape: MappedShape): void;
  /** A short message near the cursor, e.g. an error the user can act on. */
  message(text: string, kind: 'error' | 'info'): void;
  /** Live caption of the answer as it streams (optional UI). */
  caption?(text: string): void;
}

/** Something agent mode or dictation does with the mouse or keyboard. Points are on a display. */
export type InputAction =
  /** `target` names what's being clicked, so the live position can be looked up at click time. */
  | { kind: 'click'; at: MappedPoint; button: 'left' | 'right'; count: 1 | 2; target?: string }
  /**
   * Open an installed app by name, a website (default browser) or a folder or file. `newTab`: never
   * reuse the tab in front (it shows an app on the never-touch list).
   */
  | { kind: 'open'; app?: string; url?: string; path?: string; newTab?: boolean }
  /** Close a top-level window by its title (the app may still ask to save). */
  | { kind: 'close'; title: string }
  /** Find a control in the window in front by name (waiting a moment for it), then click it or put text in it. */
  | { kind: 'control'; name: string; controlKind?: string; op: 'click' | 'double' | 'right' | 'set'; text?: string }
  /** Close a browser tab by (part of) its title, in the window whose title matches `window` (or the one in front). */
  | { kind: 'closeTab'; window: string; tab: string }
  /** Act on control number `id` from the last list of controls (click it, or set its text). */
  | { kind: 'element'; id: number; op: 'click' | 'double' | 'right' | 'set'; text?: string }
  | { kind: 'scroll'; at: MappedPoint; /** Wheel notches; positive scrolls down. */ amount: number }
  /** Hold the left button and move through these points, then let go (drawing in Paint, sliders). */
  | { kind: 'drag'; path: MappedPoint[] }
  | { kind: 'type'; text: string }
  /** Delete this many characters before the text cursor (undo of a write). */
  | { kind: 'backspace'; count: number }
  /** A key or shortcut, e.g. ['ctrl', 's'] or ['enter']. */
  | { kind: 'keys'; keys: string[] };

export interface InputPort {
  /** Resolves when the OS has received the input. */
  run(action: InputAction, signal: AbortSignal): Promise<void>;
}
