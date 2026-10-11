/**
 * The interaction loop (plan §3.3, architecture §6), written against ports so it runs the same
 * in the app and in tests with fakes. The work itself happens in pipeline stages; this class
 * maps key presses and commands onto the state machine and starts or cancels those stages:
 *
 *   key down  → listening: ListenStage (mic + STT), capture begins, chat + voice pre-warm
 *   key up    → transcribing: stop the mic, grab the frame, force-finalise the transcript
 *   transcript→ thinking: runAnswer (POINT moves the cursor, text streams into the voice)
 *   first audio → speaking … playback done → idle
 *
 * Every stage is tied to the interaction's AbortSignal, so cancel/interrupt stops everything and
 * nothing late from an old interaction can touch the new one.
 */

import { pcmToWav } from './audio.js';
import { classifyFailure, userMessage, type Stage } from './errors.js';
import type { HistoryEntry } from './history.js';
import { InteractionMachine, type Interaction, type InteractionState } from './interaction.js';
import { LatencyRecorder, type LatencySummary } from './latency.js';
import { runAnswer, type AnswerRunResult } from './pipeline/answer-runner.js';
import { delay } from './pipeline/budget.js';
import { ListenStage } from './pipeline/listen-stage.js';
import type { CapturePort, MicPort, OverlayPort, ScreenCapture } from './ports.js';
import type { ChatTurn, SttProvider, VisionChatProvider, VisionChatRequest } from './providers.js';
import type { SpeechFactory } from './speech.js';

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

/** Keep recording this long after key-up so the last syllable isn't clipped in the audio pipeline. */
export const MIC_TAIL_MS = 80;

/** A key held longer than this is treated as a missed key-up (e.g. Windows switched desktops). */
export const MAX_LISTEN_MS = 60_000;

/** Recordings shorter than this have no question in them. */
const MIN_AUDIO_S = 0.3;

/** Hold shorter than this is treated as an accidental tap. */
export const MIN_HOLD_MS = 250;

const NO_SPEECH = "I didn't catch that. Hold the key and try again.";

interface Run {
  interaction: Interaction;
  latency: LatencyRecorder;
  source: HistoryEntry['source'];
  question: string;
  answer: string;
  pointLabel: string | null;
  /** Voice questions only. */
  listen: ListenStage | null;
  keyDownAt: number;
  finished: boolean;
  listenTimer?: ReturnType<typeof setTimeout>;
  result?: AskResult;
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

  private newRun(interaction: Interaction, source: HistoryEntry['source'], question: string): Run {
    const latency = new LatencyRecorder(interaction.id, this.now);
    latency.mark('keyDown');
    latency.setMeta('source', source);
    const run: Run = {
      interaction,
      latency,
      source,
      question,
      answer: '',
      pointLabel: null,
      listen: null,
      keyDownAt: this.now(),
      finished: false,
    };
    this.run = run;
    return run;
  }

