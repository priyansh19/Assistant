/**
 * Drawings on the screen, next to the POINT tag (feature parity: the official app "draws on your
 * screen to show the way"). Coordinates are in screenshot-image pixels, like POINT:
 *
 *   [BOX:x,y,w,h:label]          a rectangle around an area (top-left corner, width, height)
 *   [ARROW:x1,y1,x2,y2:label]    an arrow from one place to another
 *   [CIRCLE:x,y,r:label]         a circle around a spot
 *
 * Each may end with :screenN like POINT. The label is optional.
 */

import { mapPointToDisplay, physicalSize, type CaptureGeometry } from './coordinates.js';

export type DrawShape =
  | { kind: 'box'; x: number; y: number; w: number; h: number; label: string; screen: number | null }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; label: string; screen: number | null }
  | { kind: 'circle'; x: number; y: number; r: number; label: string; screen: number | null };

/** A drawing placed on a display, in DIP relative to that display (what its overlay draws at). */
export interface MappedShape {
  displayId: number;
  kind: DrawShape['kind'];
  /** box: [top-left, bottom-right]; arrow: [from, to]; circle: [centre]. */
  points: { x: number; y: number }[];
  /** Circle radius in DIP. */
  r?: number;
  label: string;
}

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const COUNTS = { BOX: 4, ARROW: 4, CIRCLE: 3 } as const;

/** Parse one complete drawing tag. Returns null if it isn't valid. */
export function parseDrawTag(raw: string): DrawShape | null {
  const head = /^\[(BOX|ARROW|CIRCLE):/i.exec(raw);
  if (!head?.[1]) return null;
  const name = head[1].toUpperCase() as keyof typeof COUNTS;
  const nums = Array.from({ length: COUNTS[name] }, () => NUM).join('\\s*,\\s*');
  const m = new RegExp(
    `^\\[${name}:\\s*${nums}(?:\\s*:\\s*([^\\]]*?))?(?:\\s*:\\s*screen\\s*(\\d+))?\\s*\\]$`,
    'i',
  ).exec(raw);
  if (!m) return null;
  const n = m.slice(1, COUNTS[name] + 1).map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const label = (m[COUNTS[name] + 1] ?? '').trim();
  const screenRaw = m[COUNTS[name] + 2];
  const screen = screenRaw === undefined ? null : Number(screenRaw);
  if (screen !== null && screen < 1) return null;
  const [a = 0, b = 0, c = 0, d = 0] = n;
  if (name === 'BOX') {
    if (c <= 0 || d <= 0) return null;
    return { kind: 'box', x: a, y: b, w: c, h: d, label, screen };
  }
  if (name === 'ARROW') {
    if (a === c && b === d) return null;
    return { kind: 'arrow', x1: a, y1: b, x2: c, y2: d, label, screen };
  }
  if (c <= 0) return null;
  return { kind: 'circle', x: a, y: b, r: c, label, screen };
}

export type MapShapeResult = { ok: true; shape: MappedShape } | { ok: false; detail: string };

/** Map a drawing from image pixels onto the display its screenshot came from. */
export function mapShapeToDisplay(shape: DrawShape, captures: readonly CaptureGeometry[]): MapShapeResult {
  const corners: { x: number; y: number }[] =
    shape.kind === 'box'
      ? [
          { x: shape.x, y: shape.y },
          { x: shape.x + shape.w, y: shape.y + shape.h },
        ]
      : shape.kind === 'arrow'
        ? [
            { x: shape.x1, y: shape.y1 },
            { x: shape.x2, y: shape.y2 },
          ]
        : [{ x: shape.x, y: shape.y }];
  const points: { x: number; y: number }[] = [];
  let displayId = -1;
  const cap = captures[(shape.screen ?? 1) - 1];
  for (const p of corners) {
    // A box edge or arrow end slightly off the image is drawn at the edge rather than dropped.
    const q = cap
      ? { x: Math.min(Math.max(p.x, 0), cap.imageWidth), y: Math.min(Math.max(p.y, 0), cap.imageHeight) }
      : p;
    const m = mapPointToDisplay({ ...q, screen: shape.screen }, captures);
    if (!m.ok) return { ok: false, detail: `${m.reason}: ${m.detail}` };
    displayId = m.point.displayId;
    points.push(m.point.local);
  }
  const out: MappedShape = { displayId, kind: shape.kind, points, label: shape.label };
  if (shape.kind === 'circle' && cap) {
    out.r = (shape.r * physicalSize(cap.display).width) / cap.imageWidth / cap.display.scaleFactor;
  }
  return { ok: true, shape: out };
}
