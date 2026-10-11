// Ports the pipeline uses to reach the media renderer (mic, capture, playback, offline voice).
// They only need a MediaChannel, so they run the same in the engine process and in main.
import {
  StageError,
  type AudioSink,
  type CapturePort,
  type DisplayGeometry,
  type MicPort,
  type ScreenCapture,
  type SpeechFactory,
  type SpeechOutput,
} from '@clicky/core';
import type { CapturePlan } from '../shared/engine-protocol';
import type { CapturedFrame, WorkerEvent } from '../shared/worker-protocol';
import type { MediaChannel } from './media-channel';

const JPEG_QUALITY = 0.82;

/** Upper bound for grabbing the screenshot(s); a locked or protected screen can stall capture. */
const CAPTURE_TIMEOUT_MS = 4000;

/** Works out which displays and capture sources to use (main owns the screen API). */
export type CapturePlanner = (allDisplays: boolean) => Promise<CapturePlan>;

export function createCapturePort(
  media: MediaChannel,
  planner: CapturePlanner,
  settings: () => { captureMaxEdge: number; captureAllDisplays: boolean },
): CapturePort {
  // The displays and sources chosen at key-down are reused at key-up, so the frame matches. The
  // plan belongs to one interaction: a cancelled press must not leak it into the next question.
  let planned: { signal: AbortSignal; plan: Promise<CapturePlan> } | null = null;
  const plan = (): Promise<CapturePlan> => planner(settings().captureAllDisplays);
  return {
    begin(signal) {
      const p = plan();
      planned = { signal, plan: p };
      p.then((pl) => {
        if (!signal.aborted) media.send({ op: 'capture.begin', sources: pl.sources });
      }).catch(() => undefined);
      signal.addEventListener(
        'abort',
        () => {
          if (planned?.signal === signal) planned = null;
          media.send({ op: 'capture.stop' });
        },
        { once: true },
      );
    },
    async take(signal): Promise<ScreenCapture> {
      const mine = planned?.signal === signal ? planned.plan : null;
      planned = null;
      const pl = await (mine ?? plan());
      if (signal.aborted) throw new Error('aborted');
      const frames = await media
        .request<CapturedFrame[]>(
          { op: 'capture.take', sources: pl.sources, maxEdge: settings().captureMaxEdge, quality: JPEG_QUALITY },
          CAPTURE_TIMEOUT_MS,
        )
        .catch((e: unknown) => {
          media.send({ op: 'capture.stop' });
          throw new StageError(
            'capture',
            'unknown',
            `Couldn't capture the screen (${e instanceof Error ? e.message : String(e)}).`,
            { cause: e },
          );
        });
      return {
        images: frames.map((f) => ({ data: f.data, mediaType: 'image/jpeg', width: f.width, height: f.height })),
        geometry: frames.map((f, i) => ({
          display: pl.displays[i] as DisplayGeometry,
          imageWidth: f.width,
          imageHeight: f.height,
        })),
        cursorScreen: 1,
      };
    },
  };
}

/** Mic frames for the voice loop. Levels for the overlay waveform go to main separately. */
export function createMicPort(media: MediaChannel, deviceId: () => string): MicPort {
  let off: (() => void) | null = null;
  let current = 0;
  return {
    async start(onFrame, signal, onError) {
      off?.();
      const me = ++current;
      const myOff = media.on((e: WorkerEvent) => {
        if (signal.aborted) return;
        if (e.type === 'mic.frame') onFrame(e.frame);
        else if (e.type === 'mic.error') onError?.(new Error(e.message));
        else if (e.type === 'worker.crashed') onError?.(new Error('The audio worker stopped unexpectedly.'));
      });
      off = myOff;
      try {
        await media.request({ op: 'mic.start', deviceId: deviceId(), owner: 'voice' }, 8000);
      } catch (e) {
        myOff();
        // Only clean up if no newer press has taken over the mic meanwhile.
        if (current === me) {
          off = null;
          media.send({ op: 'mic.stop', owner: 'voice' });
        }
        throw new Error(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
    stop() {
      current++;
      off?.();
      off = null;
      media.send({ op: 'mic.stop', owner: 'voice' });
    },
  };
}

let streamSeq = 0;

type Outcome = { ok: true } | { ok: false; error: Error };

/** Plays streamed PCM through the media renderer. */
export function createAudioSink(media: MediaChannel): AudioSink {
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
  off = media.on((e) => {
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
        media.send({ op: 'audio.open', streamId, sampleRate: m ? Number(m[1]) : 24000 });
      }
      media.send({ op: 'audio.chunk', streamId, data: chunk.data });
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
        media.send({ op: 'audio.finish', streamId });
      });
    },
    onStart(fn) {
      startFns.push(fn);
    },
    stop() {
      media.send({ op: 'audio.stop', streamId });
      settle({ ok: true });
    },
  };
}

/** The offline Windows voice (speechSynthesis in the worker). */
export function systemSpeech(media: MediaChannel): SpeechFactory {
  return {
    id: 'system',
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
      const off = media.on((e) => {
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
        media.send({ op: 'voice.stop', streamId });
        resolveDone();
      };
      signal.addEventListener('abort', stop, { once: true });
      return {
        say(text) {
          if (stopped || ended || !text.trim()) return;
          said++;
          media.send({ op: 'voice.say', streamId, text });
        },
        end() {
          if (ended || stopped) return;
          ended = true;
          media.send({ op: 'voice.finish', streamId });
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
