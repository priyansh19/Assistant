import { describe, expect, it } from 'vitest';
import { actionGoal, parseAgentAction, runAgent } from './agent.js';
import type { CaptureGeometry } from './coordinates.js';
import { MAX_DRAWINGS } from './pipeline/answer-runner.js';
import { MAX_PATH_TAG_LENGTH, PointStreamParser, type ParserEvent } from './point-parser.js';
import type { CapturePort, InputAction, OverlayPort, ScreenCapture } from './ports.js';
import { buildSystemPrompt } from './prompt.js';
import type { VisionChatProvider } from './providers.js';
import {
  arcPoints,
  drawingDemo,
  formatDrawTag,
  mapShapeToDisplay,
  MAX_PATH_POINTS,
  MAX_TEXT_LENGTH,
  parseDrawTag,
  scaleShape,
  shapeOnDisplay,
  type DrawShape,
} from './shapes.js';

describe('freehand, highlight and handwriting marks', () => {
  it('parses PATH with spaces, semicolons and loose spacing', () => {
    const want = {
      kind: 'path',
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
        { x: 50.5, y: 60 },
      ],
      label: 'tick',
      screen: 2,
    };
    expect(parseDrawTag('[PATH:10,20 30,40 50.5,60:tick:screen2]')).toEqual(want);
    expect(parseDrawTag('[path: 10, 20; 30 ,40;50.5,60 :tick:screen2]')).toEqual(want);
  });

  it('drops repeated points and rejects bad paths', () => {
    expect(parseDrawTag('[PATH:1,1 1,1 5,5]')).toMatchObject({
      points: [
        { x: 1, y: 1 },
        { x: 5, y: 5 },
      ],
    });
    expect(parseDrawTag('[PATH:1,1]')).toBeNull(); // one point is not a line
    expect(parseDrawTag('[PATH:1,1 1,1]')).toBeNull();
    expect(parseDrawTag('[PATH:1,1 2]')).toBeNull(); // odd number of values
    expect(parseDrawTag('[PATH:a,b c,d]')).toBeNull();
    expect(parseDrawTag('[PATH:1,1 2,2:x:screen0]')).toBeNull();
    const many = Array.from({ length: MAX_PATH_POINTS + 1 }, (_, i) => `${i},${i}`).join(' ');
    expect(parseDrawTag(`[PATH:${many}]`)).toBeNull();
  });

  it('parses HIGHLIGHT like a box and TEXT with its words', () => {
    expect(parseDrawTag('[HIGHLIGHT:10,20,300,30:the total]')).toEqual({
      kind: 'highlight',
      x: 10,
      y: 20,
      w: 300,
      h: 30,
      label: 'the total',
      screen: null,
    });
    expect(parseDrawTag('[TEXT:100,50:Step 1: open Settings]')).toEqual({
      kind: 'text',
      x: 100,
      y: 50,
      label: 'Step 1: open Settings',
      screen: null,
    });
    expect(parseDrawTag('[TEXT:100,50]')).toBeNull(); // nothing to write
    expect(parseDrawTag('[HIGHLIGHT:1,1,0,5]')).toBeNull();
    const long = parseDrawTag(`[TEXT:1,1:${'a'.repeat(200)}]`);
    expect(long?.label).toHaveLength(MAX_TEXT_LENGTH);
  });

  it('writes every kind back as a tag that parses to the same shape', () => {
    for (const s of drawingDemo()) expect(parseDrawTag(formatDrawTag(s))).toEqual(s);
    const onScreen2: DrawShape = { kind: 'arrow', x1: 1, y1: 2, x2: 3, y2: 4, label: '', screen: 2 };
    expect(parseDrawTag(formatDrawTag(onScreen2))).toEqual(onScreen2);
  });
});