  /** Hold-to-talk key pressed. */
  keyDown(): void {
    const t = this.machine.dispatch({ type: 'keyDown' });
    if (!t) return;
    const interaction = this.machine.interaction;
    if (!interaction) return;
    const run = this.newRun(interaction, 'voice', '');
    const { signal } = interaction;
    run.listenTimer = setTimeout(() => {
      if (this.run === run && this.machine.state === 'listening') {
        this.deps.overlay.message('Stopped listening: the key was held for over a minute.', 'info');
        this.cancel('key held too long');
      }
    }, MAX_LISTEN_MS);

    // Everything here runs in parallel while the user is still talking. Listening directly: frames
    // just accumulate and go to the answer model with the screenshot.
    let stt: SttProvider | null = null;
    if (!(this.deps.listensDirectly?.() ?? false)) {
      try {
        stt = this.deps.stt();
        run.latency.setMeta('stt', stt.id);
      } catch (e) {
        this.fail(run, e, 'stt');
        return;
      }
    }
    run.listen = new ListenStage({
      mic: this.deps.mic,
      stt,
      signal,
      onError: (e, stage) => {
        // Only while the recording matters; a mic hiccup during playback is not a failure.
        if (stage === 'mic' && this.machine.state !== 'listening' && this.machine.state !== 'transcribing') return;
        this.fail(run, e, stage);
      },
      onRecording: () => run.latency.mark('recordingStarted'),
      onSttReady: () => run.latency.mark('sttReady'),
    });
    try {
      this.deps.capture.begin(signal);
    } catch (e) {
      this.deps.log?.(`capture begin failed: ${String(e)}`);
    }
    try {
      void this.deps
        .chat()
        .prewarm?.(signal)
        .catch(() => undefined);
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
    const run = this.newRun(interaction, source, q);
    run.latency.mark('keyUp');
    this.machine.dispatch({ type: 'keyUp' });
    const screens = this.deps.capture.take(interaction.signal);
    screens.catch(() => undefined); // handled (or deliberately dropped) in answer()
    await this.answer(run, screens, q);
    return run.result ?? null;
  }

  private async afterKeyUp(run: Run): Promise<void> {
    const { signal } = run.interaction;
    const listen = run.listen;
    if (!listen) return;
    const screens = this.deps.capture.take(signal);
    screens.catch(() => undefined); // handled in answer()
    // Let the last few frames through before stopping the mic and finalising the transcript.
    await delay(MIC_TAIL_MS);
    if (this.run === run) listen.stopMic();
    if (signal.aborted) return;
    if (listen.direct) {
      // The model listens: hand it the recording (16 kHz mono WAV, small enough to upload instantly).
      const pcm = listen.takeRecording();
      if (pcm.length < 16000 * MIN_AUDIO_S) {
        this.deps.overlay.message(NO_SPEECH, 'info');
        this.machine.dispatch({ type: 'cancel', reason: 'no speech detected' });
        return;
      }
      await this.answer(run, screens, '', { data: pcmToWav(pcm, 16000), format: 'wav' });
      return;
    }
    let transcript: string;
    try {
      transcript = await listen.transcript(this.timeouts.transcriptMs);
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
    screens: Promise<ScreenCapture>,
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
      if (t?.to === 'cancelled') this.deps.overlay.message(NO_SPEECH, 'info');
      this.finish(run, 'cancelled', 'no speech detected');
      return;
    }

    let chat: VisionChatProvider;
    let speech: SpeechFactory;
    try {
      chat = this.deps.chat();
      speech = this.deps.speech();
    } catch (e) {
      this.fail(run, e, 'config');
      return;
    }
    run.latency.setMeta('chat', chat.id);
    if (chat.model) run.latency.setMeta('model', chat.model);
    if (speech.id) run.latency.setMeta('voice', speech.id);

    let result: AnswerRunResult;
    try {
      const userContext = this.deps.userContext?.();
      result = await runAnswer({
        chat,
        speech,
        screens,
        question,
        ...(audio ? { audio } : {}),
        history: this.deps.recentTurns(),
        ...(userContext ? { userContext } : {}),
        maxTokens: this.deps.maxTokens ?? 1500,
        timeouts: this.timeouts,
        signal,
        now: this.now,
        trace: run.latency,
        hooks: {
          point: (target, label) => this.deps.overlay.point(target, label),
          caption: (text) => {
            run.answer = text;
            this.deps.overlay.caption?.(text);
          },
          heard: (q) => {
            if (!run.question) run.question = q;
          },
          firstAudio: () => {
            if (this.run === run) this.machine.dispatch({ type: 'firstAudio' });
          },
          speechFailed: (e) => {
            if (!run.finished) this.fail(run, e, 'speech');
          },
          ...(this.deps.log ? { log: this.deps.log } : {}),
        },
      });
    } catch (e) {
      // Anything unexpected must end in a visible error, never a stuck "thinking".
      if (!signal.aborted) this.fail(run, e, 'answer');
      return;
    }
    if (signal.aborted) return;
    run.answer = result.answer;
    run.pointLabel = result.pointLabel;
    if (result.heard && !run.question) run.question = result.heard;
    if (result.outcome === 'no-speech') {
      this.deps.overlay.message(NO_SPEECH, 'info');
      this.machine.dispatch({ type: 'cancel', reason: 'no speech detected' });
      return;
    }
    // A very short answer can finish before first audio was reported (e.g. muted output).
    if (this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    run.latency.mark('done');
    this.machine.dispatch({ type: 'speechDone' });
    this.finish(run, 'answered');
  }

  private fail(run: Run, e: unknown, stage: Stage): void {
    if (run.finished) return;
    const err = classifyFailure(e, stage);
    const message = userMessage(err);
    const who = err.provider ? { provider: err.provider } : {};
    run.latency.setFailure({ stage: err.stage, kind: err.kind, ...who });
    run.latency.event(err.stage, 'failed', { kind: err.kind, ...who });
    this.deps.log?.(
      `interaction ${run.interaction.id} failed in ${err.stage} (${err.kind}${err.provider ? `, ${err.provider}` : ''}): ${
        e instanceof Error ? (e.stack ?? e.message) : String(e)
      }`,
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

  /** Called on cancel/error transitions: stop the mic and STT for that interaction. */
  private teardown(interactionId: string): void {
    const run = this.run;
    if (!run || run.interaction.id !== interactionId) return;
    clearTimeout(run.listenTimer);
    // Answer and voice stages stop themselves on the aborted signal. The mic is shared: stop it again
    // even if key-up already did, in case a slow mic start finished after that.
    if (run.listen) {
      this.deps.mic.stop();
      run.listen.close();
    }
    if (!run.finished) {
      // run.interaction is a snapshot; the live interaction has the end reason.
      const live = this.machine.interaction;
      const reason = live?.id === run.interaction.id ? live.endReason : null;
      this.finish(run, this.machine.state === 'error' ? 'error' : 'cancelled', reason ?? undefined);
    }
  }
}
