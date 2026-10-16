import { describe, expect, it } from 'vitest';
import type { CaptureGeometry } from './coordinates.js';
import {
  GUIDE_DEFAULTS,
  GuideSession,
  guideFollowUpQuestion,
  hitDistance,
  isHit,
  mapGuideTag,
  screenSettled,
  type GuideTarget,
  type HitArea,
} from './guide.js';

const target = (over: Partial<GuideTarget> = {}): GuideTarget => ({
  kind: 'click',
  at: { displayId: 1, local: { x: 100, y: 100 }, global: { x: 100, y: 100 } },
  radius: 20,
  label: 'Add Modifier',
  instruction: 'Click Add Modifier to open the list.',
  ...over,
});
const area: HitArea = { x: 100, y: 100, r: 20 };

describe('hit testing', () => {
  it('counts clicks inside the ring plus a small tolerance', () => {
    expect(isHit(area, 100, 100)).toBe(true);
    expect(isHit(area, 125, 100)).toBe(true); // 25 ≤ 20 + 6
    expect(isHit(area, 127, 100)).toBe(false);
  });

  it("counts any click inside the control's box, even outside the ring", () => {
    const wide: HitArea = { x: 100, y: 100, r: 10, box: { x: 40, y: 90, width: 200, height: 20 } };
    expect(hitDistance(wide, 230, 105)).toBe(0);
    expect(isHit(wide, 230, 105)).toBe(true);
    expect(isHit(wide, 230, 130)).toBe(false);
  });
});

