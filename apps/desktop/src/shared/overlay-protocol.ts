import type { CursorColor, CursorSize, DrawKind, InteractionState } from '@clicky/core';

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
  kind: DrawKind;
  points: { x: number; y: number }[];
  r?: number;
  label: string;
}

/** The text caret the companion sits beside while dictating (DIP, relative to this display). */
export type OverlayAnchor = { x: number; y: number; height: number } | null;

export interface OverlayMessage {
  text: string;
  kind: 'error' | 'info';
}

export interface OverlayConfig {
  color: CursorColor;
  size: CursorSize;
  showLabels: boolean;
  /** Off: the companion only shows while Clicky is in use (it fades out when idle). */
  showCompanion: boolean;
  /** Hold-to-talk paused from the tray: the cursor dims. */
  paused: boolean;
  /** CSS pixels per physical centimetre on this overlay's display (set per window). */
  pxPerCm?: number;
  /** This overlay's display, to compare with the owner (set per window). */
  displayId?: number;
}

export type OverlayStateMsg = InteractionState;