describe('streaming drawings out of speech', () => {
  function run(chunks: string[]): ParserEvent[] {
    const p = new PointStreamParser();
    return chunks.flatMap((c) => p.push(c)).concat(p.end());
  }
  const spoken = (ev: ParserEvent[]): string => ev.map((e) => (e.type === 'text' ? e.text : '')).join('');

  it('keeps a long PATH, TEXT and HIGHLIGHT out of speech at every split point', () => {
    const star = drawingDemo().find((s) => s.kind === 'path' && s.label === 'a star');
    expect(star).toBeDefined();
    const text = `[POINT:none]${formatDrawTag(star as DrawShape)}[TEXT:80,110:Hi there][HIGHLIGHT:0,945,1000,55] I drew a star.`;
    for (let i = 1; i < text.length; i++) {
      const ev = run([text.slice(0, i), text.slice(i)]);
      expect(spoken(ev)).toBe(' I drew a star.');
      expect(ev.filter((e) => e.type === 'draw').map((e) => e.type === 'draw' && e.shape.kind)).toEqual([
        'path',
        'text',
        'highlight',
      ]);
    }
  });

  it('streams a whole sketch token by token', () => {
    const tags = drawingDemo().map(formatDrawTag).join('');
    const tokens = (tags + ' Done.').match(/.{1,3}/gs) ?? [];
    const ev = run(tokens);
    expect(spoken(ev)).toBe(' Done.');
    expect(ev.filter((e) => e.type === 'draw')).toHaveLength(drawingDemo().length);
  });

  it('a PATH opening that never closes is released as text', () => {
    const prose = `[PATH: ${'1,'.repeat(MAX_PATH_TAG_LENGTH)} and so on`;
    expect(spoken(run([prose]))).toBe(prose);
  });
});

describe('placing marks on the display', () => {
  const captures: CaptureGeometry[] = [
    {
      display: { id: 7, bounds: { x: -1536, y: 0, width: 1536, height: 960 }, scaleFactor: 1.25 },
      imageWidth: 1280,
      imageHeight: 800,
    },
  ];

  it('maps every point of a path and the corner of a note (negative origin, 125 %)', () => {
    const path = mapShapeToDisplay(
      {
        kind: 'path',
        points: [
          { x: 0, y: 0 },
          { x: 640, y: 400 },
          { x: 1280, y: 800 },
        ],
        label: '',
        screen: null,
      },
      captures,
    );
    expect(path.ok && path.shape.points).toEqual([
      { x: 0, y: 0 },
      { x: 768, y: 480 },
      { x: 1534.8, y: 958.8 }, // the image's last pixel, mapped
    ]);
    const note = mapShapeToDisplay({ kind: 'text', x: 128, y: 80, label: 'hi', screen: null }, captures);
    expect(note.ok && note.shape).toEqual({ displayId: 7, kind: 'text', points: [{ x: 153.6, y: 96 }], label: 'hi' });
  });

  it('scales thousandths and places a built-in sketch without a screenshot', () => {
    const s = scaleShape({ kind: 'circle', x: 500, y: 500, r: 100, label: '', screen: null }, 1.92, 1.08);
    expect(s).toEqual({ kind: 'circle', x: 960, y: 540, r: 192, label: '', screen: null });
    expect(shapeOnDisplay(s, 3)).toEqual({
      displayId: 3,
      kind: 'circle',
      points: [{ x: 960, y: 540 }],
      r: 192,
      label: '',
    });
  });

  it('the example sketch stays on screen, within the per-answer limit, at any aspect ratio', () => {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9, 9 / 16]) {
      const demo = drawingDemo(aspect);
      expect(demo.length).toBeLessThanOrEqual(MAX_DRAWINGS);
      expect(new Set(demo.map((s) => s.kind))).toEqual(new Set(['text', 'path', 'circle', 'arrow', 'highlight']));
      for (const s of demo) {
        const t = formatDrawTag(s);
        for (const n of (t.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)) {
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(1000);
        }
      }
    }
  });

  it('arcPoints spans the arc and respects the point limit', () => {
    const pts = arcPoints(0, 0, 10, 10, 0, Math.PI, 500);
    expect(pts).toHaveLength(MAX_PATH_POINTS);
    expect(pts[0]).toEqual({ x: 10, y: 0 });
    expect(pts[pts.length - 1]?.x).toBeCloseTo(-10);
  });
});

