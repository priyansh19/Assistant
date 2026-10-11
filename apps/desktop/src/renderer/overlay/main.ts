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

let config: OverlayConfig = { color: 'blue', size: 'medium', showLabels: true, paused: false };
let state: InteractionState = 'idle';
let cursor: { x: number; y: number } | null = null;
let level = 0;
/** While dictating, the companion sits beside the text caret instead of the pointer. */
let anchor: OverlayAnchor = null;
/** Smoothed mic level for the pulse. */
let pulseLevel = 0;

type Mode =
  | { kind: 'follow' }
  | { kind: 'fly'; from: Pt; ctrl: Pt; to: Pt; start: number; dur: number; then: 'point' | 'follow' }
  | { kind: 'point'; at: Pt; label: string; since: number; heading: number };

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
let message: { text: string; kind: 'error' | 'info'; until: number } | null = null;
let pendingPoint: { p: OverlayPoint; label: string } | null = null;
/** Arrows, boxes and circles from the answer, with when each arrived. */
let drawings: { d: OverlayDrawing; at: number }[] = [];
/** How long a drawing stays up, and how long it takes to draw itself / fade out. */
const DRAWING_MS = 14000;
const DRAW_IN_MS = 450;
const FADE_MS = 600;

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

function startFlight(to: Pt, then: 'point' | 'follow', label = ''): void {
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

/** Listening: soft rings breathe out from the triangle, stronger the louder the user speaks. */
function drawPulse(at: Pt, now: number): void {
  const base = SIZES[config.size] * 0.7;
  ctx.save();
  ctx.strokeStyle = color();
  ctx.shadowColor = color();
  ctx.shadowBlur = 8;
  for (let i = 0; i < 3; i++) {
    const t = (((now / 900 + i / 3) % 1) + 1) % 1;
    ctx.globalAlpha = (1 - t) * (0.25 + pulseLevel * 0.75);
    ctx.lineWidth = 2 - t;
    ctx.beginPath();
    ctx.arc(at.x, at.y, base + t * (10 + pulseLevel * 26), 0, Math.PI * 2);
    ctx.stroke();
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

function drawBubble(text: string, anchor: Pt, kind: 'label' | 'error' | 'info'): void {
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
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = kind === 'error' ? 'rgba(60, 14, 10, 0.92)' : 'rgba(20, 22, 28, 0.9)';
  roundRect(x, y, w, h, 8);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = kind === 'error' ? 'rgba(255,120,100,0.7)' : kind === 'label' ? color() : 'rgba(255,255,255,0.25)';
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + 12, y + 7 + i * lineH));
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

/** Draw every live drawing, revealing each stroke over DRAW_IN_MS and fading out at the end. */
function drawShapes(now: number): void {
  drawings = drawings.filter((x) => now - x.at < DRAWING_MS);
  for (const { d, at } of drawings) {
    const age = now - at;
    const t = easeInOut(Math.min(1, age / DRAW_IN_MS));
    const alpha = Math.min(1, (DRAWING_MS - age) / FADE_MS);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color();
    ctx.fillStyle = color();
    ctx.shadowColor = color();
    ctx.shadowBlur = 10;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let anchor: Pt | null = null;
    const [a, b] = d.points;
    if (d.kind === 'box' && a && b) {
      const w = b.x - a.x;
      const h = b.y - a.y;
      const per = 2 * (Math.abs(w) + Math.abs(h));
      ctx.setLineDash([per * t, per]);
      roundRect(a.x - 4, a.y - 4, w + 8, h + 8, 8);
      ctx.stroke();
      anchor = { x: a.x, y: b.y + 4 };
    } else if (d.kind === 'circle' && a) {
      const r = (d.r ?? 20) + 4;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.stroke();
      anchor = { x: a.x + r * 0.7, y: a.y + r * 0.7 };
    } else if (d.kind === 'arrow' && a && b) {
      const end = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      // A gentle curve reads as a gesture rather than a ruler line.
      const mx = (a.x + end.x) / 2;
      const my = (a.y + end.y) / 2;
      const len = Math.hypot(end.x - a.x, end.y - a.y) || 1;
      const c = { x: mx - ((end.y - a.y) / len) * len * 0.12, y: my + ((end.x - a.x) / len) * len * 0.12 };
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, end.x, end.y);
      ctx.stroke();
      if (t > 0.6) {
        const ang = Math.atan2(end.y - c.y, end.x - c.x);
        const head = 12;
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(end.x - head * Math.cos(ang - 0.45), end.y - head * Math.sin(ang - 0.45));
        ctx.lineTo(end.x - head * Math.cos(ang + 0.45), end.y - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      anchor = { x: a.x, y: a.y };
    }
    ctx.restore();
    if (anchor && d.label && config.showLabels && t >= 1) {
      ctx.save();
      ctx.globalAlpha = alpha;
      drawBubble(d.label, anchor, 'label');
      ctx.restore();
    }
  }
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

  if (mode.kind === 'follow') {
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
  } else if (mode.kind === 'fly') {
    const t = Math.min(1, (now - mode.start) / mode.dur);
    const e = easeInOut(t);
    pos = bezier(mode.from, mode.ctrl, mode.to, e);
    heading = bezierTangent(mode.from, mode.ctrl, mode.to, Math.max(0.02, Math.min(0.98, e)));
    angle = heading;
    scale = 1 + 0.35 * Math.sin(Math.PI * t);
    if (t >= 1) {
      if (mode.then === 'point' && pendingPoint) {
        mode = { kind: 'point', at: mode.to, label: pendingPoint.label, since: now, heading };
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
    if (config.showLabels && mode.label) drawBubble(mode.label, mode.at, 'label');
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
    trace = spin % 1;
  } else {
    spin = 0;
  }
  pulseLevel += (Math.min(1, level * 1.6) - pulseLevel) * Math.min(1, dt / 90);
  if (state === 'listening') scale *= 1 + 0.08 * pulseLevel;
  if (state === 'speaking' && mode.kind === 'follow') scale *= 1 + 0.05 * Math.sin(now / 180);

  drawShapes(now);
  if (visible && pos) {
    if (state === 'listening' && mode.kind === 'follow') drawPulse(pos, now);
    drawTriangle(pos, heading, scale, config.paused ? 0.4 : 1, trace);
  }
  if (message && now > message.until) message = null;
  if (message && pos) drawBubble(message.text, pos, message.kind);

  // Stop the loop when nothing is moving; the last frame stays on the canvas until the next input.
  const resting = state === 'idle' || state === 'cancelled' || state === 'error';
  const settled =
    mode.kind === 'follow' &&
    (!visible || (pos !== null && target !== null && Math.hypot(target.x - pos.x, target.y - pos.y) < 0.3));
  // A message only keeps the loop alive while it's visible here (the cursor may be on another display).
  if (!settled || !resting || drawings.length > 0 || (message !== null && pos !== null)) requestAnimationFrame(frame);
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
    message = null;
    drawings = [];
  }
  kick();
});

window.clicky.onPoint((p) => {
  startFlight({ x: p.x, y: p.y }, 'point', p.label);
  kick();
});

window.clicky.onAnchor((a) => {
  anchor = a;
  kick();
});

window.clicky.onDraw((d) => {
  drawings.push({ d, at: performance.now() });
  kick();
});

window.clicky.onMessage((m: OverlayMessage) => {
  message = { ...m, until: performance.now() + Math.min(9000, 3500 + m.text.length * 45) };
  kick();
});

window.clicky.onLevel((l) => {
  level = l;
});

window.clicky.onConfig((c) => {
  config = c;
  kick();
});
