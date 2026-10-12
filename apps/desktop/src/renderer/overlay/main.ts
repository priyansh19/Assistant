// The Clicky companion: a triangle that trails the mouse pointer, shows a waveform while you talk,
// spins while it thinks, and flies along an arc to whatever it's pointing at, with a label bubble.
import { CURSOR_COLOR_HEX, type InteractionState } from '@clicky/core';
import type { OverlayApi } from '../../preload/overlay';
import type {
  OverlayAnchor,
  OverlayConfig,
  OverlayDrawing,
  OverlayMessage,
  OverlayPoint,
} from '../../shared/overlay-protocol';

declare global {
  interface Window {
    clicky: OverlayApi;
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

const SIZES = { small: 16, medium: 22, large: 30 } as const;
/** Where the triangle sits relative to the real pointer while following. */
/** Gap kept between the real pointer and the companion, in physical centimetres. */
const GAP_CM = 1;
/** Rough extent of the Windows arrow pointer below/right of its hotspot, in CSS px. */
const POINTER_BODY = { x: 12, y: 19 };

/** Centre of the companion relative to the pointer hotspot: past the arrow, then ~1 cm further out. */
function followOffset(): { x: number; y: number } {
  const gap = GAP_CM * (config.pxPerCm ?? 96 / 2.54);
  const half = SIZES[config.size] / 2;
  const d = gap / Math.SQRT2; // along the down-right diagonal
  return { x: POINTER_BODY.x + d + half, y: POINTER_BODY.y + d + half };
}

let config: OverlayConfig = { color: 'blue', size: 'medium', showLabels: true, showCompanion: true, paused: false };
/**
 * 0–1, how present the companion is. Always 1 with "Always show Clicky" on; otherwise it fades in
 * when Clicky is used and out a second after everything (voice, pointing, drawing) has finished.
 */
let presence = 1;
const LINGER_MS = 1000;
const FADE_IN_PER_MS = 1 / 150;
const FADE_OUT_PER_MS = 1 / 400;
let state: InteractionState = 'idle';
let cursor: { x: number; y: number } | null = null;
let level = 0;
const levels: number[] = new Array(24).fill(0);
/** While dictating, the companion sits beside the text caret instead of the pointer. */
let anchor: OverlayAnchor = null;
/** Another display shows the companion right now: this one stays empty. */
let owner: number | null = null;
/** Rotation while working, like the original Clicky; the tracing light rides on top. */
let spinAngle = 0;

type Mode =
  | { kind: 'follow' }
  | { kind: 'fly'; from: Pt; ctrl: Pt; to: Pt; start: number; dur: number; then: 'point' | 'follow' }
  | { kind: 'point'; at: Pt; label: string; phrase: string; since: number; heading: number };

interface Pt {
  x: number;
  y: number;
}

let mode: Mode = { kind: 'follow' };
let pos: Pt | null = null; // triangle centre
let angle = -Math.PI * 0.75; // tip direction (radians); up-left by default
let spin = 0;
let lastFrame = performance.now();
let idleSince = 0; // when the interaction finished, for dismissing the label
let message: { text: string; kind: 'error' | 'info'; since: number; until: number } | null = null;
let pendingPoint: { p: OverlayPoint; label: string } | null = null;
/**
 * Marks from the answer (or the tray's example), drawn one after another like a pen would: each
 * has a start time after the previous one ends, and the companion rides the tip while it draws.
 */
let drawings: { d: OverlayDrawing; start: number; dur: number }[] = [];
/** When the pen finishes everything queued so far. */
let penFree = 0;
/** Where the pen is this frame on this display (the companion's tip goes there), or null. */
let pen: Pt | null = null;
/** How long a finished drawing stays up, and how long it takes to fade out. */
const DRAWING_MS = 20000;
const FADE_MS = 600;
/** Pen speed in px per ms, the pause between strokes, and the glide to the first stroke. */
const PEN_SPEED = 1.5;
const STROKE_GAP_MS = 220;
const LEAD_MS = 380;
/** The companion holds its tip down-left onto the line, like a pen in a right hand. */
const PEN_HEADING = Math.PI * 0.75;
const HANDWRITING = '600 30px "Ink Free", "Segoe Print", "Comic Sans MS", cursive';

// ------------------------------------------------------------- geometry helpers

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function bezier(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function bezierTangent(a: Pt, c: Pt, b: Pt, t: number): number {
  const dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x);
  const dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
  return Math.atan2(dy, dx);
}

/** An arc that bows upward (or sideways near the top edge), like the original's flight path. */
function arcControl(from: Pt, to: Pt): Pt {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Perpendicular, chosen to point "up" so the arc lifts over the screen.
  let nx = -dy / dist;
  let ny = dx / dist;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const lift = Math.min(220, dist * 0.35);
  const c = { x: mx + nx * lift, y: my + ny * lift };
  c.y = Math.max(20, c.y);
  return c;
}

function followTarget(): Pt | null {
  if (anchor) {
    // Just right of the caret, vertically centred on the line, tip pointing back at it.
    const half = SIZES[config.size] / 2;
    return { x: anchor.x + 10 + half, y: anchor.y + anchor.height / 2 };
  }
  if (!cursor) return null;
  const o = followOffset();
  return { x: cursor.x + o.x, y: cursor.y + o.y };
}

/** What the bubble says when the model gave no label (the original's pointer phrases). */
const POINTER_PHRASES = ['right here!', 'this one!', 'over here!', 'here it is!', 'found it!'];
const pointerPhrase = (): string =>
  POINTER_PHRASES[Math.floor(Math.random() * POINTER_PHRASES.length)] ?? 'right here!';

/**
 * Where the mouse was when the companion started flying back to it. Moving the mouse more than
 * RETURN_CANCEL_PX from there cuts the return short and it snaps back to following, as in the
 * original. The flight out to a target is never interrupted.
 */
let returnFrom: Pt | null = null;
const RETURN_CANCEL_PX = 100;

function startFlight(to: Pt, then: 'point' | 'follow', label = ''): void {
  returnFrom = then === 'follow' && cursor ? { ...cursor } : null;
  const from = pos ?? followTarget() ?? { x: window.innerWidth / 2, y: -40 };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const dur = Math.min(1100, Math.max(420, dist / 1.5));
  mode = { kind: 'fly', from, ctrl: arcControl(from, to), to, start: performance.now(), dur, then };
  if (then === 'point') pendingPoint = { p: { x: to.x, y: to.y, label }, label };
}

// ------------------------------------------------------------- drawing

/** Amber: something failed (shown with a one-line reason next to it). */
const AMBER = '#f59e0b';

function color(): string {
  if (message?.kind === 'error' && performance.now() < message.until) return AMBER;
  return CURSOR_COLOR_HEX[config.color];
}

/** Distance from the triangle's centre to its tip, as a fraction of the size setting. */
const TIP = 0.6;

/**
 * An equilateral triangle with softly rounded corners. One vertex is the pointer tip: it faces the
 * real cursor while following and rests exactly on the target while pointing.
 */
/**
 * `trace` (0–1) draws a bright light running around the outline: Clicky is working on it.
 */
function drawTriangle(at: Pt, heading: number, scale: number, alpha: number, trace: number | null = null): void {
  const s = SIZES[config.size] * scale;
  const r = s * TIP;
  ctx.save();
  ctx.translate(at.x, at.y);
  // The shape is drawn pointing right (+x); rotate to the heading.
  ctx.rotate(heading);
  ctx.globalAlpha = alpha;
  const pts = [0, (2 * Math.PI) / 3, (-2 * Math.PI) / 3].map((a) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r }));
  const [tip, b, c] = pts as [Pt, Pt, Pt];
  const round = s * 0.07;
  const grad = ctx.createLinearGradient(b.x, 0, tip.x, 0);
  grad.addColorStop(0, shade(color(), 0.35));
  grad.addColorStop(1, color());
  ctx.shadowColor = color();
  ctx.shadowBlur = 14 * scale;
  ctx.beginPath();
  // Start mid-edge so every corner, the tip included, gets the same small rounding.
  ctx.moveTo((c.x + tip.x) / 2, (c.y + tip.y) / 2);
  ctx.arcTo(tip.x, tip.y, b.x, b.y, round);
  ctx.arcTo(b.x, b.y, c.x, c.y, round);
  ctx.arcTo(c.x, c.y, tip.x, tip.y, round);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  if (trace !== null) {
    // Perimeter of an equilateral triangle with circumradius r is 3·√3·r.
    const per = 3 * Math.sqrt(3) * r;
    const seg = per * 0.28;
    ctx.setLineDash([seg, per - seg]);
    ctx.lineDashOffset = -trace * per;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Listening: the original sound bars beside the triangle, moving with the voice. */
function drawWaveform(at: Pt): void {
  const bars = 7;
  const w = 3;
  const gap = 3;
  const x0 = at.x + SIZES[config.size] * 0.9;
  const recent = levels.slice(-bars);
  ctx.save();
  ctx.fillStyle = color();
  ctx.shadowColor = color();
  ctx.shadowBlur = 6;
  for (let i = 0; i < bars; i++) {
    const v = recent[i] ?? 0;
    const h = 4 + v * 22 * (0.6 + 0.4 * Math.sin(i * 1.7 + performance.now() / 120));
    roundRect(x0 + i * (w + gap), at.y - h / 2, w, h, 1.5);
    ctx.fill();
  }
  ctx.restore();
}

/** Lighten (amt > 0) a #rrggbb colour. */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * amt));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Characters per ms when a bubble types itself in (the original types at 30–60 ms a character). */
const TYPE_MS = 40;
/** The bubble pops from half size with a bright glow that settles, as in the original. */
const POP_MS = 320;

