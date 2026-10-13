import { describe, expect, it } from 'vitest';
import {
  parseSketch,
  parseSketchCheck,
  placeSketch,
  sketchKey,
  sketchSubject,
  sketchToSvg,
  sketchUnclear,
  smooth,
} from './sketch.js';

describe('sketchSubject', () => {
  it('finds the thing to draw', () => {
    expect(sketchSubject('Clicky, draw a bird')).toBe('a bird');
    expect(sketchSubject('can you sketch a right-angled triangle on my screen?')).toBe('a right-angled triangle');
    expect(sketchSubject('Draw me a parrot sitting on a branch.')).toBe('a parrot sitting on a branch');
  });

  it('leaves annotations and app tasks alone', () => {
    expect(sketchSubject('draw a box around the taskbar')).toBeNull();
    expect(sketchSubject('draw an arrow pointing at the save button')).toBeNull();
    expect(sketchSubject('draw a house in Paint')).toBeNull();
    expect(sketchSubject('what is a bird')).toBeNull();
  });
});

describe('parseSketch', () => {
  it('reads strokes, closes closed shapes, clamps to the canvas and drops repeats', () => {
    const s = parseSketch(
      'Here: {"subject":"a right-angled triangle","strokes":[{"part":"sides","points":[[200,800],[200,200],[200,200],[800,800]],"closed":true},{"part":"corner","points":[[200,740],[260,740],[260,800]]},{"part":"bad","points":[[5,"x"]]}],"labels":[{"x":150,"y":500,"text":"a"},{"x":1,"y":2}]}',
    );
    expect(s?.subject).toBe('a right-angled triangle');
    expect(s?.strokes).toHaveLength(2);
    expect(s?.strokes[0]?.points).toEqual([
      { x: 200, y: 800 },
      { x: 200, y: 200 },
      { x: 800, y: 800 },
      { x: 200, y: 800 },
    ]);
    expect(s?.labels).toEqual([{ x: 150, y: 500, text: 'a' }]);
    expect(parseSketch('{"strokes":[{"points":[[1200,-5],[3,4]]}]}')?.strokes[0]?.points[0]).toEqual({ x: 1000, y: 0 });
    expect(parseSketch('no drawing')).toBeNull();
  });
});

describe('placing and checking', () => {
  const sketch = {
    subject: 'a line',
    strokes: [
      {
        part: 'line',
        points: [
          { x: 0, y: 0 },
          { x: 1000, y: 1000 },
        ],
      },
    ],
    labels: [{ x: 500, y: 500, text: 'mid' }],
  };

  it('draws in a square in the middle of the display, keeping proportions', () => {
    const marks = placeSketch(sketch, { id: 7, width: 2000, height: 1000 }, 0.5);
    expect(marks[0]).toEqual({
      displayId: 7,
      kind: 'path',
      points: [
        { x: 750, y: 250 },
        { x: 1250, y: 750 },
      ],
      label: '',
    });
    expect(marks[1]).toEqual({ displayId: 7, kind: 'text', points: [{ x: 1000, y: 500 }], label: 'mid' });
  });

  it('renders SVG and reads the verdict', () => {
    const svg = sketchToSvg(sketch, 100);
    expect(svg).toContain('<polyline points="0,0 100,100"/>');
    expect(svg).toContain('>mid</text>');
    expect(parseSketchCheck('{"ok": true}')).toEqual({ ok: true, fixes: '' });
    expect(parseSketchCheck('{"ok":false,"looks_like":"a fish","fixes":"add wings and a beak"}')).toEqual({
      ok: false,
      fixes: 'It looks like a fish. add wings and a beak',
    });
    expect(sketchKey('A Parrot!')).toBe('parrot');
  });
});

describe('smooth', () => {
  it('rounds a curve, keeping the ends of an open stroke', () => {
    const open = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 0 },
    ];
    const s = smooth(open, false);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 200, y: 0 });
    expect(s.length).toBeGreaterThan(10);
    // The sharp tip is cut: no point reaches y = 100 any more.
    expect(Math.max(...s.map((p) => p.y))).toBeLessThan(100);
  });

  it('smooths strokes marked smooth when parsing', () => {
    const sk = parseSketch('{"strokes":[{"points":[[0,0],[500,1000],[1000,0]],"closed":true,"smooth":true}]}');
    const pts = sk?.strokes[0]?.points ?? [];
    expect(pts.length).toBeGreaterThan(20);
    expect(pts[0]).toEqual(pts[pts.length - 1]);
  });
});

describe('sketchSubject with places in the picture', () => {
  it('keeps "next to" and "on a branch" as part of the picture', () => {
    expect(sketchSubject('Clicky, draw a house with a tree next to it.')).toBe('a house with a tree next to it');
    expect(sketchSubject('draw a parrot on a branch')).toBe('a parrot on a branch');
    expect(sketchSubject('draw a circle around the save button')).toBeNull();
    expect(sketchSubject('draw a line under the title')).toBeNull();
  });
});

describe('sketchUnclear', () => {
  it('reads the question for a misheard subject', () => {
    expect(sketchUnclear('{"unclear": "Did you mean an owl?"}')).toBe('Did you mean an owl?');
    expect(sketchUnclear('{"strokes": []}')).toBeNull();
  });
});

describe('sketchSubject with a pronoun', () => {
  it('leaves "draw it" to the answer, which knows the conversation', () => {
    expect(sketchSubject('Clicky, draw it.')).toBeNull();
    expect(sketchSubject('draw everything')).toBeNull();
    expect(sketchSubject('draw that again')).toBeNull();
  });
});
