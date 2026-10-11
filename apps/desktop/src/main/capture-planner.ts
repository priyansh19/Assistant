import { desktopCapturer, screen, type Display } from 'electron';
import type { DisplayGeometry } from '@clicky/core';
import type { CapturePlan } from '../shared/engine-protocol';
import type { CaptureSource } from '../shared/worker-protocol';

function geometry(d: Display): DisplayGeometry {
  return { id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor };
}

function physical(d: Display): { width: number; height: number } {
  return { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
}

/** Displays to capture: the cursor's display first, then (optionally) the rest. */
function targetDisplays(allDisplays: boolean): Display[] {
  const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (!allDisplays) return [cursor];
  return [cursor, ...screen.getAllDisplays().filter((d) => d.id !== cursor.id)];
}

/**
 * desktopCapturer.getSources blocks the main process for ~200-300 ms on Windows, so it must never
 * run on the key-down path. Source ids are stable for a display layout: fetch them at startup and
 * whenever displays change, and reuse them.
 */
class SourceCache {
  private sources: Electron.DesktopCapturerSource[] = [];
  private pending: Promise<void> | null = null;

  constructor() {
    const refresh = (): void => void this.refresh();
    screen.on('display-added', refresh);
    screen.on('display-removed', refresh);
    // Only geometry changes matter; taskbar/work-area changes would cost a blocking getSources.
    screen.on('display-metrics-changed', (_e, _d, changed: string[]) => {
      if (changed.some((c) => c === 'bounds' || c === 'scaleFactor' || c === 'rotation')) refresh();
    });
    // Off the startup critical path.
    setTimeout(refresh, 1500);
  }

  refresh(): Promise<void> {
    this.pending ??= desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((s) => {
        this.sources = s;
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** Sources for these displays from the cache, or null if the cache doesn't cover them. */
  lookup(displays: Display[]): CaptureSource[] | null {
    const out: CaptureSource[] = [];
    for (const d of displays) {
      const src = this.sources.find((s) => s.display_id === String(d.id));
      if (!src) return null;
      out.push({ sourceId: src.id, ...physical(d) });
    }
    return out;
  }

  async get(displays: Display[]): Promise<CaptureSource[]> {
    // Only fetch when we have nothing at all; a miss with a warm cache falls back to order rather
    // than paying for another blocking getSources on the key-down path.
    if (this.sources.length === 0) await this.refresh();
    const hit = this.lookup(displays);
    if (hit) return hit;
    const all = screen.getAllDisplays();
    return displays.map((d) => {
      // Some drivers leave display_id empty: match by position in the display list instead.
      const src = this.sources[all.findIndex((x) => x.id === d.id)] ?? this.sources[0];
      if (!src) throw new Error('No screen is available to capture.');
      return { sourceId: src.id, ...physical(d) };
    });
  }
}

/** Which displays and capture sources a question should use. Main owns the screen API. */
export class CapturePlanner {
  private readonly cache = new SourceCache();

  async plan(allDisplays: boolean): Promise<CapturePlan> {
    const displays = targetDisplays(allDisplays);
    const sources = await this.cache.get(displays);
    return { displays: displays.map(geometry), sources };
  }
}
