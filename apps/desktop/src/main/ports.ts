import { desktopCapturer, screen, type Display } from 'electron';
import {
  type AudioSink,
  type CapturePort,
  type DisplayGeometry,
  type MicPort,
  type ScreenCapture,
  type SpeechFactory,
  type SpeechOutput,
} from '@clicky/core';
import type { CaptureSource, CapturedFrame, WorkerEvent } from '../shared/worker-protocol';
import type { WorkerHost } from './worker-host';

const JPEG_QUALITY = 0.82;

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
    screen.on('display-metrics-changed', refresh);
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

/** Upper bound for grabbing the screenshot(s); a locked or protected screen can stall capture. */
const CAPTURE_TIMEOUT_MS = 4000;

export function createCapturePort(
  worker: WorkerHost,
  settings: () => { captureMaxEdge: number; captureAllDisplays: boolean },
): CapturePort {
  const cache = new SourceCache();
  // The displays and sources chosen at key-down are reused at key-up, so the frame matches. The
  // plan belongs to one interaction: a cancelled press must not leak it into the next question.
  let planned: { signal: AbortSignal; plan: Promise<{ displays: Display[]; sources: CaptureSource[] }> } | null = null;
  const plan = (): Promise<{ displays: Display[]; sources: CaptureSource[] }> => {
    const displays = targetDisplays(settings().captureAllDisplays);
    return cache.get(displays).then((sources) => ({ displays, sources }));
  };
  return {
    begin(signal) {
      const p = plan();
      planned = { signal, plan: p };
      p.then((pl) => {
        if (!signal.aborted) worker.send({ op: 'capture.begin', sources: pl.sources });
      }).catch(() => undefined);
      signal.addEventListener(
        'abort',
        () => {
          if (planned?.signal === signal) planned = null;
          worker.send({ op: 'capture.stop' });
        },
        { once: true },
      );
    },
    async take(signal): Promise<ScreenCapture> {
      const mine = planned?.signal === signal ? planned.plan : null;
      planned = null;
      const pl = await (mine ?? plan());
      if (signal.aborted) throw new Error('aborted');
      const frames = await worker
        .request<CapturedFrame[]>(
          { op: 'capture.take', sources: pl.sources, maxEdge: settings().captureMaxEdge, quality: JPEG_QUALITY },
          CAPTURE_TIMEOUT_MS,
        )
        .catch((e: unknown) => {
          worker.send({ op: 'capture.stop' });
          throw new Error(`Couldn't capture the screen (${e instanceof Error ? e.message : String(e)}).`, { cause: e });
        });
      return {
        images: frames.map((f) => ({ data: f.data, mediaType: 'image/jpeg', width: f.width, height: f.height })),
        geometry: frames.map((f, i) => ({
          display: geometry(pl.displays[i] as Display),
          imageWidth: f.width,
          imageHeight: f.height,
        })),
        cursorScreen: 1,
      };
    },
  };
}