/** easeOutBack: overshoots a little, then settles. */
const easeOutBack = (t: number): number => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/**
 * A text bubble beside `anchor`. With `since` (when it appeared), it pops in and types itself; the
 * box is sized for the whole text from the start so it doesn't jitter while typing.
 */
function drawBubble(text: string, anchor: Pt, kind: 'label' | 'error' | 'info', since?: number): void {
  const age = since === undefined ? Infinity : performance.now() - since;
  ctx.save();
  ctx.font = '500 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  const maxW = 320;
  const lines = wrap(text, maxW - 24);
  const lineH = 18;
  const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 24);
  const h = lines.length * lineH + 14;
  // Prefer below-right of the anchor; flip to stay on screen.
  let x = anchor.x + 14;
  let y = anchor.y + 16;
  if (x + w > window.innerWidth - 8) x = anchor.x - w - 14;
  if (y + h > window.innerHeight - 8) y = anchor.y - h - 16;
  x = Math.max(8, x);
  y = Math.max(8, y);
  const pop = Math.min(1, age / POP_MS);
  if (pop < 1) {
    const k = 0.5 + 0.5 * easeOutBack(pop);
    const ox = x < anchor.x ? x + w : x;
    const oy = y < anchor.y ? y + h : y;
    ctx.translate(ox, oy);
    ctx.scale(k, k);
    ctx.translate(-ox, -oy);
  }
  ctx.shadowColor = pop < 1 && kind !== 'error' ? color() : 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 12 + (1 - pop) * 18;
  ctx.fillStyle = kind === 'error' ? 'rgba(60, 14, 10, 0.92)' : 'rgba(20, 22, 28, 0.9)';
  roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = kind === 'error' ? 'rgba(255,120,100,0.7)' : kind === 'label' ? color() : 'rgba(255,255,255,0.25)';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  let shown = Math.floor(age / TYPE_MS) + 1;
  lines.forEach((l, i) => {
    if (shown <= 0) return;
    ctx.fillText(l.slice(0, shown), x + 12, y + 7 + i * lineH);
    shown -= l.length + 1;
  });
  ctx.restore();
}

