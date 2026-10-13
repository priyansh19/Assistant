/**
 * Drawing things on the screen ("draw a bird", "draw a right-angled triangle"): instead of a dozen
 * marks squeezed into a spoken answer, the model works like an illustrator. It names the subject's
 * parts, then draws them as many-point strokes on a square canvas; Clicky renders that, shows it to
 * the model to check it really looks like the subject, redraws once or twice if not, and keeps the
 * drawings that passed so the same subject is right straight away next time (learning by doing).
 */

import type { MappedShape } from './shapes.js';

/** A canvas point, 0–1000 across and down (a square: the drawing keeps its proportions). */
export interface SketchPoint {
  x: number;
  y: number;
}

export interface SketchStroke {
  /** What part of the subject this is ("beak", "hypotenuse"). */
  part: string;
  points: SketchPoint[];
}

export interface Sketch {
  subject: string;
  strokes: SketchStroke[];
  /** Words written on the drawing (side names, a caption), top-left corner at x,y. */
  labels: { x: number; y: number; text: string }[];
}

/** Most strokes and points per stroke: room for feathers and fingers, not for scribbling over the screen. */
export const MAX_STROKES = 60;
export const MAX_STROKE_POINTS = 120;

export const SKETCH_PROMPT = `You are Clicky's illustrator. Clicky lives next to the user's mouse pointer and draws on
their screen with a pen, one stroke at a time. Draw the subject the user asked for so that anyone
recognises it at a glance: a clean, confident line illustration, not a doodle.

Work on a square canvas 1000 wide and 1000 tall (x to the right, y down).

First think, then draw:
1. What makes this subject recognisable? Its overall silhouette, proportions and the few features
   people look for (a bird: a plump teardrop body, a round head, a pointed beak, an eye, a folded
   wing on the body, tail feathers, thin legs with toes; a cat: pointed ears, whiskers, a long
   curling tail). For a specific kind (a parrot, an owl, a hummingbird) draw what sets it apart (a
   hooked beak, big round eyes and ear tufts, a long thin bill).
2. Lay out the parts at their true sizes and positions relative to each other.
3. Draw each part as strokes.

Geometry is exact: a triangle is three straight sides through its three corners; a right-angled
triangle has two sides meeting at exactly 90 degrees (one straight across, one straight up or down)
with a small square drawn in that corner; a square has four equal sides; equal things are equal.
Circles and curves need many points (a circle at least 28, a gentle curve at least 10); straight
edges need only their ends.

Reply with ONLY one JSON object:
{"subject": "what you drew", "parts": ["body", "head", …],
 "strokes": [{"part": "body", "points": [[x,y], [x,y], …], "closed": true, "smooth": true}, …],
 "labels": [{"x": 0, "y": 0, "text": "a few words"}]}

- 6 to ${MAX_STROKES} strokes, each 2 to ${MAX_STROKE_POINTS} points. "closed": true joins the last point back to the first.
- "smooth": true turns a stroke into a smooth curve through its points: use it for every rounded
  part (bodies, heads, wings, leaves, waves); 8 to 16 well-placed points are enough then. Leave it
  off for straight edges and sharp corners (beaks, roofs, triangles, frames).
- Draw like an illustrator: graceful outlines, a body that flows into the head, details where the
  eye goes (an eye with a pupil, feather lines on a wing), feet that rest on the ground.
- Use most of the canvas: the subject spans about 650 to 900 units, centred.
- Labels only when the user asked for them or to explain something (the sides a, b, c of a triangle).
- No background, no shading, no frame.
- The request comes from speech recognition. If the subject isn't something that can be drawn (a
  misheard word like "now" or "parent" for "owl" or "parrot"), don't draw: reply
  {"unclear": "a short question naming what they most likely meant, like: Did you mean an owl?"}.`;