export function createMicPort(worker: WorkerHost, deviceId: () => string, onLevel: (level: number) => void): MicPort {
  let off: (() => void) | null = null;
  return {
    async start(onFrame, signal, onError) {
      off?.();
      off = worker.on((e: WorkerEvent) => {
        if (signal.aborted) return;
        if (e.type === 'mic.frame') onFrame(e.frame);
        else if (e.type === 'mic.level') onLevel(e.level);
        else if (e.type === 'mic.error') onError?.(new Error(e.message));
        else if (e.type === 'worker.crashed') onError?.(new Error('The audio worker stopped unexpectedly.'));
      });
      try {
        await worker.request({ op: 'mic.start', deviceId: deviceId() }, 8000);
      } catch (e) {
        off?.();
        off = null;
        // A start main gave up on must not leave the device emitting.
        worker.send({ op: 'mic.stop' });
        throw new Error(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
    stop() {
      off?.();
      off = null;
      onLevel(0);
      worker.send({ op: 'mic.stop' });
    },
  };
}

let streamSeq = 0;

type Outcome = { ok: true } | { ok: false; error: Error };

/** Plays streamed PCM through the worker. */
export function createAudioSink(worker: WorkerHost): AudioSink {
  const streamId = `a${++streamSeq}`;
  let opened = false;
  const startFns: Array<() => void> = [];
  // The outcome is remembered so finish() settles even if the worker reported before it was called.
  let outcome: Outcome | null = null;
  let finished: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let off: () => void = () => undefined;
  const settle = (o: Outcome): void => {
    if (outcome) return;
    outcome = o;
    off();
    if (!finished) return;
    if (o.ok) finished.resolve();
    else finished.reject(o.error);
  };
  off = worker.on((e) => {
    if (e.type === 'worker.crashed') {
      settle({ ok: false, error: new Error('The audio worker stopped unexpectedly.') });
      return;
    }
    if (!('streamId' in e) || e.streamId !== streamId) return;
    if (e.type === 'audio.started') for (const fn of startFns.splice(0)) fn();
    else if (e.type === 'audio.finished') settle({ ok: true });
    else if (e.type === 'audio.error') settle({ ok: false, error: new Error(e.message) });
  });
  return {
    write(chunk) {
      if (outcome) return;
      if (!opened) {
        opened = true;
        const m = /pcm_(\d+)/.exec(chunk.format);
        worker.send({ op: 'audio.open', streamId, sampleRate: m ? Number(m[1]) : 24000 });
      }
      worker.send({ op: 'audio.chunk', streamId, data: chunk.data });
    },
    finish() {
      if (!opened) {
        settle({ ok: true });
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        finished = { resolve, reject };
        const o = outcome as Outcome | null;
        if (o) {
          if (o.ok) resolve();
          else reject(o.error);
          return;
        }
        worker.send({ op: 'audio.finish', streamId });
      });
    },
    onStart(fn) {
      startFns.push(fn);
    },
    stop() {
      worker.send({ op: 'audio.stop', streamId });
      settle({ ok: true });
    },
  };
}

/** The offline Windows voice (speechSynthesis in the worker). */
export function systemSpeech(worker: WorkerHost): SpeechFactory {
  return {
    create(signal): SpeechOutput {
      const streamId = `v${++streamSeq}`;
      const firstFns: Array<() => void> = [];
      let started = false;
      let stopped = false;
      let ended = false;
      let said = 0;
      let resolveDone!: () => void;
      let rejectDone!: (e: Error) => void;
      const done = new Promise<void>((res, rej) => {
        resolveDone = res;
        rejectDone = rej;
      });
      const off = worker.on((e) => {
        if (e.type === 'worker.crashed') {
          off();
          rejectDone(new Error('The audio worker stopped unexpectedly.'));
          return;
        }
        if (!('streamId' in e) || e.streamId !== streamId) return;
        if (e.type === 'audio.started' && !started) {
          started = true;
          for (const fn of firstFns.splice(0)) fn();
        } else if (e.type === 'audio.finished') {
          off();
          if (said > 0 && !started && !stopped) rejectDone(new Error('The Windows voice produced no sound.'));
          else resolveDone();
        } else if (e.type === 'audio.error') {
          off();
          rejectDone(new Error(e.message));
        }
      });
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        off();
        worker.send({ op: 'voice.stop', streamId });
        resolveDone();
      };
      signal.addEventListener('abort', stop, { once: true });
      return {
        say(text) {
          if (stopped || ended || !text.trim()) return;
          said++;
          worker.send({ op: 'voice.say', streamId, text });
        },
        end() {
          if (ended || stopped) return;
          ended = true;
          worker.send({ op: 'voice.finish', streamId });
        },
        done,
        onFirstAudio(fn) {
          if (started) fn();
          else firstFns.push(fn);
        },
        stop,
      };
    },
  };
}
