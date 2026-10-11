import { describe, expect, it } from 'vitest';
import type { CaptureGeometry } from './coordinates.js';
import { PointStreamParser, type ParserEvent } from './point-parser.js';
import { mapShapeToDisplay, parseDrawTag } from './shapes.js';

describe('parseDrawTag', () => {
  it('parses boxes, arrows and circles with optional label and screen', () => {
    expect(parseDrawTag('[BOX:10,20,300,40:Toolbar]')).toEqual({
      kind: 'box',
      x: 10,
      y: 20,
      w: 300,
      h: 40,
      label: 'Toolbar',
      screen: null,
    });
    expect(parseDrawTag('[arrow:1,2,30,40:then here:screen2]')).toEqual({
      kind: 'arrow',
      x1: 1,
      y1: 2,
      x2: 30,
      y2: 40,
      label: 'then here',
      screen: 2,
    });
    expect(parseDrawTag('[CIRCLE: 50 , 60 , 12 ]')).toEqual({
      kind: 'circle',
      x: 50,
      y: 60,
      r: 12,
      label: '',
      screen: null,
    });
  });

  it('rejects wrong arity and degenerate shapes', () => {
    expect(parseDrawTag('[BOX:1,2,3]')).toBeNull();
    expect(parseDrawTag('[BOX:1,2,0,5]')).toBeNull();
    expect(parseDrawTag('[ARROW:5,5,5,5]')).toBeNull();
    expect(parseDrawTag('[CIRCLE:1,2,-3]')).toBeNull();
    expect(parseDrawTag('[CIRCLE:1,2,3:x:screen0]')).toBeNull();
  });
});

describe('PointStreamParser with drawings', () => {
  function run(chunks: string[]): ParserEvent[] {
    const p = new PointStreamParser();
    return chunks.flatMap((c) => p.push(c)).concat(p.end());
  }
  const spoken = (ev: ParserEvent[]): string => ev.map((e) => (e.type === 'text' ? e.text : '')).join('');

  it('keeps drawing tags out of speech at every split point', () => {
    const text = '[POINT:5,6:Save][ARROW:1,2,30,40:go][BOX:1,1,9,9] Click Save, then the arrow.';
    for (let i = 1; i < text.length; i++) {
      const ev = run([text.slice(0, i), text.slice(i)]);
      expect(spoken(ev)).toBe(' Click Save, then the arrow.');
      expect(ev.filter((e) => e.type === 'draw')).toHaveLength(2);
      expect(ev.filter((e) => e.type === 'point')).toHaveLength(1);
    }
  });

  it('releases prose that only looks like a tag opening', () => {
    expect(spoken(run(['Press [B', 'OX] now']))).toBe('Press [BOX] now');
    expect(spoken(run(['an [ARROW:', ' without end']))).toBe('an [ARROW: without end');
  });
});

describe('mapShapeToDisplay', () => {
  const captures: CaptureGeometry[] = [
    {
      display: { id: 7, bounds: { x: 0, y: 0, width: 1536, height: 960 }, scaleFactor: 1.25 },
      imageWidth: 1280,
      imageHeight: 800,
    },
  ];

  it('maps corners and radius into display DIP', () => {
    const box = mapShapeToDisplay({ kind: 'box', x: 0, y: 0, w: 640, h: 400, label: '', screen: null }, captures);
    expect(box).toEqual({
      ok: true,
      shape: {
        displayId: 7,
        kind: 'box',
        points: [
          { x: 0, y: 0 },
          { x: 768, y: 480 },
        ],
        label: '',
      },
    });
    const circle = mapShapeToDisplay({ kind: 'circle', x: 640, y: 400, r: 100, label: 'here', screen: null }, captures);
    expect(circle.ok && circle.shape.r).toBeCloseTo(120);
  });

  it('clamps a box that runs off the image and rejects unknown screens', () => {
    const r = mapShapeToDisplay({ kind: 'box', x: 1200, y: 700, w: 400, h: 400, label: '', screen: null }, captures);
    expect(r.ok && r.shape.points[1]).toEqual({ x: 1534.8, y: 958.8 });
    expect(mapShapeToDisplay({ kind: 'circle', x: 1, y: 1, r: 2, label: '', screen: 3 }, captures).ok).toBe(false);
  });
});