describe('mapGuideTag', () => {
  const caps: CaptureGeometry[] = [
    {
      display: { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      imageWidth: 1280,
      imageHeight: 720,
    },
    // A 150% screen to the left of the primary: negative origin, mixed DPI.
    {
      display: { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
      imageWidth: 1280,
      imageHeight: 720,
    },
  ];

  it('maps the centre like POINT and the radius in thousandths of the display width', () => {
    const r = mapGuideTag({ kind: 'click', x: 500, y: 500, r: 20, label: 'Save', screen: null }, caps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.target.at.global.x).toBeCloseTo(960, 0);
    expect(r.target.radius).toBeCloseTo(38.4, 1);
  });

  it('works on a negative-origin, mixed-DPI screen', () => {
    const r = mapGuideTag({ kind: 'hover', x: 0, y: 0, r: 30, label: 'File', screen: 2 }, caps);
    expect(r.ok && r.target.at.global.x).toBe(-1280);
    expect(r.ok && r.target.at.displayId).toBe(2);
    expect(r.ok && r.target.kind).toBe('hover');
  });

  it('uses a default radius when none was given and clamps silly ones', () => {
    const none = mapGuideTag({ kind: 'click', x: 500, y: 500, r: null, label: '', screen: null }, caps);
    expect(none.ok && none.target.radius).toBeCloseTo((GUIDE_DEFAULTS.defaultRadius / 1000) * 1920, 1);
    expect(none.ok && none.target.label).toBe('here');
    const huge = mapGuideTag({ kind: 'click', x: 500, y: 500, r: 900, label: 'x', screen: null }, caps);
    expect(huge.ok && huge.target.radius).toBe(GUIDE_DEFAULTS.maxRadiusDip);
    const tiny = mapGuideTag({ kind: 'click', x: 500, y: 500, r: 0.1, label: 'x', screen: null }, caps);
    expect(tiny.ok && tiny.target.radius).toBe(GUIDE_DEFAULTS.minRadiusDip);
  });

  it('rejects out-of-bounds centres and unknown screens', () => {
    expect(mapGuideTag({ kind: 'click', x: 1500, y: 500, r: 20, label: 'x', screen: null }, caps).ok).toBe(false);
    expect(mapGuideTag({ kind: 'click', x: 500, y: 500, r: 20, label: 'x', screen: 3 }, caps).ok).toBe(false);
  });
});

describe('GuideSession', () => {
  it('advances only on a left click inside the ring', () => {
    const s = new GuideSession('how do I add a modifier', 'blender');
    expect(s.arm(target(), area, 0)).toBe(true);
    expect(s.input({ kind: 'move', x: 100, y: 100, at: 10 })).toEqual({ type: 'none' });
    expect(s.input({ kind: 'click', x: 100, y: 100, button: 'right', at: 20 })).toEqual({ type: 'none' });
    expect(s.input({ kind: 'click', x: 105, y: 95, at: 30 })).toEqual({ type: 'hit', distance: 7, hover: false });
    expect(s.stage).toBe('settling');
    expect(s.previous?.label).toBe('Add Modifier');
    expect(s.history[0]).toContain('Clicked "Add Modifier"');
    expect(s.lastHitAt).toBe(30);
  });

  it('ends quietly on a click elsewhere and remembers the miss', () => {
    const s = new GuideSession('goal', null);
    s.arm(target(), area, 0);
    expect(s.input({ kind: 'click', x: 400, y: 400, at: 5 })).toMatchObject({ type: 'miss' });
    expect(s.stage).toBe('ended');
    expect(s.endReason).toBe('off-target');
    expect(s.history.at(-1)).toContain('clicked somewhere else');
    expect(s.input({ kind: 'click', x: 100, y: 100, at: 6 })).toEqual({ type: 'none' });
  });

  it('drops an untouched target silently after the idle timeout', () => {
    const s = new GuideSession('goal', null, { idleTimeoutMs: 1000 });
    s.arm(target(), area, 0);
    expect(s.tick(999)).toEqual({ type: 'none' });
    expect(s.tick(1000)).toEqual({ type: 'idle' });
    expect(s.endReason).toBe('idle');
  });

  it('completes a hover target after the pointer rests inside it', () => {
    const s = new GuideSession('goal', null, { hoverRestMs: 500 });
    s.arm(target({ kind: 'hover' }), area, 0);
    expect(s.input({ kind: 'move', x: 100, y: 100, at: 100 })).toEqual({ type: 'none' });
    // Leaving resets the rest.
    s.input({ kind: 'move', x: 300, y: 300, at: 300 });
    s.input({ kind: 'move', x: 101, y: 101, at: 400 });
    expect(s.tick(800)).toEqual({ type: 'none' });
    expect(s.tick(900)).toEqual({ type: 'hit', distance: 0, hover: true });
    expect(s.history[0]).toContain('Hovered');
  });

  it('enforces the round limit in code', () => {
    const s = new GuideSession('goal', null, { maxRounds: 2 });
    expect(s.arm(target(), area, 0)).toBe(true);
    s.input({ kind: 'click', x: 100, y: 100, at: 1 });
    expect(s.remaining).toBe(1);
    expect(s.arm(target(), area, 2)).toBe(true);
    s.input({ kind: 'click', x: 100, y: 100, at: 3 });
    expect(s.remaining).toBe(0);
    expect(s.canArm()).toBe(false);
    expect(s.arm(target(), area, 4)).toBe(false);
  });

  it('refreshes at most once per step when the user acts while the next step is worked out', () => {
    const s = new GuideSession('goal', null);
    s.arm(target(), area, 0);
    s.input({ kind: 'click', x: 100, y: 100, at: 1 });
    s.asking();
    expect(s.shouldRefresh()).toBe(false);
    expect(s.input({ kind: 'click', x: 500, y: 500, at: 2 })).toEqual({ type: 'acted' });
    expect(s.shouldRefresh()).toBe(true);
    s.input({ kind: 'click', x: 500, y: 500, at: 3 });
    expect(s.shouldRefresh()).toBe(false);
    // The next armed step gets a fresh allowance.
    s.arm(target(), area, 4);
    s.input({ kind: 'click', x: 100, y: 100, at: 5 });
    s.asking();
    s.input({ kind: 'click', x: 500, y: 500, at: 6 });
    expect(s.shouldRefresh()).toBe(true);
  });

  it('follows an app switch the click caused, and treats a late one as the user leaving', () => {
    const s = new GuideSession('goal', 'explorer', { graceMs: 1500 });
    s.arm(target(), area, 0);
    s.input({ kind: 'click', x: 100, y: 100, at: 1000 });
    expect(s.appChanged('Explorer', 1200)).toBe('same');
    expect(s.appChanged('SystemSettings', 2000)).toBe('followed');
    expect(s.app).toBe('SystemSettings');
    expect(s.appChanged('chrome', 9000)).toBe('left');
    expect(s.appChanged(null, 9000)).toBe('same');
  });

  it('parks after a step with no target and resumes on "next"', () => {
    const s = new GuideSession('goal', null, { parkMs: 1000 });
    s.arm(target(), area, 0);
    s.input({ kind: 'click', x: 100, y: 100, at: 1 });
    s.park('Type your name in the box.', 10);
    expect(s.stage).toBe('parked');
    expect(s.resumes('what is the capital of France', 20)).toBe(false);
    expect(s.resumes('Okay, next', 20)).toBe(true);
    expect(s.stage).toBe('settling');
    expect(s.previous?.kind).toBe('manual');
    expect(guideFollowUpQuestion(s)).toContain('Type your name in the box.');
  });

  it('a parked walkthrough expires', () => {
    const s = new GuideSession('goal', null, { parkMs: 1000 });
    s.park('x', 0);
    expect(s.resumes('next', 1001)).toBe(false);
    s.tick(1001);
    expect(s.endReason).toBe('done');
  });
});

describe('guideFollowUpQuestion', () => {
  it('states the goal, the step, the history, the freshness update and the budget', () => {
    const s = new GuideSession('how do I turn on dark mode', null, { maxRounds: 3 });
    s.arm(target({ label: 'Settings' }), area, 0);
    s.input({ kind: 'click', x: 100, y: 100, at: 1 });
    s.asking();
    s.input({ kind: 'click', x: 1, y: 1, at: 2 });
    const q = guideFollowUpQuestion(s);
    expect(q).toContain('how do I turn on dark mode');
    expect(q).toContain('guided step 2 of at most 3');
    expect(q).toContain('clicked inside the target "Settings"');
    expect(q).toContain('Clicked "Settings"');
    expect(q).toContain('clicked again while you were thinking');
    expect(q).toContain('at most 2 more targets');
  });

  it('forbids targets when the budget is spent', () => {
    const s = new GuideSession('goal', null, { maxRounds: 1 });
    s.arm(target(), area, 0);
    s.input({ kind: 'click', x: 100, y: 100, at: 1 });
    expect(guideFollowUpQuestion(s)).toContain('may not ring any more targets');
  });
});

describe('screenSettled', () => {
  it('compares screenshots by size within a tolerance', () => {
    expect(screenSettled([100_000], [100_900])).toBe(true);
    expect(screenSettled([100_000], [110_000])).toBe(false);
    expect(screenSettled([100_000, 50_000], [100_000])).toBe(false);
    expect(screenSettled([], [])).toBe(false);
  });
});
