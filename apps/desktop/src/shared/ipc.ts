// IPC channel names and payloads shared by main, preload and renderer.
export const IPC = {
  overlayCursor: 'overlay:cursor',
  overlayState: 'overlay:state',
} as const;

/** Cursor position in DIP relative to the overlay's display, or null when it's on another display. */
export type OverlayCursor = { x: number; y: number } | null;
