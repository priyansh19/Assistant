/**
 * Map a POINT coordinate from screenshot-image pixels to a place on a display (plan §3.2).
 *
 *   image px  →  display physical px  →  display-local DIP  →  global DIP
 *
 * Electron reports display bounds in DIP (global, may be negative for displays left of or
 * above the primary) plus a per-display scale factor. Screenshots are taken in physical
 * pixels and may then be downscaled before being sent to the model.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayGeometry {
  id: number;
  /** Global bounds in DIP, as Electron's `screen` API reports them. */
  bounds: Rect;
  scaleFactor: number;
}

/** One screenshot sent to the model. `screen` N in a POINT tag refers to `captures[N - 1]`. */
export interface CaptureGeometry {
  display: DisplayGeometry;
  /** Size of the image the model saw, after any downscale. */
  imageWidth: number;
  imageHeight: number;
}

export interface MappedPoint {
  displayId: number;
  /** Position inside the display (what the overlay window for that display draws at). */
  local: { x: number; y: number };
  /** Global DIP position. */
  global: { x: number; y: number };
}

export type MapResult =
  | { ok: true; point: MappedPoint }
  | { ok: false; reason: 'no-captures' | 'unknown-screen' | 'out-of-bounds' | 'bad-geometry'; detail: string };

export function physicalSize(display: DisplayGeometry): { width: number; height: number } {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
}

/** Size to downscale a capture to so its long edge is at most `maxLongEdge` (never upscales). */
export function downscaledSize(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

/** Points this close outside the image (in image px) are clamped instead of rejected; models are often off by a pixel. */
const EDGE_TOLERANCE_PX = 4;

export function mapPointToDisplay(
  point: { x: number; y: number; screen: number | null },
  captures: readonly CaptureGeometry[],
): MapResult {
  if (captures.length === 0) return { ok: false, reason: 'no-captures', detail: 'no screenshot was sent' };
  const index = (point.screen ?? 1) - 1;
  const capture = captures[index];
  if (!capture) {
    return { ok: false, reason: 'unknown-screen', detail: `screen${point.screen} but ${captures.length} sent` };
  }
  const { display, imageWidth, imageHeight } = capture;
  if (imageWidth <= 0 || imageHeight <= 0 || display.scaleFactor <= 0) {
    return { ok: false, reason: 'bad-geometry', detail: 'empty image or zero scale factor' };
  }
  const t = EDGE_TOLERANCE_PX;
  if (point.x < -t || point.y < -t || point.x > imageWidth + t || point.y > imageHeight + t) {
    return {
      ok: false,
      reason: 'out-of-bounds',
      detail: `(${point.x},${point.y}) outside ${imageWidth}x${imageHeight} image`,
    };
  }
  const ix = Math.min(Math.max(point.x, 0), imageWidth - 1);
  const iy = Math.min(Math.max(point.y, 0), imageHeight - 1);

  const phys = physicalSize(display);
  const px = (ix * phys.width) / imageWidth;
  const py = (iy * phys.height) / imageHeight;
  const local = { x: px / display.scaleFactor, y: py / display.scaleFactor };
  return {
    ok: true,
    point: {
      displayId: display.id,
      local,
      global: { x: display.bounds.x + local.x, y: display.bounds.y + local.y },
    },
  };
}

/**
 * Where a global DIP point is on the screenshots: the screen number, its position in thousandths of
 * that screenshot, and the point on its display. Null when no screenshot covers it.
 */
export function placeGlobal(
  global: { x: number; y: number },
  captures: readonly CaptureGeometry[],
): { screen: number; x: number; y: number; point: MappedPoint } | null {
  for (let i = 0; i < captures.length; i++) {
    const b = captures[i]?.display.bounds;
    const id = captures[i]?.display.id;
    if (!b || id === undefined || b.width <= 0 || b.height <= 0) continue;
    const lx = global.x - b.x;
    const ly = global.y - b.y;
    if (lx < 0 || ly < 0 || lx >= b.width || ly >= b.height) continue;
    return {
      screen: i + 1,
      x: Math.round((lx / b.width) * 1000),
      y: Math.round((ly / b.height) * 1000),
      point: { displayId: id, local: { x: lx, y: ly }, global: { ...global } },
    };
  }
  return null;
}

/**
 * Models give positions as thousandths of the screenshot (0–1000 on each axis; Gemini models do
 * this natively). Convert to that screenshot's pixels before mapping onto the display.
 */
export function fromThousandths<T extends { x: number; y: number; screen: number | null }>(
  p: T,
  captures: readonly CaptureGeometry[],
): T {
  const cap = captures[(p.screen ?? 1) - 1];
  if (!cap) return p;
  return { ...p, x: (p.x / 1000) * cap.imageWidth, y: (p.y / 1000) * cap.imageHeight };
}