function wrap(text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/** The arrow's gentle bend: a curve reads as a gesture rather than a ruler line. */
function arrowControl(a: Pt, b: Pt): Pt {
  const len = dist(a, b) || 1;
  return {
    x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * len * 0.12,
    y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * len * 0.12,
  };
}

/** Corners of a box or highlight, padded a little so the line doesn't cover what it frames. */
function boxCorners(d: OverlayDrawing): Pt[] {
  const [a, b] = d.points;
  if (!a || !b) return [];
  const x0 = Math.min(a.x, b.x) - 4;
  const y0 = Math.min(a.y, b.y) - 4;
  const x1 = Math.max(a.x, b.x) + 4;
  const y1 = Math.max(a.y, b.y) + 4;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ];
}

function polyLength(pts: Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1] as Pt, pts[i] as Pt);
  return n;
}

/** The point `len` along a polyline. */
function alongPoly(pts: Pt[], len: number): Pt {
  let left = len;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const seg = dist(a, b);
    if (left <= seg) {
      const t = seg ? left / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= seg;
  }
  return pts[pts.length - 1] ?? { x: 0, y: 0 };
}

/** Stroke a polyline up to `len` along it. */
function strokePoly(pts: Pt[], len: number): void {
  const first = pts[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  let left = len;
  for (let i = 1; i < pts.length && left > 0; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const seg = dist(a, b);
    const t = Math.min(1, seg ? left / seg : 1);
    ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    left -= seg;
  }
  ctx.stroke();
}

function textWidth(text: string): number {
  ctx.save();
  ctx.font = HANDWRITING;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

/** Where handwriting starts, nudged so the whole line stays on screen. */
function textOrigin(d: OverlayDrawing): Pt {
  const a = d.points[0] ?? { x: 0, y: 0 };
  return {
    x: Math.max(8, Math.min(a.x, window.innerWidth - textWidth(d.label) - 12)),
    y: Math.max(8, Math.min(a.y, window.innerHeight - 44)),
  };
}

/** How long the pen takes over a mark: by its length, so a long line takes longer than a tick. */
function drawDuration(d: OverlayDrawing): number {
  const [a, b] = d.points;
  if (d.kind === 'text') return Math.min(2600, Math.max(450, d.label.length * 55));
  const len =
    d.kind === 'circle'
      ? 2 * Math.PI * ((d.r ?? 20) + 4)
      : d.kind === 'box'
        ? polyLength(boxCorners(d))
        : d.kind === 'highlight' && a && b
          ? Math.abs(b.x - a.x)
          : polyLength(d.points);
  return Math.min(1800, Math.max(300, len / PEN_SPEED));
}

/** Where the pen starts a mark (the companion glides there first). */
function strokeStart(d: OverlayDrawing): Pt {
  const a = d.points[0] ?? { x: 0, y: 0 };
  if (d.kind === 'circle') return { x: a.x, y: a.y - ((d.r ?? 20) + 4) };
  if (d.kind === 'box') return boxCorners(d)[0] ?? a;
  if (d.kind === 'highlight') {
    const b = d.points[1] ?? a;
    return { x: Math.min(a.x, b.x), y: (a.y + b.y) / 2 };
  }
  if (d.kind === 'text') {
    const o = textOrigin(d);
    return { x: o.x, y: o.y + 26 };
  }
  return a;
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * Draw one mark `t` (0–1) of the way and return where the pen tip is, plus where its label goes.
 */
function drawMark(d: OverlayDrawing, t: number): { tip: Pt | null; label: Pt | null } {
  const [a, b] = d.points;
  if ((d.kind === 'box' || d.kind === 'path') && d.points.length >= 2) {
    const pts = d.kind === 'box' ? boxCorners(d) : d.points;
    const len = polyLength(pts);
    strokePoly(pts, len * t);
    return {
      tip: alongPoly(pts, len * t),
      // A path's label goes under its lowest point, clear of the drawing.
      label:
        d.kind === 'box'
          ? { x: (pts[0]?.x ?? 0) + 4, y: pts[2]?.y ?? 0 }
          : { x: Math.min(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) },
    };
  }
  if (d.kind === 'highlight' && a && b) {
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.max(6, Math.abs(b.y - a.y));
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba(color(), 0.3);
    roundRect(x0 - 2, y0 - 2, w * t + 4, h + 4, Math.min(8, h / 2));
    ctx.fill();
    ctx.restore();
    return { tip: { x: x0 + w * t, y: y0 + h / 2 }, label: { x: x0, y: y0 + h + 2 } };
  }
  if (d.kind === 'circle' && a) {
    const r = (d.r ?? 20) + 4;
    const end = -Math.PI / 2 + Math.PI * 2 * t;
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, -Math.PI / 2, end);
    ctx.stroke();
    return {
      tip: { x: a.x + Math.cos(end) * r, y: a.y + Math.sin(end) * r },
      label: { x: a.x + r * 0.7, y: a.y + r * 0.7 },
    };
  }
  if (d.kind === 'arrow' && a && b) {
    const c = arrowControl(a, b);
    // The first part of the curve, split at t (de Casteljau), so the line grows along its final shape.
    const c1 = { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t };
    const end = bezier(a, c, b, t);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c1.x, c1.y, end.x, end.y);
    ctx.stroke();
    if (t > 0.85) {
      const ang = Math.atan2(b.y - c.y, b.x - c.x);
      const head = 12;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
      ctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    }
    return { tip: end, label: a };
  }
  if (d.kind === 'text' && d.label) {
    const o = textOrigin(d);
    const shown = d.label.slice(0, Math.ceil(d.label.length * t));
    ctx.save();
    ctx.font = HANDWRITING;
    ctx.textBaseline = 'top';
    ctx.shadowBlur = 0;
    // A white edge keeps the writing readable on dark and busy backgrounds alike.
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(shown, o.x, o.y);
    ctx.fillText(shown, o.x, o.y);
    const w = ctx.measureText(shown).width;
    ctx.restore();
    return { tip: { x: o.x + w, y: o.y + 26 }, label: null };
  }
  return { tip: null, label: null };
}

/** Draw every live mark, each revealed by the pen in turn and fading out at the end. */
function drawShapes(now: number): void {
  pen = null;
  drawings = drawings.filter((x) => now - (x.start + x.dur) < DRAWING_MS);
  if (!drawings.length) penFree = 0;
  let next: { d: OverlayDrawing; start: number } | null = null;
  for (const { d, start, dur } of drawings) {
    if (now < start) {
      if (!next || start < next.start) next = { d, start };
      continue;
    }
    const t = Math.min(1, (now - start) / dur);
    const alpha = Math.min(1, (DRAWING_MS - (now - start - dur)) / FADE_MS);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color();
    ctx.fillStyle = color();
    ctx.shadowColor = color();
    ctx.shadowBlur = 10;
    ctx.lineWidth = d.kind === 'path' ? 4 : 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const { tip, label } = drawMark(d, t);
    ctx.restore();
    if (t < 1 && tip) pen = tip;
    if (label && d.label && d.kind !== 'text' && config.showLabels && t >= 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      drawBubble(d.label, label, 'label');
      ctx.restore();
    }
  }
  // Between strokes the companion glides to where the next one starts.
  if (!pen && next) pen = strokeStart(next.d);
}

function drawTargetRing(at: Pt, since: number, now: number): void {
  const t = ((now - since) % 1400) / 1400;
  ctx.save();
  ctx.strokeStyle = color();
  ctx.globalAlpha = 1 - t;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(at.x, at.y, 6 + t * 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------- animation loop

let running = false;

function frame(now: number): void {
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  resize();
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const target = followTarget();
  let visible = true;
  let scale = 1;
  let heading = angle;

  // Draw the marks first: that tells us where the pen is this frame.
  drawShapes(now);
  const drawing = pen !== null && mode.kind === 'follow';

  if (drawing && pen) {
    // The companion is the pen: its tip rides the line being drawn.
    const s = SIZES[config.size] * TIP;
    const want = { x: pen.x - Math.cos(PEN_HEADING) * s, y: pen.y - Math.sin(PEN_HEADING) * s };
    const k = 1 - Math.pow(0.001, (dt / 1000) * 14);
    pos = pos && dist(pos, want) > 2 ? { x: pos.x + (want.x - pos.x) * k, y: pos.y + (want.y - pos.y) * k } : want;
    angle = lerpAngle(angle, PEN_HEADING, 0.3);
    heading = angle;
  } else if (mode.kind === 'follow') {
    if (!target) {
      visible = false;
      pos = null;
    } else {
      // Spring-like trailing: fast enough to feel attached, soft enough to feel alive.
      const k = 1 - Math.pow(0.001, (dt / 1000) * 6);
      pos = pos ? { x: pos.x + (target.x - pos.x) * k, y: pos.y + (target.y - pos.y) * k } : { ...target };
      const toPointer = anchor
        ? Math.atan2(anchor.y + anchor.height / 2 - pos.y, anchor.x - pos.x)
        : cursor
          ? Math.atan2(cursor.y - pos.y, cursor.x - pos.x)
          : angle;
      angle = lerpAngle(angle, toPointer, 0.25);
      heading = angle;
    }
  } else if (
    mode.kind === 'fly' &&
    mode.then === 'follow' &&
    returnFrom &&
    cursor &&
    dist(cursor, returnFrom) > RETURN_CANCEL_PX
  ) {
    // The user moved the mouse during the return flight: stop flying and follow from here.
    mode = { kind: 'follow' };
    returnFrom = null;
  } else if (mode.kind === 'fly') {
    const t = Math.min(1, (now - mode.start) / mode.dur);
    const e = easeInOut(t);
    pos = bezier(mode.from, mode.ctrl, mode.to, e);
    heading = bezierTangent(mode.from, mode.ctrl, mode.to, Math.max(0.02, Math.min(0.98, e)));
    angle = heading;
    scale = 1 + 0.35 * Math.sin(Math.PI * t);
    if (t >= 1) {
      if (mode.then === 'point' && pendingPoint) {
        mode = { kind: 'point', at: mode.to, label: pendingPoint.label, phrase: pointerPhrase(), since: now, heading };
        pendingPoint = null;
      } else {
        mode = { kind: 'follow' };
      }
    }
  } else {
    // Pointing: the tip rests on the target, with a gentle hover.
    const hover = Math.sin((now - mode.since) / 260) * 2.5;
    const s = SIZES[config.size];
    pos = {
      x: mode.at.x - Math.cos(mode.heading) * (s * TIP + hover),
      y: mode.at.y - Math.sin(mode.heading) * (s * TIP + hover),
    };
    heading = mode.heading;
    drawTargetRing(mode.at, mode.since, now);
    if (config.showLabels) drawBubble(mode.label || mode.phrase, mode.at, 'label', mode.since);
    const resting = state === 'idle' || state === 'cancelled' || state === 'error';
    const held = now - mode.since;
    if (held > 12000 || (resting && idleSince && now - idleSince > 2500 && held > 3000) || state === 'listening') {
      const back = followTarget();
      if (back) startFlight(back, 'follow');
      else mode = { kind: 'follow' };
    }
  }

  // State-specific flourishes.
  let trace: number | null = null;
  if (state === 'thinking' || state === 'transcribing') {
    spin += dt * (state === 'thinking' ? 0.0011 : 0.0007);
    trace = drawing ? null : spin % 1;
    // Spin while working, as the original does; when it settles again it eases back to its heading.
    spinAngle += dt * (state === 'thinking' ? 0.0085 : 0.0055);
    if (mode.kind === 'follow' && !drawing) heading = angle + spinAngle;
  } else {
    spin = 0;
    spinAngle = 0;
  }
  if (state === 'speaking' && mode.kind === 'follow' && !drawing) scale *= 1 + 0.05 * Math.sin(now / 180);

  // Only one companion on screen: hide here while another display is pointing or at the caret.
  if (owner !== null && config.displayId !== undefined && owner !== config.displayId) {
    visible = false;
    pos = null;
  }
  const resting = state === 'idle' || state === 'cancelled' || state === 'error';
  const inUse =
    !resting ||
    mode.kind !== 'follow' ||
    drawings.length > 0 ||
    message !== null ||
    (idleSince > 0 && now - idleSince < LINGER_MS);
  const wantPresence = config.showCompanion || inUse ? 1 : 0;
  presence =
    wantPresence > presence
      ? Math.min(1, presence + dt * FADE_IN_PER_MS)
      : Math.max(0, presence - dt * FADE_OUT_PER_MS);
  if (visible && pos && presence > 0.01) {
    ctx.save();
    ctx.globalAlpha = presence;
    drawTriangle(pos, heading, scale, (config.paused ? 0.4 : 1) * presence, trace);
    if (state === 'listening' && mode.kind === 'follow') drawWaveform(pos);
    ctx.restore();
  }
  if (message && now > message.until) message = null;
  if (message && pos) drawBubble(message.text, pos, message.kind, message.since);

  // Stop the loop when nothing is moving; the last frame stays on the canvas until the next input.
  const settled =
    mode.kind === 'follow' &&
    (!visible || (pos !== null && target !== null && Math.hypot(target.x - pos.x, target.y - pos.y) < 0.3));
  // A message only keeps the loop alive while it's visible here (the cursor may be on another display).
  if (!settled || !resting || drawings.length > 0 || (message !== null && pos !== null) || presence !== wantPresence)
    requestAnimationFrame(frame);
  else running = false;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function kick(): void {
  if (running) return;
  running = true;
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

let lastW = 0;
let lastH = 0;
let lastDpr = 0;
function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  if (window.innerWidth === lastW && window.innerHeight === lastH && dpr === lastDpr) return;
  lastW = window.innerWidth;
  lastH = window.innerHeight;
  lastDpr = dpr;
  canvas.width = Math.round(lastW * dpr);
  canvas.height = Math.round(lastH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ------------------------------------------------------------- inputs from main

window.clicky.onCursor((c) => {
  cursor = c;
  if (c) kick();
});

window.clicky.onState((s) => {
  state = s;
  if (s === 'idle' || s === 'cancelled' || s === 'error') idleSince = performance.now();
  else idleSince = 0;
  if (s === 'listening') {
    levels.fill(0);
    message = null;
    drawings = [];
    penFree = 0;
  }
  kick();
});

window.clicky.onPoint((p) => {
  startFlight({ x: p.x, y: p.y }, 'point', p.label);
  kick();
});

window.clicky.onOwner((id) => {
  owner = id;
  kick();
});

window.clicky.onAnchor((a) => {
  anchor = a;
  kick();
});

window.clicky.onDraw((d) => {
  // Queue behind whatever the pen is still drawing; the first stroke waits for the glide over.
  const now = performance.now();
  const start = penFree > now ? penFree + STROKE_GAP_MS : now + LEAD_MS;
  const dur = drawDuration(d);
  penFree = start + dur;
  drawings.push({ d, start, dur });
  kick();
});

window.clicky.onMessage((m: OverlayMessage) => {
  const now = performance.now();
  message = { ...m, since: now, until: now + Math.min(12000, 3500 + m.text.length * (45 + TYPE_MS)) };
  kick();
});

window.clicky.onLevel((l) => {
  level = l;
  levels.push(level);
  levels.shift();
});

window.clicky.onConfig((c) => {
  config = c;
  kick();
});
