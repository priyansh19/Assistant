/**
 * Listen stage: microphone and speech-to-text for one key press. Starts the mic first (every
 * millisecond before it runs is speech lost), opens the STT connection in parallel, and buffers
 * frames until the connection is ready. When the answer model listens to the audio itself there
 * is no STT session and the stage keeps the whole recording instead.
 */

import { joinFrames } from '../audio.js';
import type { Stage } from '../errors.js';
import type { MicPort } from '../ports.js';
import type { SttProvider, SttSession } from '../providers.js';
import { withTimeout } from './budget.js';

export interface ListenStageOptions {
  mic: MicPort;
  /** Null when the answer model listens to the recording directly. */
  stt: SttProvider | null;
  signal: AbortSignal;
  /** A failure while the user is still talking (mic lost, STT refused the connection). */
  onError(e: unknown, stage: Stage): void;
  onRecording?(): void;
  onSttReady?(): void;
  /** Interim transcript, for speculation and captions. */
  onPartial?(text: string): void;
}

export class ListenStage {
  /** Frames recorded before the STT connection was ready, or the whole recording without STT. */
  private readonly frames: Int16Array[] = [];
  private ready: SttSession | null = null;
  private micStopped = false;
  readonly session: Promise<SttSession> | null;
  /** The latest interim transcript (empty until the STT service sends one). */
  partial = '';

  constructor(private readonly opts: ListenStageOptions) {
    const { signal } = opts;
    opts.mic
      .start(
        (frame) => {
          if (signal.aborted) return;
          if (this.ready) this.ready.pushAudio(frame);
          else this.frames.push(frame);
        },
        signal,
        (e) => {
          if (!signal.aborted) opts.onError(e, 'mic');
        },
      )
      .then(
        () => opts.onRecording?.(),
        (e: unknown) => {
          if (!signal.aborted) opts.onError(e, 'mic');
        },
      );
    this.session = opts.stt ? opts.stt.start({ sampleRate: 16000, signal }) : null;
    this.session?.then(
      (session) => {
        // Flush audio recorded before the connection was ready, then stream directly.
        for (const f of this.frames.splice(0)) session.pushAudio(f);
        this.ready = session;
        session.onPartial?.((text) => {
          this.partial = text;
          opts.onPartial?.(text);
        });
        opts.onSttReady?.();
      },
      (e: unknown) => {
        if (!signal.aborted) opts.onError(e, 'stt');
      },
    );
  }

  /** True when there is no STT service and the recording goes to the answer model. */
  get direct(): boolean {
    return this.session === null;
  }

  stopMic(): void {
    if (this.micStopped) return;
    this.micStopped = true;
    this.opts.mic.stop();
  }

  /** Key released: force-finalise and return the transcript. */
  async transcript(timeoutMs: number): Promise<string> {
    if (!this.session) throw new Error('speech-to-text did not start');
    const { signal } = this.opts;
    const session = await withTimeout(this.session, timeoutMs, 'stt', 'speech recognition', signal);
    return withTimeout(session.finish(), timeoutMs, 'stt', 'speech recognition', signal);
  }

  /** The whole recording (direct mode only). Empties the buffer. */
  takeRecording(): Int16Array {
    return joinFrames(this.frames.splice(0));
  }

  /** Close the STT connection (cancel/error). */
  close(): void {
    void this.session?.then(
      (s) => s.close(),
      () => undefined,
    );
  }
}