export const SKETCH_CHECK_PROMPT = `You check drawings Clicky made on the user's screen. The image is a line drawing that was meant
to show the subject below. Judge it like an art teacher: would an ordinary person recognise it
immediately as that subject, are its proportions and key features right, are the lines clean
(not blocky or scribbled), and is geometry exact for shapes? A crude drawing that is only just
recognisable is not ok. Be honest and specific.

Reply with ONLY one JSON object:
{"ok": true} if it clearly shows the subject, or
{"ok": false, "looks_like": "what it looks like instead", "fixes": "the most important changes, in one or two sentences"}.`;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The sketch in a model reply, or null if there isn't a usable one. */
export function parseSketch(reply: string): Sketch | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(reply.slice(start, end + 1));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const strokes: SketchStroke[] = [];
  for (const s of Array.isArray(o['strokes']) ? o['strokes'].slice(0, MAX_STROKES) : []) {
    if (typeof s !== 'object' || s === null) continue;
    const r = s as Record<string, unknown>;
    const points: SketchPoint[] = [];
    for (const p of Array.isArray(r['points']) ? r['points'].slice(0, MAX_STROKE_POINTS) : []) {
      const x = num(Array.isArray(p) ? p[0] : (p as Record<string, unknown> | null)?.['x']);
      const y = num(Array.isArray(p) ? p[1] : (p as Record<string, unknown> | null)?.['y']);
      if (x === null || y === null) continue;
      const q = { x: Math.max(0, Math.min(1000, x)), y: Math.max(0, Math.min(1000, y)) };
      const last = points[points.length - 1];
      if (!last || last.x !== q.x || last.y !== q.y) points.push(q);
    }
    const closed = r['closed'] === true && points.length >= 3;
    // Curves the model drew with a handful of points come out round instead of polygonal.
    const line = r['smooth'] === true && points.length >= 3 ? smooth(points, closed) : points;
    if (closed) {
      const [first] = line;
      const last = line[line.length - 1];
      if (first && last && (first.x !== last.x || first.y !== last.y)) line.push({ ...first });
    }
    if (line.length >= 2)
      strokes.push({ part: typeof r['part'] === 'string' ? r['part'].slice(0, 40) : '', points: line });
  }
  if (!strokes.length) return null;
  const labels: Sketch['labels'] = [];
  for (const l of Array.isArray(o['labels']) ? o['labels'].slice(0, 12) : []) {
    const r = (l ?? {}) as Record<string, unknown>;
    const x = num(r['x']);
    const y = num(r['y']);
    const text = typeof r['text'] === 'string' ? r['text'].trim().slice(0, 40) : '';
    if (x !== null && y !== null && text) labels.push({ x, y, text });
  }
  return { subject: typeof o['subject'] === 'string' ? o['subject'].slice(0, 80) : '', strokes, labels };
}

/**
 * A smooth curve through the points (Chaikin's corner cutting, three rounds): the ends stay put on
 * an open stroke; a closed one becomes a smooth loop.
 */
