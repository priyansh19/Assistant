/**
 * The interaction loop (plan §3.3), written against ports so it runs the same in the app and in
 * tests with fakes:
 *
 *   key down  → listening: start capture stream, open STT, start mic, pre-warm chat + TTS
 *   key up    → transcribing: stop mic, grab the frame, force-finalise the transcript
 *   transcript→ thinking: stream the answer; POINT tag moves the cursor, sentences go to TTS
 *   first audio → speaking … playback done → idle
 *
 * Every step is tied to the interaction's AbortSignal, so cancel/interrupt stops everything and
 * nothing late from an old interaction can touch the new one.
 */

import { HeardTagFilter, joinFrames, pcmToWav } from './audio.js';
import { classifyFailure, StageError, StageTimeoutError, userMessage, type Stage } from './errors.js';
import { mapPointToDisplay, type CaptureGeometry, type MappedPoint } from './coordinates.js';
import type { HistoryEntry } from './history.js';
import { InteractionMachine, type Interaction, type InteractionState } from './interaction.js';
import { LatencyRecorder, type LatencySummary } from './latency.js';
import { PointStreamParser, type PointTarget } from './point-parser.js';
import { buildSystemPrompt } from './prompt.js';
import type {
  ChatTurn,
  ImageInput,
  SttProvider,
  SttSession,
  VisionChatProvider,
  VisionChatRequest,
} from './providers.js';
import { SentenceChunker } from './sentence-chunker.js';
import type { SpeechFactory, SpeechOutput } from './speech.js';

export interface ScreenCapture {
  /** images[i] is screen i+1 in the prompt. */
  images: ImageInput[];
  geometry: CaptureGeometry[];
  /** 1-based index of the screen with the cursor. */
  cursorScreen: number;
}

export interface CapturePort {
  /** Key down: start capturing (open the stream) so a frame is ready at key up. */
  begin(signal: AbortSignal): void;
  /** Return the latest frame(s). Must work even if `begin` wasn't called (typed questions). */
  take(signal: AbortSignal): Promise<ScreenCapture>;
}

export interface MicPort {
  /** Start the microphone; frames are 16 kHz mono PCM16. Resolves once recording has started. */
  start(onFrame: (frame: Int16Array) => void, signal: AbortSignal, onError?: (e: Error) => void): Promise<void>;
  stop(): void;
}

export interface OverlayPort {
  state(state: InteractionState): void;
  point(target: MappedPoint, label: string): void;
  /** A short message near the cursor, e.g. an error the user can act on. */
  message(text: string, kind: 'error' | 'info'): void;
  /** Live caption of the answer as it streams (optional UI). */
  caption?(text: string): void;
}

/** How a typed question or action ended, for UI that waits on it. */
export interface AskResult {
  outcome: HistoryEntry['outcome'];
  answer: string;
  pointLabel: string | null;
  detail?: string;
}

export interface OrchestratorDeps {
  chat(): VisionChatProvider;
  stt(): SttProvider;
  speech(): SpeechFactory;
  capture: CapturePort;
  mic: MicPort;
  overlay: OverlayPort;
  recentTurns(): ChatTurn[];
  /** True when the answer model listens to the recorded audio itself (no speech-to-text service). */
  listensDirectly?(): boolean;
  record(entry: Omit<HistoryEntry, 'id' | 'at'>): void;
  onLatency?(summary: LatencySummary): void;
  /** Called for every state change, for logging and the tray. */
  onState?(state: InteractionState, interaction: Interaction): void;
  log?(message: string): void;
  now?(): number;
  maxTokens?: number;
  userContext?(): string | undefined;
  timeouts?: Partial<Timeouts>;
}

export interface Timeouts {
  /** key up → final transcript */
  transcriptMs: number;
  /** request sent → first token */
  firstTokenMs: number;
  /** whole answer, from key up */
  answerMs: number;
}

const DEFAULT_TIMEOUTS: Timeouts = { transcriptMs: 6000, firstTokenMs: 20000, answerMs: 90000 };

/** Upper bound on playing one answer, so a stuck audio device can't hang the loop. */
const SPEAKING_TIMEOUT_MS = 120_000;

/** Keep recording this long after key-up so the last syllable isn't clipped in the audio pipeline. */
export const MIC_TAIL_MS = 80;

