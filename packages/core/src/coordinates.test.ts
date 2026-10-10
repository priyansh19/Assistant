import { describe, expect, it } from 'vitest';
import {
  downscaledSize,
  mapPointToDisplay,
  physicalSize,
  type CaptureGeometry,
  type DisplayGeometry,
} from './coordinates.js';

// The owner's laptop: 1920x1200 panel at 125% = 1536x960 DIP.
const laptop: DisplayGeometry = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 960 }, scaleFactor: 1.25 };
// A 4K monitor at 150% placed to the LEFT of the primary (negative origin).
const left4k: DisplayGeometry = { id: 2, bounds: { x: -2560, y: -200, width: 2560, height: 1440 }, scaleFactor: 1.5 };
// A 1080p monitor at 100% above the primary.
const above: DisplayGeometry = { id: 3, bounds: { x: 0, y: -1080, width: 1920, height: 1080 }, scaleFactor: 1 };

function capture(display: DisplayGeometry, maxLongEdge = 1280): CaptureGeometry {
  const phys = physicalSize(display);
  const { width, height } = downscaledSize(phys.width, phys.height, maxLongEdge);
  return { display, imageWidth: width, imageHeight: height };
}

describe('downscaledSize', () => {
  it('scales the long edge down and never up', () => {
    expect(downscaledSize(1920, 1200, 1280)).toEqual({ width: 1280, height: 800, scale: 1280 / 1920 });
    expect(downscaledSize(800, 600, 1280)).toEqual({ width: 800, height: 600, scale: 1 });
    expect(downscaledSize(1200, 1920, 1280)).toMatchObject({ width: 800, height: 1280 });
  });
});

describe('mapPointToDisplay', () => {
  it('maps a downscaled image point on a 125% display', () => {
    // 1280x800 image of a 1920x1200 physical screen: (640,400) is the centre.
    const r = mapPointToDisplay({ x: 640, y: 400, screen: null }, [capture(laptop)]);
    expect(r).toEqual({ ok: true, point: { displayId: 1, local: { x: 768, y: 480 }, global: { x: 768, y: 480 } } });
  });

  it('handles negative origins and a different scale on screen 2', () => {
    const caps = [capture(laptop), capture(left4k)];
    // left4k is 3840x2160 physical, image 1280x720; the image centre is the display centre.
    const r = mapPointToDisplay({ x: 640, y: 360, screen: 2 }, caps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.point.displayId).toBe(2);
    expect(r.point.local).toEqual({ x: 1280, y: 720 });
    expect(r.point.global).toEqual({ x: -1280, y: 520 });
  });

  it('handles a display above the primary at 100% with no downscale needed', () => {
    const r = mapPointToDisplay({ x: 100, y: 50, screen: 1 }, [capture(above, 4000)]);
    expect(r).toMatchObject({ ok: true, point: { local: { x: 100, y: 50 }, global: { x: 100, y: -1030 } } });
  });

  it('treats a missing screen index as the first capture', () => {
    const r = mapPointToDisplay({ x: 0, y: 0, screen: null }, [capture(left4k), capture(laptop)]);
    expect(r).toMatchObject({ ok: true, point: { displayId: 2 } });
  });

  it('rejects unknown screens, empty captures and far out-of-bounds points', () => {
    expect(mapPointToDisplay({ x: 1, y: 1, screen: 3 }, [capture(laptop)])).toMatchObject({
      ok: false,
      reason: 'unknown-screen',
    });
    expect(mapPointToDisplay({ x: 1, y: 1, screen: null }, [])).toMatchObject({ ok: false, reason: 'no-captures' });
    expect(mapPointToDisplay({ x: 1300, y: 10, screen: null }, [capture(laptop)])).toMatchObject({
      ok: false,
      reason: 'out-of-bounds',
    });
    expect(mapPointToDisplay({ x: -20, y: 10, screen: null }, [capture(laptop)])).toMatchObject({
      ok: false,
      reason: 'out-of-bounds',
    });
  });

  it('clamps points a few pixels outside the image', () => {
    const r = mapPointToDisplay({ x: 1282, y: -2, screen: null }, [capture(laptop)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.point.local.y).toBe(0);
    expect(r.point.local.x).toBeLessThan(1536);
  });

  it('rejects broken geometry', () => {
    const bad: CaptureGeometry = { display: laptop, imageWidth: 0, imageHeight: 800 };
    expect(mapPointToDisplay({ x: 1, y: 1, screen: null }, [bad])).toMatchObject({ ok: false, reason: 'bad-geometry' });
  });
});
