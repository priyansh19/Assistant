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
  point(target: MappedPoint, label: string): void;
  /** Draw an arrow, box or circle on the screen (optional UI). */
  draw?(shape: MappedShape): void;
  /** A short message near the cursor, e.g. an error the user can act on. */
  message(text: string, kind: 'error' | 'info'): void;
  /** Live caption of the answer as it streams (optional UI). */
  caption?(text: string): void;
}

/** Something agent mode or dictation does with the mouse or keyboard. Points are on a display. */
export type InputAction =
  | { kind: 'click'; at: MappedPoint; button: 'left' | 'right'; count: 1 | 2 }
  | { kind: 'scroll'; at: MappedPoint; /** Wheel notches; positive scrolls down. */ amount: number }
  | { kind: 'type'; text: string }
  /** Delete this many characters before the text cursor (undo of a write). */
  | { kind: 'backspace'; count: number }
  /** A key or shortcut, e.g. ['ctrl', 's'] or ['enter']. */
  | { kind: 'keys'; keys: string[] };

export interface InputPort {
  /** Resolves when the OS has received the input. */
  run(action: InputAction, signal: AbortSignal): Promise<void>;
}