/** A key held longer than this is treated as a missed key-up (e.g. Windows switched desktops). */
export const MAX_LISTEN_MS = 60_000;

/** Recordings shorter than this have no question in them. */
const MIN_AUDIO_S = 0.3;

/** Hold shorter than this is treated as an accidental tap. */
export const MIN_HOLD_MS = 250;

function withTimeout<T>(p: Promise<T>, ms: number, stage: Stage, what: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new StageTimeoutError(stage, what)), ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface Run {
  interaction: Interaction;
  latency: LatencyRecorder;
  source: HistoryEntry['source'];
  question: string;
  answer: string;
  pointLabel: string | null;
  sttSession: Promise<SttSession> | null;
  micFrames: Int16Array[];
  speech: SpeechOutput | null;
  keyDownAt: number;
  finished: boolean;
  listenTimer?: ReturnType<typeof setTimeout>;
  result?: AskResult;
  /** Only runs that started the mic may stop it (typed questions never touch it). */
  usedMic: boolean;
}

export class Orchestrator {
  readonly machine: InteractionMachine;
  private run: Run | null = null;
  private readonly timeouts: Timeouts;
  private readonly now: () => number;

  constructor(
    private readonly deps: OrchestratorDeps,
    machine = new InteractionMachine(),
  ) {
    this.machine = machine;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    this.now = deps.now ?? (() => performance.now());
    machine.onTransition((t, interaction) => {
      deps.overlay.state(t.to);
      deps.onState?.(t.to, interaction);
      if (t.to === 'cancelled' || t.to === 'error') this.teardown(interaction.id);
    });
  }

  get state(): InteractionState {
    return this.machine.state;
  }

  /** Hold-to-talk key pressed. */
  keyDown(): void {
    const t = this.machine.dispatch({ type: 'keyDown' });
    if (!t) return;
    const interaction = this.machine.interaction;
    if (!interaction) return;
    const latency = new LatencyRecorder(interaction.id, this.now);
    latency.mark('keyDown');
    const run: Run = {
      interaction,
      latency,
      source: 'voice',
      question: '',
      answer: '',
      pointLabel: null,
      sttSession: null,
      micFrames: [],
      speech: null,
      keyDownAt: this.now(),
      finished: false,
      usedMic: true,
    };
    this.run = run;
    const { signal } = interaction;
    run.listenTimer = setTimeout(() => {
      if (this.run === run && this.machine.state === 'listening') {
        this.deps.overlay.message('Stopped listening: the key was held for over a minute.', 'info');
        this.cancel('key held too long');
      }
    }, MAX_LISTEN_MS);

    // Everything here runs in parallel while the user is still talking. The mic goes first: every
    // millisecond before it starts is speech lost.
    let ready: SttSession | null = null;
    this.deps.mic
      .start(
        (frame) => {
          if (signal.aborted) return;
          if (ready) ready.pushAudio(frame);
          else run.micFrames.push(frame);
        },
        signal,
        (e) => {
          if (!signal.aborted && (this.machine.state === 'listening' || this.machine.state === 'transcribing'))
            this.fail(run, e, 'mic');
        },
      )
      .then(
        () => latency.mark('recordingStarted'),
        (e: unknown) => {
          if (!signal.aborted) this.fail(run, e, 'mic');
        },
      );
    // Listening directly: frames just accumulate and go to the answer model with the screenshot.
    const direct = this.deps.listensDirectly?.() ?? false;
    let stt: SttProvider | null = null;
    if (!direct) {
      try {
        stt = this.deps.stt();
        latency.setMeta('stt', stt.id);
      } catch (e) {
        this.fail(run, e, 'stt');
        return;
      }
    }
    if (stt) run.sttSession = stt.start({ sampleRate: 16000, signal });
    run.sttSession?.then(
      (session) => {
        // Flush audio recorded before the connection was ready, then stream directly.
        for (const f of run.micFrames.splice(0)) session.pushAudio(f);
        ready = session;
        latency.mark('sttReady');
      },
      (e: unknown) => {
        if (!signal.aborted) this.fail(run, e, 'stt');
      },
    );
    try {
      this.deps.capture.begin(signal);
    } catch (e) {
      this.deps.log?.(`capture begin failed: ${String(e)}`);
    }
    try {
      const chat = this.deps.chat();
      void chat.prewarm?.(signal).catch(() => undefined);
      this.deps.speech().prewarm?.(signal);
    } catch {
      // Missing config surfaces when the answer starts; don't fail while the user is talking.
    }
  }

