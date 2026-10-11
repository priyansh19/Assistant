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

import { actionGoal, agentGoal, runAgent, type AgentDeps, type AgentResult } from './agent.js';
import { pcmToWav } from './audio.js';
import { ConfigError, classifyFailure, userMessage, type Stage } from './errors.js';
import type { HistoryEntry } from './history.js';
import { InteractionMachine, type Interaction, type InteractionState } from './interaction.js';
import { LatencyRecorder, type LatencySummary } from './latency.js';
import { answerSystemPrompt, runAnswer, type AnswerRunInput, type AnswerRunResult } from './pipeline/answer-runner.js';
import { delay, withTimeout } from './pipeline/budget.js';
import { ListenStage } from './pipeline/listen-stage.js';
import { HeldTrace, sameQuestion, worthSpeculating, type AnswerTrace } from './pipeline/speculation.js';
import type { CapturePort, InputPort, MicPort, OverlayPort, ScreenCapture } from './ports.js';
import type { ChatTurn, SttProvider, VisionChatProvider, VisionChatRequest } from './providers.js';
import type { AgentConfirmMode } from './settings.js';
import type { SpeechFactory } from './speech.js';
import {
  backspaceCount,
  isTerminal,
  planDictation,
  SayTagSplitter,
  TypingQueue,
  UNDO_WINDOW_MS,
  writeQuestion,
  writeSystemPrompt,
  type AppInfo,
  type LastInsert,
  type WriteContext,
} from './write.js';