describe('the answer prompt teaches drawing', () => {
  it('lists every mark and says Clicky can draw', () => {
    const p = buildSystemPrompt({ screens: [{ index: 1, imageWidth: 1280, imageHeight: 800, hasCursor: true }] });
    for (const tag of ['[BOX:', '[ARROW:', '[CIRCLE:', '[HIGHLIGHT:', '[PATH:', '[TEXT:']) expect(p).toContain(tag);
    expect(p).toContain("never say you can't");
  });
});

describe('drawing inside apps (agent drag)', () => {
  it('reads a drag path as pairs or objects and rejects bad ones', () => {
    expect(parseAgentAction('{"action":"drag","path":[[1,2],[3,4]],"say":"Drawing"}')).toEqual({
      ok: true,
      action: {
        type: 'drag',
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        screen: null,
        say: 'Drawing',
        risky: false,
      },
    });
    const viaObjects = parseAgentAction('{"action":"drag","from":{"x":1,"y":2},"to":{"x":5,"y":6},"screen":2}');
    expect(viaObjects.ok && viaObjects.action).toMatchObject({ type: 'drag', screen: 2, path: [{ x: 1 }, { x: 5 }] });
    expect(parseAgentAction('{"action":"drag","path":[[1,2]]}').ok).toBe(false);
    expect(parseAgentAction('{"action":"drag","path":[[1,"a"],[3,4]]}').ok).toBe(false);
  });

  it('sends drawing in an app to agent mode, but not drawing on the screen', () => {
    expect(actionGoal('draw a house in Paint')).toBe('draw a house in Paint');
    expect(actionGoal('Can you sketch a cat using MS Paint')).toBe('sketch a cat using MS Paint');
    expect(actionGoal('Clicky, draw a smiley on the whiteboard')).toBe('draw a smiley on the whiteboard');
    expect(actionGoal('draw a circle around the save button')).toBeNull();
    expect(actionGoal('draw a smiley on my screen')).toBeNull();
    expect(actionGoal('how do I draw in Paint')).toBeNull();
  });

  it('maps every point of a stroke to the display and flies there first', async () => {
    const screen: ScreenCapture = {
      images: [{ data: new Uint8Array(), mediaType: 'image/jpeg', width: 1000, height: 500 }],
      geometry: [
        {
          display: { id: 1, bounds: { x: 0, y: 0, width: 2000, height: 1000 }, scaleFactor: 1 },
          imageWidth: 1000,
          imageHeight: 500,
        },
      ],
      cursorScreen: 1,
    };
    const replies = [
      '{"action":"drag","path":[[100,100],[500,500],[900,100]],"say":"Drawing a V"}',
      '{"action":"drag","path":[[100,100],[1500,100]],"say":"Off the canvas","check":"worked"}',
      '{"action":"done","say":"I drew a V.","check":"worked"}',
      '{"action":"done","say":"I drew a V.","check":"worked"}',
    ];
    const inputs: InputAction[] = [];
    const points: string[] = [];
    const chat: VisionChatProvider = {
      id: 'fake',
      async *stream() {
        yield replies.shift() ?? '{"action":"done","say":"Done.","check":"worked"}';
      },
    };
    const capture: CapturePort = { begin: () => undefined, take: async () => screen };
    const overlay: OverlayPort = {
      state: () => undefined,
      point: (p, label) => void points.push(`${p.global.x},${p.global.y} ${label}`),
      message: () => undefined,
    };
    const r = await runAgent('draw a V in Paint', {
      chat,
      capture,
      overlay,
      input: { run: async (a) => void inputs.push(a) },
      confirm: async () => true,
      confirmMode: 'risky',
      signal: new AbortController().signal,
      settleMs: 0,
      flightMs: 0,
    });
    expect(r.outcome).toBe('done');
    expect(inputs).toHaveLength(1);
    const drag = inputs[0];
    expect(drag?.kind === 'drag' && drag.path.map((p) => p.global)).toEqual([
      { x: 200, y: 100 },
      { x: 1000, y: 500 },
      { x: 1800, y: 100 },
    ]);
    expect(points[0]).toBe('200,100 Drawing a V');
    expect(r.steps.some((s) => s.includes('was off screen'))).toBe(true);
  });
});