  /** Hold-to-talk key released. */
  keyUp(): void {
    const run = this.run;
    if (!run || this.machine.state !== 'listening') return;
    clearTimeout(run.listenTimer);
    const held = this.now() - run.keyDownAt;
    if (held < MIN_HOLD_MS) {
      this.deps.mic.stop();
      this.machine.dispatch({ type: 'cancel', reason: 'key tapped, not held' });
      return;
    }
    run.latency.mark('keyUp');
    this.machine.dispatch({ type: 'keyUp' });
    void this.afterKeyUp(run).catch((e: unknown) => this.fail(run, e, 'app'));
  }

  /** Esc, or the user asked to stop. */
  cancel(reason = 'cancelled'): void {
    if (this.run && !this.run.finished) this.machine.dispatch({ type: 'cancel', reason });
  }

  /**
   * Ask a typed question (dashboard) or replay a saved action: no microphone, same answer path.
   */
  async ask(question: string, source: 'typed' | 'action'): Promise<AskResult | null> {
    const q = question.trim();
    if (!q) return null;
    if (this.run && !this.run.finished) this.cancel('replaced by a new question');
    // Not a voice press: a mic test in the dashboard must not be affected.
    this.machine.dispatch({ type: 'keyDown' });
    const interaction = this.machine.interaction;
    if (!interaction) return null;
    const latency = new LatencyRecorder(interaction.id, this.now);
    latency.mark('keyDown');
    const run: Run = {
      interaction,
      latency,
      source,
      question: q,
      answer: '',
      pointLabel: null,
      sttSession: null,
      micFrames: [],
      speech: null,
      keyDownAt: this.now(),
      finished: false,
      usedMic: false,
    };
    this.run = run;
    latency.mark('keyUp');
    this.machine.dispatch({ type: 'keyUp' });
    const screens = this.deps.capture.take(interaction.signal);
    screens.catch(() => undefined); // handled (or deliberately dropped) in answer()
    await this.answer(run, screens, q);
    return run.result ?? null;
  }

