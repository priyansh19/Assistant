import type { CursorColor, CursorSize, InteractionState } from '@clicky/core';

/** Cursor position in DIP relative to the overlay's display, or null when it's on another display. */
export type OverlayCursor = { x: number; y: number } | null;

export interface OverlayPoint {
  /** Target in DIP relative to this overlay's display. */
  x: number;
  y: number;
  label: string;
}

/** A drawing in DIP relative to this overlay's display (see MappedShape in @clicky/core). */
export interface OverlayDrawing {
  kind: 'box' | 'arrow' | 'circle';
  points: { x: number; y: number }[];
  r?: number;
  label: string;
}

export interface OverlayMessage {
  text: string;
  kind: 'error' | 'info';
}

export interface OverlayConfig {
  color: CursorColor;
  size: CursorSize;
  showLabels: boolean;
  /** Hold-to-talk paused from the tray: the cursor dims. */
  paused: boolean;
  /** CSS pixels per physical centimetre on this overlay's display (set per window). */
  pxPerCm?: number;
}

export type OverlayStateMsg = InteractionState;
