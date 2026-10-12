/**
 * Drawings on the screen, next to the POINT tag (feature parity: the official app "draws on your
 * screen to show the way"), and sketches when the user asks Clicky to draw. Coordinates are in
 * screenshot-image pixels, like POINT:
 *
 *   [BOX:x,y,w,h:label]            a rectangle around an area (top-left corner, width, height)
 *   [ARROW:x1,y1,x2,y2:label]      an arrow from one place to another
 *   [CIRCLE:x,y,r:label]           a circle around a spot
 *   [HIGHLIGHT:x,y,w,h:label]      a see-through marker stroke over an area (text, a row)
 *   [PATH:x1,y1 x2,y2 …:label]     a freehand line through 2–40 points (underline, tick, star, sketch)
 *   [TEXT:x,y:words]               handwritten words with their top-left corner at x,y
 *
 * Each may end with :screenN like POINT. The label is optional, except for TEXT where it is the
 * words to write.
 */

import { mapPointToDisplay, physicalSize, type CaptureGeometry } from './coordinates.js';

export type DrawShape =
  | { kind: 'box'; x: number; y: number; w: number; h: number; label: string; screen: number | null }
  | { kind: 'highlight'; x: number; y: number; w: number; h: number; label: string; screen: number | null }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; label: string; screen: number | null }
  | { kind: 'circle'; x: number; y: number; r: number; label: string; screen: number | null }
  | { kind: 'path'; points: { x: number; y: number }[]; label: string; screen: number | null }
  | { kind: 'text'; x: number; y: number; label: string; screen: number | null };

export type DrawKind = DrawShape['kind'];

/** A drawing placed on a display, in DIP relative to that display (what its overlay draws at). */
export interface MappedShape {
  displayId: number;
  kind: DrawKind;
  /** box/highlight: [top-left, bottom-right]; arrow: [from, to]; circle: [centre]; path: every point; text: [top-left]. */
  points: { x: number; y: number }[];
  /** Circle radius in DIP. */
  r?: number;
  label: string;
}

/** Most points a PATH may have: enough for a star or a house, not enough to scribble over the screen. */
export const MAX_PATH_POINTS = 40;
/** Longest TEXT note, in characters. */
export const MAX_TEXT_LENGTH = 60;

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const COUNTS = { BOX: 4, HIGHLIGHT: 4, ARROW: 4, CIRCLE: 3, TEXT: 2 } as const;
/** Optional label (never just "screenN": that's the screen) and optional screen, then the close. */
const TAIL = '(?:\\s*:\\s*(?!screen\\s*\\d+\\s*\\]$)([^\\]]*?))?(?:\\s*:\\s*screen\\s*(\\d+))?\\s*\\]$';

/** Tag names that carry a drawing (the point parser holds these back from speech). */
export const DRAW_TAGS = ['BOX', 'HIGHLIGHT', 'ARROW', 'CIRCLE', 'PATH', 'TEXT'] as const;

function screenOf(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return null;
  const n = Number(raw);
  return n >= 1 ? n : undefined;
}