  private async afterKeyUp(run: Run): Promise<void> {
    const { signal } = run.interaction;
    const screens = this.deps.capture.take(signal);
    screens.catch(() => undefined); // handled in answer()
    // Let the last few frames through before stopping the mic and finalising the transcript.
    await new Promise((r) => setTimeout(r, MIC_TAIL_MS));
    if (this.run === run) this.deps.mic.stop();
    if (signal.aborted) return;
    if (!run.sttSession) {
      // The model listens: hand it the recording (16 kHz mono WAV, small enough to upload instantly).
      const pcm = joinFrames(run.micFrames.splice(0));
      if (pcm.length < 16000 * MIN_AUDIO_S) {
        this.deps.overlay.message("I didn't catch that. Hold the key and try again.", 'info');
        this.machine.dispatch({ type: 'cancel', reason: 'no speech detected' });
        return;
      }
      run.latency.mark('transcriptFinal');
      await this.answer(run, screens, '', { data: pcmToWav(pcm, 16000), format: 'wav' });
      return;
    }
    let transcript: string;
    try {
      if (!run.sttSession) throw new Error('speech-to-text did not start');
      const session = await withTimeout(
        run.sttSession,
        this.timeouts.transcriptMs,
        'stt',
        'speech recognition',
        signal,
      );
      transcript = await withTimeout(session.finish(), this.timeouts.transcriptMs, 'stt', 'speech recognition', signal);
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, 'stt');
      return;
    }
    if (signal.aborted) return;
    run.question = transcript.trim();
    await this.answer(run, screens, transcript);
  }

  private async answer(
    run: Run,
    screensP: Promise<ScreenCapture>,
    question: string,
    audio?: VisionChatRequest['audio'],
  ): Promise<void> {
    try {
      await this.answerInner(run, screensP, question, audio);
    } catch (e) {
      // Anything unexpected must end in a visible error, never a stuck "thinking".
      run.speech?.stop();
      if (!run.interaction.signal.aborted) this.fail(run, e, 'app');
    }
  }

  private async answerInner(
    run: Run,
    screensP: Promise<ScreenCapture>,
    question: string,
    audio?: VisionChatRequest['audio'],
  ): Promise<void> {
    const { signal } = run.interaction;
    if (signal.aborted) return;
    run.latency.mark('transcriptFinal');
    // With audio the question text comes back from the model ([HEARD:...]); the machine only needs non-empty.
    const t = this.machine.dispatch({ type: 'transcriptFinal', text: audio ? '(voice)' : question });
    if (!t || t.to !== 'thinking') {
      // Empty transcript → the machine cancelled. Tell the user why instead of silently resetting.
      if (t?.to === 'cancelled') this.deps.overlay.message("I didn't catch that. Hold the key and try again.", 'info');
      this.finish(run, 'cancelled', 'no speech detected');
      return;
    }

    let chat: VisionChatProvider;
    let speechFactory: SpeechFactory;
    try {
      chat = this.deps.chat();
      speechFactory = this.deps.speech();
    } catch (e) {
      this.fail(run, e, 'config');
      return;
    }
    run.latency.setMeta('chat', chat.id);
    if (chat.model) run.latency.setMeta('model', chat.model);
    if (speechFactory.id) run.latency.setMeta('voice', speechFactory.id);

    let screens: ScreenCapture;
    try {
      screens = await screensP;
      run.latency.mark('captureReady');
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, 'capture');
      return;
    }
    if (signal.aborted) return;
    run.latency.setMeta(
      'imageBytes',
      screens.images.reduce((n, img) => n + img.data.byteLength, 0),
    );
    if (screens.images[0])
      run.latency.setMeta('imageEdge', Math.max(screens.images[0].width, screens.images[0].height));

    const system = buildSystemPrompt({
      screens: screens.images.map((img, i) => ({
        index: i + 1,
        imageWidth: img.width,
        imageHeight: img.height,
        hasCursor: i + 1 === screens.cursorScreen,
      })),
      ...(this.deps.userContext?.() ? { userContext: this.deps.userContext() as string } : {}),
      ...(audio ? { audioQuestion: true } : {}),
    });

    const speech = speechFactory.create(signal);
    run.speech = speech;
    // A voice failure on the first sentence should surface now, not after the whole answer streams.
    speech.done.catch((e: unknown) => {
      if (!signal.aborted && !run.finished) this.fail(run, e, 'speech');
    });
    speech.onFirstAudio(() => {
      if (signal.aborted) return;
      run.latency.mark('firstAudio');
      this.machine.dispatch({ type: 'firstAudio' });
    });

    const parser = new PointStreamParser();
    const heard = audio ? new HeardTagFilter() : null;
    const feed = (text: string): ReturnType<PointStreamParser['push']> => {
      if (!heard) return parser.push(text);
      const out = heard.push(text);
      if (heard.heard && !run.question) run.question = heard.heard;
      return out ? parser.push(out) : [];
    };
    const chunker = new SentenceChunker();
    const say = (sentence: string): void => {
      run.latency.mark('firstSpeech');
      speech.say(sentence);
    };
    const handleText = (text: string): void => {
      run.answer += text;
      this.deps.overlay.caption?.(run.answer);
      for (const sentence of chunker.push(text)) say(sentence);
    };
    const handleEvents = (events: ReturnType<PointStreamParser['push']>): void => {
      for (const ev of events) {
        if (ev.type === 'text') handleText(ev.text);
        else if (ev.type === 'point') this.handlePoint(run, ev.tag.kind === 'point' ? ev.tag : null, screens);
        else this.deps.log?.(`invalid POINT tag dropped: ${ev.raw}`);
      }
    };

    // Which stage a failure inside the loop below belongs to.
    let stage: Stage = 'answer';
    try {
      run.latency.mark('requestSent');
      const stream = chat.stream({
        system,
        history: this.deps.recentTurns(),
        question: audio ? 'Answer the question in the audio.' : question,
        images: screens.images,
        ...(audio ? { audio } : {}),
        maxTokens: this.deps.maxTokens ?? 1500,
        signal,
      });
      const iterator = stream[Symbol.asyncIterator]();
      const deadline = this.now() + this.timeouts.answerMs;
      let first = true;
      for (;;) {
        const remaining = first ? this.timeouts.firstTokenMs : Math.max(1, deadline - this.now());
        const next = await withTimeout(iterator.next(), remaining, 'answer', 'the AI answer', signal);
        if (next.done) break;
        if (first) {
          run.latency.mark('firstToken');
          first = false;
        }
        handleEvents(feed(next.value));
      }
      if (heard) {
        const rest = heard.end();
        if (rest) handleEvents(parser.push(rest));
        if (heard.heard && !run.question) run.question = heard.heard;
      }
      handleEvents(parser.end());
      for (const sentence of chunker.end()) say(sentence);
      speech.end();
      if (!run.answer.trim()) {
        if (audio && !run.question) {
          // The model heard no speech in the recording.
          speech.stop();
          this.deps.overlay.message("I didn't catch that. Hold the key and try again.", 'info');
          this.machine.dispatch({ type: 'cancel', reason: 'no speech detected' });
          return;
        }
        throw new StageError('answer', 'bad-output', 'the answer was empty', { provider: chat.id });
      }
      stage = 'speech';
      await withTimeout(speech.done, SPEAKING_TIMEOUT_MS, 'speech', 'playing the answer', signal);
    } catch (e) {
      speech.stop();
      if (!signal.aborted) this.fail(run, e, stage);
      return;
    }
    if (signal.aborted) return;
    // A very short answer can finish before first audio was reported (e.g. muted output).
    if (this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    run.latency.mark('done');
    this.machine.dispatch({ type: 'speechDone' });
    this.finish(run, 'answered');
  }

  private handlePoint(run: Run, tag: PointTarget | null, screens: ScreenCapture): void {
    if (!tag || run.pointLabel !== null) return; // only the first point is used
    const mapped = mapPointToDisplay(tag, screens.geometry);
    if (!mapped.ok) {
      this.deps.log?.(`POINT skipped (${mapped.reason}): ${mapped.detail}`);
      return;
    }
    run.pointLabel = tag.label || 'here';
    run.latency.mark('firstPoint');
    this.deps.overlay.point(mapped.point, tag.label);
  }

  private fail(run: Run, e: unknown, stage: Stage): void {
    if (run.finished) return;
    const err = classifyFailure(e, stage);
    const message = userMessage(err);
    run.latency.setFailure({ stage: err.stage, kind: err.kind, ...(err.provider ? { provider: err.provider } : {}) });
    run.latency.event(err.stage, 'failed', { kind: err.kind, ...(err.provider ? { provider: err.provider } : {}) });
    this.deps.log?.(
      `interaction ${run.interaction.id} failed in ${err.stage} (${err.kind}${err.provider ? `, ${err.provider}` : ''}): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    this.deps.overlay.message(message, 'error');
    if (this.run === run) this.machine.dispatch({ type: 'fail', reason: message });
    this.finish(run, 'error', message);
  }

  private finish(run: Run, outcome: HistoryEntry['outcome'], detail?: string): void {
    if (run.finished) return;
    run.finished = true;
    run.result = { outcome, answer: run.answer.trim(), pointLabel: run.pointLabel, ...(detail ? { detail } : {}) };
    const summary = run.latency.summary();
    // History/log writes are deferred: when a new press interrupts this run, its mic must start first.
    queueMicrotask(() => this.persist(run, outcome, summary, detail));
  }

  private persist(run: Run, outcome: HistoryEntry['outcome'], summary: LatencySummary, detail?: string): void {
    this.deps.onLatency?.(summary);
    if (run.question || run.answer) {
      this.deps.record({
        question: run.question,
        answer: run.answer.trim(),
        pointLabel: run.pointLabel,
        source: run.source,
        outcome,
        ...(detail ? { detail } : {}),
        keyUpToFirstAudioMs: summary.keyUpToFirstAudioMs,
      });
    }
  }

  /** Called on cancel/error transitions: stop audio and the mic for that interaction. */
  private teardown(interactionId: string): void {
    const run = this.run;
    if (!run || run.interaction.id !== interactionId) return;
    clearTimeout(run.listenTimer);
    if (run.usedMic) this.deps.mic.stop();
    run.speech?.stop();
    void run.sttSession?.then(
      (s) => s.close(),
      () => undefined,
    );
    if (!run.finished) {
      // run.interaction is a snapshot; the live interaction has the end reason.
      const live = this.machine.interaction;
      const reason = live?.id === run.interaction.id ? live.endReason : null;
      this.finish(run, this.machine.state === 'error' ? 'error' : 'cancelled', reason ?? undefined);
    }
  }
}