/** OpenRouter may report a dated variant of the model asked for (e.g. …-001). */
function sameModel(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function shortModel(id: string): string {
  return id.split('/').pop() ?? id;
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
  /** Profile and playbooks for the prompt, for the app in front when known. */
  userContext?(app?: AppInfo | null): string | undefined;
  timeouts?: Partial<Timeouts>;
  /** Speed features to use for the next question (architecture §7). All off when absent. */
  speed?(): SpeedOptions;
  /** Mouse and keyboard, for dictation and agent mode. Both are unavailable without it. */
  input?: InputPort;
  /** Speech-to-text for dictation, when it differs from stt() (e.g. the model listens directly). */
  dictationStt?(): SttProvider;
  /** Agent mode settings; agent requests are answered normally when absent or disabled. */
  agent?(): { enabled: boolean; confirm: AgentConfirmMode; ready?: boolean };
  /** Agent mode was asked for but isn't set up (off, or rules not accepted): open its setup. */
  agentNotReady?(): void;
  /** Extra agent hooks from the app: never-touch list, pause, user takeover, step strip. */
  agentHooks?(): Pick<AgentDeps, 'blockedApp' | 'whilePaused' | 'userInterrupted' | 'onProgress'>;
  /** Ask the user to allow an agent step. */
  confirm?(text: string, signal: AbortSignal): Promise<boolean>;
  /** Write mode: the app in front and any selected text, read at key-up. */
  writeContext?(signal: AbortSignal): Promise<WriteContext>;
  /** Move the companion to the text caret (agent typing steps). */
  atCaret?(): void;
  /** Write mode: tidy plain dictation with the AI before typing it. */
  tidyDictation?(): boolean;
  /** Write mode: the hint shown after an insert, e.g. "Tap Right Alt to undo". */
  undoHint?(): string;
  /** Learn the user's writing style from a write-mode screenshot (runs in the background). */
  learnFromScreen?(screens: ScreenCapture, app: AppInfo | null): void;
  /** Learn from the user's own dictated words. */
  learnFromDictation?(text: string, app: AppInfo | null): void;
}

export interface SpeedOptions {
  /** Start speaking at the first clause. */
  eagerFirstClause?: boolean;
  /** Send the question at key-up on the interim transcript. */
  speculate?: boolean;
  /** Send the screenshot ahead while the key is held (providers with warmCache only). */
  warmCache?: boolean;
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

/**
 * With cache warm-up, the screenshot is taken this long after key-down (after the tap threshold,
 * so a tap never sends anything, and after the Clicky window has moved out of the shot).
 */
export const WARM_CAPTURE_DELAY_MS = 300;

const NO_SPEECH = "I didn't catch that. Hold the key and try again.";

/** An answer started on the interim transcript, waiting for the final one. */
interface Speculation {
  chat: VisionChatProvider;
  speech: SpeechFactory;
  result: Promise<AnswerRunResult>;
  confirm(): void;
  discard(): void;
}

interface Run {
  /** 'dictate': the transcript is typed into the focused app; no screenshot, no AI, no history. */
  mode: 'answer' | 'dictate';
  /** Keep this interaction in history (false for plain dictation). */
  record: boolean;
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
  /** Turns sent as context, fixed at key-down so a cache warm-up and the request match. */
  history: ChatTurn[];
  speed: SpeedOptions;
  /** The screenshot taken during the press for the cache warm-up; used for the answer too. */
  earlyScreens?: Promise<ScreenCapture>;
  /** A warm-up request went out for this press. */
  cacheWarmed: boolean;
  listenTimer?: ReturnType<typeof setTimeout>;
  result?: AskResult;
}

export class Orchestrator {
  readonly machine: InteractionMachine;
  private run: Run | null = null;
  /** The last write-mode insert, for one-tap undo and "shorter"-style rewrites. */
  private lastInsert: LastInsert | null = null;
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

  private newRun(
    interaction: Interaction,
    source: HistoryEntry['source'],
    question: string,
    mode: Run['mode'] = 'answer',
  ): Run {
    const latency = new LatencyRecorder(interaction.id, this.now);
    latency.mark('keyDown');
    latency.setMeta('source', source);
    const run: Run = {
      mode,
      record: mode !== 'dictate',
      interaction,
      latency,
      source,
      question,
      answer: '',
      pointLabel: null,
      listen: null,
      keyDownAt: this.now(),
      finished: false,
      history: this.deps.recentTurns(),
      speed: this.deps.speed?.() ?? {},
      cacheWarmed: false,
    };
    this.run = run;
    return run;
  }

  /** Hold-to-talk key pressed. */
  keyDown(): void {
    this.press('answer');
  }

  /** Dictation key pressed: listen only, then type the words into the focused app at key-up. */
  dictateDown(): void {
    this.press('dictate');
  }

  private press(mode: Run['mode']): void {
    const t = this.machine.dispatch({ type: 'keyDown' });
    if (!t) return;
    const interaction = this.machine.interaction;
    if (!interaction) return;
    const run = this.newRun(interaction, 'voice', '', mode);
    const dictating = mode === 'dictate';
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
    if (dictating || !(this.deps.listensDirectly?.() ?? false)) {
      try {
        stt = dictating ? (this.deps.dictationStt?.() ?? this.deps.stt()) : this.deps.stt();
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
      now: this.now,
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
    if (run.speed.warmCache && !run.listen.direct && !dictating) this.warmCache(run);
  }

  /**
   * Take the screenshot early and send it, with the system prompt and context, to the model's
   * prompt cache while the user is still talking. The answer then uses the same screenshot, so
   * its prefix matches byte for byte and the model skips re-reading the image.
   */
  private warmCache(run: Run): void {
    let chat: VisionChatProvider;
    try {
      chat = this.deps.chat();
    } catch {
      return;
    }
    const warm = chat.warmCache?.bind(chat);
    if (!warm) return;
    const { signal } = run.interaction;
    const screens = delay(WARM_CAPTURE_DELAY_MS).then(() => {
      if (signal.aborted) throw new Error('cancelled');
      return this.deps.capture.take(signal);
    });
    run.earlyScreens = screens;
    screens.then(
      (s) => {
        if (signal.aborted || this.machine.state !== 'listening') return;
        run.cacheWarmed = true;
        run.latency.event('answer', 'cache-warm-sent');
        const userContext = this.deps.userContext?.();
        warm({
          system: answerSystemPrompt(s, userContext ? { userContext } : {}),
          history: run.history,
          images: s.images,
          signal,
        })
          .then(() => run.latency.event('answer', 'cache-warm-done'))
          .catch((e: unknown) => {
            if (!signal.aborted) this.deps.log?.(`cache warm-up failed: ${String(e)}`);
          });
      },
      () => undefined,
    );
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
      if (run.mode === 'dictate') void this.undoLastInsert();
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
    if (run.mode === 'dictate') return this.dictate(run, listen);
    // With a warm-up, the answer uses that screenshot (if taking it failed, take one now).
    const screens = run.earlyScreens
      ? run.earlyScreens.catch(() => this.deps.capture.take(signal))
      : this.deps.capture.take(signal);
    screens.catch(() => undefined); // handled in answer()
    // The interim transcript often already holds the whole question: start answering it now.
    const partial = listen.partial;
    const spec =
      run.speed.speculate &&
      !listen.direct &&
      !this.agentRequest(partial) &&
      worthSpeculating(partial, this.now() - listen.partialAt)
        ? this.speculate(run, screens, partial)
        : null;
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
      spec?.discard();
      if (!signal.aborted) this.fail(run, e, 'stt');
      return;
    }
    if (signal.aborted) return spec?.discard();
    run.question = transcript.trim();
    if (spec) {
      const hit = sameQuestion(partial, transcript);
      run.latency.setMeta('speculation', hit ? 'hit' : 'miss');
      run.latency.event('answer', hit ? 'speculation-hit' : 'speculation-miss');
      if (hit) return this.answer(run, screens, transcript, undefined, spec);
      spec.discard();
    }
    await this.answer(run, screens, transcript);
  }

  /**
   * Start the answer on the interim transcript. Nothing is shown, spoken or traced until
   * confirm(); discard() aborts the request.
   */
  private speculate(run: Run, screens: Promise<ScreenCapture>, question: string): Speculation | null {
    let chat: VisionChatProvider;
    let speech: SpeechFactory;
    try {
      chat = this.deps.chat();
      speech = this.deps.speech();
    } catch {
      return null; // the real path reports the config problem
    }
    const { signal } = run.interaction;
    const ac = new AbortController();
    const follow = (): void => ac.abort();
    signal.addEventListener('abort', follow, { once: true });
    let verdict!: (ok: boolean) => void;
    const confirm = new Promise<boolean>((resolve) => (verdict = resolve));
    const trace = new HeldTrace(this.now);
    const result = runAnswer(
      this.answerInput(run, { chat, speech, screens, question, signal: ac.signal, trace, confirm }),
    );
    result.catch(() => undefined); // awaited in answer() on a hit
    return {
      chat,
      speech,
      result,
      confirm: () => {
        trace.commit(run.latency);
        verdict(true);
      },
      discard: () => {
        trace.drop();
        signal.removeEventListener('abort', follow);
        ac.abort();
        verdict(false);
      },
    };
  }

  private answerInput(
    run: Run,
    p: {
      chat: VisionChatProvider;
      speech: SpeechFactory;
      screens: Promise<ScreenCapture>;
      question: string;
      signal: AbortSignal;
      trace: AnswerTrace;
      audio?: VisionChatRequest['audio'];
      confirm?: Promise<boolean>;
    },
  ): AnswerRunInput {
    const userContext = this.deps.userContext?.();
    return {
      chat: p.chat,
      speech: p.speech,
      screens: p.screens,
      question: p.question,
      ...(p.audio ? { audio: p.audio } : {}),
      history: run.history,
      ...(userContext ? { userContext } : {}),
      maxTokens: this.deps.maxTokens ?? 1500,
      timeouts: this.timeouts,
      signal: p.signal,
      now: this.now,
      trace: p.trace,
      ...(run.speed.eagerFirstClause ? { eagerFirstClause: true } : {}),
      ...(p.confirm ? { confirm: p.confirm } : {}),
      ...(run.cacheWarmed ? { cache: true } : {}),
      hooks: {
        point: (target, label) => this.deps.overlay.point(target, label),
        draw: (shape) => this.deps.overlay.draw?.(shape),
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
    };
  }

  private async answer(
    run: Run,
    screens: Promise<ScreenCapture>,
    question: string,
    audio?: VisionChatRequest['audio'],
    spec?: Speculation,
  ): Promise<void> {
    const { signal } = run.interaction;
    if (signal.aborted) return spec?.discard();
    run.latency.mark('transcriptFinal');
    // With audio the question text comes back from the model ([HEARD:...]); the machine only needs non-empty.
    const t = this.machine.dispatch({ type: 'transcriptFinal', text: audio ? '(voice)' : question });
    if (!t || t.to !== 'thinking') {
      // Empty transcript → the machine cancelled. Tell the user why instead of silently resetting.
      if (t?.to === 'cancelled') this.deps.overlay.message(NO_SPEECH, 'info');
      spec?.discard();
      this.finish(run, 'cancelled', 'no speech detected');
      return;
    }

    let chat: VisionChatProvider;
    let speech: SpeechFactory;
    if (spec) {
      ({ chat, speech } = spec);
    } else {
      try {
        chat = this.deps.chat();
        speech = this.deps.speech();
      } catch (e) {
        this.fail(run, e, 'config');
        return;
      }
    }
    run.latency.setMeta('chat', chat.id);
    if (chat.model) run.latency.setMeta('model', chat.model);
    if (speech.id) run.latency.setMeta('voice', speech.id);

    const agent = audio ? null : this.agentRequest(question);
    if (agent?.setup) {
      spec?.discard();
      this.deps.agentNotReady?.();
      await this.sayOnly(run, speech, "Agent mode isn't set up yet. I've opened its setup; it takes thirty seconds.");
      return;
    }
    if (agent) {
      spec?.discard();
      const go = !agent.ask || ((await this.deps.confirm?.(`Do this for you: ${agent.goal}`, signal)) ?? false);
      if (signal.aborted) return;
      if (go) {
        await this.runAgentTask(run, chat, speech, agent.goal, agent.confirm);
        return;
      }
      // Not now: answer the question the usual way (guide and point).
    }

    let result: AnswerRunResult;
    try {
      if (spec) {
        spec.confirm();
        result = await spec.result;
      } else {
        result = await runAnswer(
          this.answerInput(run, {
            chat,
            speech,
            screens,
            question,
            signal,
            trace: run.latency,
            ...(audio ? { audio } : {}),
          }),
        );
      }
    } catch (e) {
      // Anything unexpected must end in a visible error, never a stuck "thinking".
      if (!signal.aborted) this.fail(run, e, 'answer');
      return;
    }
    if (signal.aborted) return;
    run.answer = result.answer;
    run.pointLabel = result.pointLabel;
    const served = chat.servedModel;
    if (served && chat.model && !sameModel(served, chat.model)) {
      run.latency.setMeta('servedModel', served);
      this.deps.log?.(`${chat.model} was busy; ${served} answered`);
      this.deps.overlay.message(`${shortModel(chat.model)} was busy, so ${shortModel(served)} answered.`, 'info');
    }
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

  /** The task, if this question asks agent mode to do something and agent mode is on. */
  private agentRequest(
    question: string,
  ): { goal: string; confirm: AgentConfirmMode; ask: boolean; setup?: boolean } | null {
    const cfg = this.deps.agent?.();
    if (!cfg) return null;
    const goal = agentGoal(question);
    // Asked by name while agent mode isn't set up: offer the setup instead of acting.
    if (goal && (!cfg.enabled || cfg.ready === false)) return { goal, confirm: cfg.confirm, ask: false, setup: true };
    if (!cfg.enabled || cfg.ready === false) return null;
    if (goal) return { goal, confirm: cfg.confirm, ask: false };
    // Phrased as a request but without "Agent": offer to do it, and only start once the user agrees.
    const action = this.deps.confirm ? actionGoal(question) : null;
    return action ? { goal: action, confirm: cfg.confirm, ask: true } : null;
  }

  private async dictate(run: Run, listen: ListenStage): Promise<void> {
    const { signal } = run.interaction;
    await delay(MIC_TAIL_MS);
    if (this.run === run) listen.stopMic();
    if (signal.aborted) return;
    // Read the app and any selection while the transcript finalises.
    const contextP: Promise<WriteContext> = this.deps.writeContext
      ? this.deps.writeContext(signal).catch(() => ({ app: null, selection: null }))
      : Promise.resolve({ app: null, selection: null });
    let text: string;
    try {
      text = (await listen.transcript(this.timeouts.transcriptMs)).trim();
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, 'stt');
      return;
    }
    if (signal.aborted) return;
    run.latency.mark('transcriptFinal');
    const t = this.machine.dispatch({ type: 'transcriptFinal', text });
    if (!t || t.to !== 'thinking') {
      if (t?.to === 'cancelled') this.deps.overlay.message(NO_SPEECH, 'info');
      this.finish(run, 'cancelled', 'no speech detected');
      return;
    }
    const input = this.deps.input;
    if (!input) return this.fail(run, new ConfigError('Typing into other apps is not available here.'), 'config');
    const context = await contextP;
    if (signal.aborted) return;
    const last = this.lastInsert;
    let plan = planDictation(text, { hasSelection: !!context.selection, last, now: this.now() });
    if (plan.kind === 'revise' && last?.app?.process !== context.app?.process)
      plan = { kind: 'write', instruction: plan.instruction };
    run.question = text;
    run.record = plan.kind !== 'plain';
    run.latency.setMeta('write', plan.kind);

    const terminal = isTerminal(context.app);
    const shape = (s: string): string => (terminal ? s.replace(/\s*\n\s*/g, ' ') : s);
    const queue = new TypingQueue((chunk) => input.run({ kind: 'type', text: chunk }, signal));
    let firstTyped = false;
    const typeNow = (chunk: string): void => {
      if (!chunk) return;
      if (!firstTyped) {
        firstTyped = true;
        run.latency.mark('firstAudio'); // first text at the cursor is this mode's "first audio"
      }
      queue.push(shape(chunk));
    };

    let chat: VisionChatProvider | null = null;
    const wantsAi = plan.kind !== 'plain' || (this.deps.tidyDictation?.() ?? false);
    if (wantsAi) {
      try {
        chat = this.deps.chat();
      } catch (e) {
        if (plan.kind !== 'plain') return this.fail(run, e, 'config');
        // No AI configured: plain dictation is typed as heard.
      }
    }

    let say: string | null = null;
    let typed: string;
    let learnFrom: ScreenCapture | null = null;
    try {
      if (plan.kind === 'revise' && last) {
        await input.run({ kind: 'backspace', count: backspaceCount(last.text) }, signal);
      }
      if (!chat) {
        typeNow(text);
      } else {
        const tidyOnly = plan.kind === 'plain';
        const screens = tidyOnly ? null : await this.deps.capture.take(signal);
        if (signal.aborted) return;
        if (screens) learnFrom = screens;
        const opts = {
          plan,
          context,
          previous: last,
          ...(screens
            ? {
                screens: screens.images.map((img, i) => ({
                  width: img.width,
                  height: img.height,
                  hasCursor: i + 1 === screens.cursorScreen,
                })),
              }
            : {}),
        };
        const userContext = this.deps.userContext?.(context.app);
        const request = {
          system: writeSystemPrompt({ ...opts, ...(userContext ? { userContext } : {}) }),
          history: [],
          question: writeQuestion(opts),
          images: screens?.images ?? [],
          maxTokens: tidyOnly ? 600 : 1200,
          signal,
        };
        run.latency.setMeta('chat', chat.id);
        run.latency.mark('requestSent');
        const splitter = new SayTagSplitter();
        try {
          const it = chat.stream(request)[Symbol.asyncIterator]();
          const started = this.now();
          try {
            for (let first = true; ; first = false) {
              const left = first
                ? this.timeouts.firstTokenMs
                : Math.max(1, this.timeouts.answerMs - (this.now() - started));
              const r = await withTimeout(it.next(), left, 'answer', 'the writing', signal);
              if (r.done) break;
              if (first) run.latency.mark('firstToken');
              typeNow(splitter.push(r.value));
            }
          } finally {
            void it.return?.().catch(() => undefined);
          }
          const tail = splitter.end();
          typeNow(tail.text);
          say = tail.say;
        } catch (e) {
          if (signal.aborted) return;
          // Tidying failed before anything was typed: the user's words still go in, as heard.
          if (tidyOnly && !firstTyped) {
            this.deps.log?.(`dictation tidy failed, typing as heard: ${String(e)}`);
            typeNow(text);
          } else throw e;
        }
      }
      await queue.flush();
      typed = queue.typed;
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, plan.kind === 'plain' && !chat ? 'app' : 'answer');
      if (queue.typed) this.rememberInsert(queue.typed, context, plan, text);
      return;
    }
    if (signal.aborted) {
      if (queue.typed) this.rememberInsert(queue.typed, context, plan, text);
      return;
    }
    if (!typed && plan.kind !== 'plain') {
      return this.fail(run, new Error('the AI wrote nothing to insert'), 'answer');
    }
    // Plain dictation continues the sentence naturally next time.
    if (plan.kind === 'plain' && typed && !terminal) {
      await input.run({ kind: 'type', text: ' ' }, signal).catch(() => undefined);
      typed += ' ';
    }
    this.rememberInsert(typed, context, plan, text);
    run.answer = typed;
    if (learnFrom) this.deps.learnFromScreen?.(learnFrom, context.app);
    else if (plan.kind === 'plain' && typed.trim()) this.deps.learnFromDictation?.(typed.trim(), context.app);
    if (plan.kind !== 'plain') {
      const hint = this.deps.undoHint?.();
      if (hint) this.deps.overlay.message(hint, 'info');
    }
    if (say) {
      let speech: SpeechFactory | null;
      try {
        speech = this.deps.speech();
      } catch {
        speech = null; // no voice configured: the insert itself is the confirmation
      }
      if (speech) {
        const out = speech.create(signal);
        out.onFirstAudio(() => {
          if (this.run === run && this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
        });
        out.say(say ?? '');
        out.end();
        await withTimeout(out.done, 30_000, 'speech', 'saying the confirmation', signal).catch(() => out.stop());
        if (signal.aborted) return;
      }
    }
    if (this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    run.latency.mark('done');
    this.machine.dispatch({ type: 'speechDone' });
    this.finish(run, 'answered');
  }

  private rememberInsert(text: string, context: WriteContext, plan: { kind: string }, instruction: string): void {
    const replaced = plan.kind === 'revise' ? (this.lastInsert?.replaced ?? null) : context.selection;
    this.lastInsert = { text, replaced, instruction, at: this.now(), app: context.app };
  }

  /** Tap of the dictation key: take back the last insert (and restore what it replaced). */
  private async undoLastInsert(): Promise<void> {
    const last = this.lastInsert;
    const input = this.deps.input;
    if (!last || !input || this.now() - last.at > UNDO_WINDOW_MS) return;
    this.lastInsert = null;
    const signal = new AbortController().signal;
    try {
      await input.run({ kind: 'backspace', count: backspaceCount(last.text) }, signal);
      if (last.replaced) await input.run({ kind: 'type', text: last.replaced }, signal);
      this.deps.overlay.message('Undone.', 'info');
    } catch (e) {
      this.deps.overlay.message(`Couldn't undo: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  private async runAgentTask(
    run: Run,
    chat: VisionChatProvider,
    speech: SpeechFactory,
    goal: string,
    confirmMode: AgentConfirmMode,
  ): Promise<void> {
    const { signal } = run.interaction;
    const { input, confirm } = this.deps;
    if (!input || !confirm) return this.fail(run, new ConfigError('Agent mode is not available here.'), 'config');
    run.latency.setMeta('agent', true);
    const userContext = this.deps.userContext?.();
    let result: AgentResult;
    try {
      result = await runAgent(goal, {
        chat,
        capture: this.deps.capture,
        input,
        overlay: this.deps.overlay,
        confirm,
        confirmMode,
        signal,
        ...(userContext ? { userContext } : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
        onStep: (say) => this.deps.overlay.caption?.(say),
        ...(this.deps.atCaret ? { atCaret: () => this.deps.atCaret?.() } : {}),
        ...(this.deps.agentHooks?.() ?? {}),
      });
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, 'answer');
      return;
    }
    if (signal.aborted) return;
    this.deps.log?.(`agent ${result.outcome} after ${result.steps.length} steps`);
    run.answer = result.summary;
    const out = speech.create(signal);
    out.onFirstAudio(() => {
      if (this.run === run && this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    });
    out.say(result.summary);
    out.end();
    try {
      await withTimeout(out.done, 30_000, 'speech', 'saying the result', signal);
    } catch (e) {
      out.stop();
      if (!signal.aborted) this.fail(run, e, 'speech');
      return;
    }
    if (signal.aborted) return;
    if (this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    run.latency.mark('done');
    this.machine.dispatch({ type: 'speechDone' });
    this.finish(
      run,
      result.outcome === 'done' ? 'answered' : 'error',
      result.outcome === 'done' ? undefined : result.summary,
    );
  }

  /** Speak one sentence as the whole answer (used for "agent mode isn't set up"). */
  private async sayOnly(run: Run, speech: SpeechFactory, text: string): Promise<void> {
    const { signal } = run.interaction;
    run.answer = text;
    this.deps.overlay.message(text, 'info');
    const out = speech.create(signal);
    out.onFirstAudio(() => {
      if (this.run === run && this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    });
    out.say(text);
    out.end();
    await withTimeout(out.done, 20_000, 'speech', 'saying it', signal).catch(() => out.stop());
    if (signal.aborted) return;
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
    // Plain dictation is the user's own words: typed, not kept. Write instructions are kept.
    if (run.record && (run.question || run.answer)) {
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