export function smooth(points: readonly SketchPoint[], closed: boolean): SketchPoint[] {
  let p = points.map((q) => ({ ...q }));
  if (closed) {
    const [a] = p;
    const b = p[p.length - 1];
    if (a && b && a.x === b.x && a.y === b.y) p = p.slice(0, -1);
  }
  for (let round = 0; round < 3 && p.length * 2 <= MAX_STROKE_POINTS * 2; round++) {
    const out: SketchPoint[] = [];
    const n = p.length;
    const segs = closed ? n : n - 1;
    if (!closed && p[0]) out.push(p[0]);
    for (let i = 0; i < segs; i++) {
      const a = p[i] as SketchPoint;
      const b = p[(i + 1) % n] as SketchPoint;
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    if (!closed && p[n - 1]) out.push(p[n - 1] as SketchPoint);
    p = out;
  }
  return p.map((q) => ({ x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 }));
}

/** The sketch as an SVG picture (black lines on white), to check it and to keep it. */
export function sketchToSvg(s: Sketch, size = 512): string {
  const k = size / 1000;
  const f = (n: number): string => (Math.round(n * k * 10) / 10).toString();
  const paths = s.strokes
    .map((st) => `<polyline points="${st.points.map((p) => `${f(p.x)},${f(p.y)}`).join(' ')}"/>`)
    .join('');
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = s.labels.map((l) => `<text x="${f(l.x)}" y="${f(l.y + 30)}">${esc(l.text)}</text>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="white"/>` +
    `<g fill="none" stroke="black" stroke-width="${Math.max(2, Math.round(4 * k))}" stroke-linecap="round" stroke-linejoin="round">${paths}</g>` +
    `<g font-family="Segoe UI, sans-serif" font-size="${Math.round(30 * k)}" fill="black">${text}</g></svg>`
  );
}

/** What to draw, if this asks Clicky to draw a thing ("draw a bird", "can you sketch a sailboat"). */
export function sketchSubject(question: string): string | null {
  const q = question
    .trim()
    .replace(/^\W*(?:hey\s+)?click(?:y|ey)\W+/i, '')
    .replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?|^please\s+/i, '');
  const m = /^(?:draw|sketch|doodle|illustrate)\s+(?:me\s+)?(.+?)\s*[.!?]*$/i.exec(q);
  if (!m?.[1]) return null;
  let what = m[1]
    .replace(/\s+(?:on|over|across)\s+(?:my|the|this)\s+screen\b.*$/i, '')
    .replace(/\s+(?:for me|here|please|in the middle|in the centre|in the center)\b.*$/i, '')
    .trim();
  // Marking the screen itself is an annotation, not a picture ("draw a box around the taskbar").
  // A picture can say 'next to' or 'on a branch'; an annotation is about something on screen.
  if (
    /\b(?:around|pointing (?:at|to)|over|under|across|through|next to|on top of|at)\s+(?:the|my|this|that)\s+(?:\w+\s+){0,2}?(?:button|taskbar|menu|icon|window|tab|text|link|bar|field|box|screen|title|word|line|row|image|picture|video|cursor|folder|file|app|page|header|sidebar)s?\b/i.test(
      what,
    ) ||
    /\b(?:pointing|arrow)\b/i.test(what)
  )
    return null;
  // Inside an app it's a task ("draw a house in Paint").
  if (/\b(?:in|into|on|using|with)\s+(?:the\s+)?(?:ms\s+)?(?:paint|whiteboard|excalidraw|canva|figma)\b/i.test(what))
    return null;
  what = what.replace(/^(?:something like|what looks like)\s+/i, '');
  if (what.length < 2 || what.split(/\s+/).length > 10) return null;
  return what;
}

/** The library key for a subject: "A Parrot!" and "parrot" are the same drawing. */
export function sketchKey(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/^(?:a|an|the|some|my)\s+/, '')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The sketch on a display: a square in the middle of it (side about 60% of the shorter edge), in
 * DIP relative to the display, as the overlay's path and text marks.
 */
export function placeSketch(
  s: Sketch,
  display: { id: number; width: number; height: number },
  scale = 0.6,
): MappedShape[] {
  const side = Math.min(display.width, display.height) * scale;
  const ox = (display.width - side) / 2;
  const oy = (display.height - side) / 2;
  const at = (p: SketchPoint): SketchPoint => ({
    x: Math.round((ox + (p.x / 1000) * side) * 10) / 10,
    y: Math.round((oy + (p.y / 1000) * side) * 10) / 10,
  });
  return [
    ...s.strokes.map((st) => ({ displayId: display.id, kind: 'path' as const, points: st.points.map(at), label: '' })),
    ...s.labels.map((l) => ({ displayId: display.id, kind: 'text' as const, points: [at(l)], label: l.text })),
  ];
}

/** The question to ask when the illustrator couldn't tell what to draw, or null. */
export function sketchUnclear(reply: string): string | null {
  const m = /"unclear"\s*:\s*"([^"]{3,200})"/.exec(reply);
  return m?.[1] ?? null;
}

/** The checker's verdict. */
export function parseSketchCheck(reply: string): { ok: boolean; fixes: string } {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  try {
    const o = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    const fixes = [o['looks_like'] ? `It looks like ${String(o['looks_like'])}.` : '', String(o['fixes'] ?? '')]
      .filter(Boolean)
      .join(' ');
    return { ok: o['ok'] === true, fixes: fixes.slice(0, 600) };
  } catch {
    // An unreadable verdict doesn't block the drawing.
    return { ok: true, fixes: '' };
  }
}