/** Parse one complete drawing tag. Returns null if it isn't valid. */
export function parseDrawTag(raw: string): DrawShape | null {
  const head = /^\[(BOX|HIGHLIGHT|ARROW|CIRCLE|PATH|TEXT):/i.exec(raw);
  if (!head?.[1]) return null;
  const name = head[1].toUpperCase();
  if (name === 'PATH') return parsePath(raw);
  const count = COUNTS[name as keyof typeof COUNTS];
  const nums = Array.from({ length: count }, () => NUM).join('\\s*,\\s*');
  const m = new RegExp(`^\\[${name}:\\s*${nums}${TAIL}`, 'i').exec(raw);
  if (!m) return null;
  const n = m.slice(1, count + 1).map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const label = (m[count + 1] ?? '').trim();
  const screen = screenOf(m[count + 2]);
  if (screen === undefined) return null;
  const [a = 0, b = 0, c = 0, d = 0] = n;
  if (name === 'BOX' || name === 'HIGHLIGHT') {
    if (c <= 0 || d <= 0) return null;
    return { kind: name === 'BOX' ? 'box' : 'highlight', x: a, y: b, w: c, h: d, label, screen };
  }
  if (name === 'ARROW') {
    if (a === c && b === d) return null;
    return { kind: 'arrow', x1: a, y1: b, x2: c, y2: d, label, screen };
  }
  if (name === 'TEXT') {
    if (!label) return null;
    return { kind: 'text', x: a, y: b, label: label.slice(0, MAX_TEXT_LENGTH), screen };
  }
  if (c <= 0) return null;
  return { kind: 'circle', x: a, y: b, r: c, label, screen };
}

/** `[PATH:10,10 20,30;40,50:label:screen2]`: x,y pairs, separated by spaces or semicolons. */
function parsePath(raw: string): DrawShape | null {
  const m = new RegExp(`^\\[PATH:\\s*([-\\d.,;\\s]+?)${TAIL}`, 'i').exec(raw);
  if (!m?.[1]) return null;
  const nums = (m[1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length % 2 !== 0 || nums.some((v) => !Number.isFinite(v))) return null;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    const x = nums[i] ?? 0;
    const y = nums[i + 1] ?? 0;
    // Drop repeats so a stuttering model doesn't produce zero-length segments.
    const last = points[points.length - 1];
    if (last && last.x === x && last.y === y) continue;
    points.push({ x, y });
  }
  if (points.length < 2 || points.length > MAX_PATH_POINTS) return null;
  const screen = screenOf(m[3]);
  if (screen === undefined) return null;
  return { kind: 'path', points, label: (m[2] ?? '').trim(), screen };
}

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/** Write a shape back as its tag (used for demos and tests; parseDrawTag reads it back). */
export function formatDrawTag(s: DrawShape): string {
  const tail = (label: string): string => `${label ? `:${label}` : ''}${s.screen ? `:screen${s.screen}` : ''}]`;
  switch (s.kind) {
    case 'box':
    case 'highlight':
      return `[${s.kind.toUpperCase()}:${[s.x, s.y, s.w, s.h].map(fmt).join(',')}${tail(s.label)}`;
    case 'arrow':
      return `[ARROW:${[s.x1, s.y1, s.x2, s.y2].map(fmt).join(',')}${tail(s.label)}`;
    case 'circle':
      return `[CIRCLE:${[s.x, s.y, s.r].map(fmt).join(',')}${tail(s.label)}`;
    case 'path':
      return `[PATH:${s.points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}${tail(s.label)}`;
    case 'text':
      return `[TEXT:${fmt(s.x)},${fmt(s.y)}${tail(s.label)}`;
  }
}

/** The points that get mapped onto the display, in the order MappedShape.points expects. */
function anchorPoints(shape: DrawShape): { x: number; y: number }[] {
  switch (shape.kind) {
    case 'box':
    case 'highlight':
      return [
        { x: shape.x, y: shape.y },
        { x: shape.x + shape.w, y: shape.y + shape.h },
      ];
    case 'arrow':
      return [
        { x: shape.x1, y: shape.y1 },
        { x: shape.x2, y: shape.y2 },
      ];
    case 'path':
      return shape.points;
    default:
      return [{ x: shape.x, y: shape.y }];
  }
}

/**
 * Scale every coordinate of a shape: thousandths of a screenshot to image pixels, or to display
 * DIP for a sketch drawn without a screenshot. A circle's radius follows the horizontal scale.
 */
export function scaleShape(s: DrawShape, sx: number, sy: number): DrawShape {
  switch (s.kind) {
    case 'box':
    case 'highlight':
      return { ...s, x: s.x * sx, y: s.y * sy, w: s.w * sx, h: s.h * sy };
    case 'arrow':
      return { ...s, x1: s.x1 * sx, y1: s.y1 * sy, x2: s.x2 * sx, y2: s.y2 * sy };
    case 'circle':
      return { ...s, x: s.x * sx, y: s.y * sy, r: s.r * sx };
    case 'path':
      return { ...s, points: s.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
    case 'text':
      return { ...s, x: s.x * sx, y: s.y * sy };
  }
}

/** A shape already in display DIP (a built-in sketch), placed on a display without any mapping. */
export function shapeOnDisplay(s: DrawShape, displayId: number): MappedShape {
  const out: MappedShape = { displayId, kind: s.kind, points: anchorPoints(s), label: s.label };
  if (s.kind === 'circle') out.r = s.r;
  return out;
}

export type MapShapeResult = { ok: true; shape: MappedShape } | { ok: false; detail: string };

/** Map a drawing from image pixels onto the display its screenshot came from. */
export function mapShapeToDisplay(shape: DrawShape, captures: readonly CaptureGeometry[]): MapShapeResult {
  const points: { x: number; y: number }[] = [];
  let displayId = -1;
  const cap = captures[(shape.screen ?? 1) - 1];
  for (const p of anchorPoints(shape)) {
    // A box edge or line end slightly off the image is drawn at the edge rather than dropped.
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

/** Points along an arc, in the same units as the centre (for smiles, curves and demo sketches). */
export function arcPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fromRad: number,
  toRad: number,
  count: number,
): { x: number; y: number }[] {
  const n = Math.max(2, Math.min(MAX_PATH_POINTS, Math.round(count)));
  return Array.from({ length: n }, (_, i) => {
    const a = fromRad + ((toRad - fromRad) * i) / (n - 1);
    return { x: Math.round((cx + Math.cos(a) * rx) * 10) / 10, y: Math.round((cy + Math.sin(a) * ry) * 10) / 10 };
  });
}

/**
 * The built-in drawing example, in thousandths of a screen (0–1000 across and down): a written
 * greeting, a smiley face with an arrow pointing at it, a star, an underline and a highlighted
 * taskbar. It exercises every mark kind, so it doubles as the overlay's smoke test.
 *
 * `aspect` is the screen's width / height, so the face and star stay round on wide screens.
 */
export function drawingDemo(aspect = 16 / 9): DrawShape[] {
  const ky = Math.max(0.5, Math.min(3, aspect)); // y thousandths per x thousandth
  const face = { x: 500, y: 470, r: 90 };
  const star: { x: number; y: number }[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 60 : 24;
    star.push({ x: Math.round(780 + Math.cos(a) * r), y: Math.round(300 + Math.sin(a) * r * ky) });
  }
  return [
    { kind: 'text', x: 80, y: 110, label: 'Hi! Clicky can draw on your screen', screen: null },
    {
      kind: 'path',
      points: [
        { x: 80, y: 185 },
        { x: 200, y: 181 },
        { x: 330, y: 187 },
      ],
      label: '',
      screen: null,
    },
    { kind: 'circle', x: face.x, y: face.y, r: face.r, label: '', screen: null },
    { kind: 'circle', x: 468, y: Math.round(face.y - 30 * ky), r: 10, label: '', screen: null },
    { kind: 'circle', x: 532, y: Math.round(face.y - 30 * ky), r: 10, label: '', screen: null },
    {
      kind: 'path',
      points: arcPoints(face.x, face.y + 5 * ky, 50, 40 * ky, Math.PI * 0.15, Math.PI * 0.85, 12),
      label: '',
      screen: null,
    },
    { kind: 'arrow', x1: 250, y1: 640, x2: 400, y2: 540, label: 'a smiley', screen: null },
    { kind: 'path', points: star, label: 'a star', screen: null },
    { kind: 'highlight', x: 0, y: 945, w: 1000, h: 55, label: 'Your taskbar', screen: null },
  ];
}
