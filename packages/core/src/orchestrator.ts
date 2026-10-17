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

import { agentGoal, onScreenDrawing, runAgent, type AgentDeps, type AgentResult } from './agent.js';
import { pcmToWav } from './audio.js';
import { afterBeat, BeatPicker, speakBeat, type BeatKind } from './beat.js';
import { wantsDeep } from './deep.js';
import {
  GuideSession,
  guideFollowUpQuestion,
  screenSettled,
  type GuideDecision,
  type GuideEndReason,
  type GuideInput,
  type GuideSettings,
  type GuideTarget,
} from './guide.js';
import { bareGreeting, memoryNote, noteRefusal } from './memory.js';
import { visibleText } from './final-message.js';
import { ConfigError, classifyFailure, userMessage, type Stage } from './errors.js';
import type { HistoryEntry } from './history.js';
import { InteractionMachine, isResting, type Interaction, type InteractionState } from './interaction.js';
import { LatencyRecorder, type LatencySummary } from './latency.js';
import { answerSystemPrompt, runAnswer, type AnswerRunInput, type AnswerRunResult } from './pipeline/answer-runner.js';
import { delay, withTimeout } from './pipeline/budget.js';
import {
  parseSketch,
  parseSketchCheck,
  placeSketch,
  SKETCH_CHECK_PROMPT,
  SKETCH_PROMPT,
  sketchKey,
  sketchSubject,
  sketchToSvg,
  sketchUnclear,
  type Sketch,
} from './sketch.js';
import { ListenStage } from './pipeline/listen-stage.js';
import { splitWake } from './wake.js';
import { HeldTrace, sameQuestion, worthSpeculating, type AnswerTrace } from './pipeline/speculation.js';
import type { CapturePort, GuidePort, InputPort, MicPort, OverlayPort, ScreenCapture } from './ports.js';
import type { ChatTurn, ImageInput, SttProvider, VisionChatProvider, VisionChatRequest } from './providers.js';
import type { AgentConfirmMode } from './settings.js';
import type { SpeechFactory } from './speech.js';
import {
  backspaceCount,
  faithfulTidy,
  isTerminal,
  needsTidy,
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

/** How an agent task runs: as a named helper, with a repeat set up after the first run. */
export interface AgentTaskPlan {
  goal: string;
  /** Added to the agent's briefing (the helper's identity, job and notes). */
  briefing?: string;
  /** The helper's name, for the run log. */
  helper?: string;
  /** Said after the result when the run worked ("I'll do this every day at 08:00…"). */
  after?: string;
}

export interface OrchestratorDeps {
  /** Render a sketch's SVG to a picture so the model can check what it drew (null if it can't). */
  renderSketch?(svg: string): Promise<ImageInput | null>;
  /** Drawings that passed the check, by subject, so the same subject is right at once next time. */
  sketchLibrary?: { get(key: string): Sketch | undefined; put(key: string, sketch: Sketch): void };
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
  agentHooks?(): Pick<
    AgentDeps,
    | 'blockedApp'
    | 'whilePaused'
    | 'userInterrupted'
    | 'onProgress'
    | 'saveSheet'
    | 'openWindows'
    | 'elements'
    | 'planFirst'
    | 'otherAgent'
    | 'listFiles'
    | 'findFiles'
    | 'moveFiles'
    | 'allowAll'
    | 'pathPolicy'
    | 'fileExists'
    | 'focusIsPassword'
    | 'budget'
  >;
  /** Ask the user to allow an agent step (the run decides when to ask; this only asks). */
  confirm?: AgentDeps['confirm'];
  /** An agent run ended, however it ended (done, failed, stopped or an error). */
  agentRunEnded?(): void;
  /** Write mode: the app in front and any selected text, read at key-up. */
  writeContext?(signal: AbortSignal): Promise<WriteContext>;
  /** The model for agent steps, when it differs from chat() (agents need precise click positions). */
  agentChat?(): VisionChatProvider;
  /** Installed apps and common folders, for agent mode's open action. */
  inventory?(): { apps: string[]; folders: string[] } | undefined;
  /** Save something the user asked Clicky to remember (a correction, a preference). */
  remember?(note: string): void;
  /** Hints from earlier successful runs of a similar task (continuous learning). */
  agentHints?(goal: string): string | undefined;
  /** Skills (task playbooks) that match the task, and Clicky's standing briefing (agents.md). */
  agentSkills?(goal: string): string | undefined;
  agentBriefing?(): string | undefined;
  /**
   * Before an agent task: the named helper that does it (its briefing and notes), a repeat to set
   * up ("every morning…"), and the goal without the cadence words. Null to run the goal as is.
   */
  agentTaskPlan?(goal: string): AgentTaskPlan | null;
  /** "Pitch Lab, remember…": keep a note for that helper. The line to say, or null if not one. */
  helperNote?(question: string): string | null;
  /** A run finished: its steps and their checks, for the run log and learning. */
  agentRunFinished?(goal: string, result: AgentResult): void;
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
  /** The stronger model for hard questions; null or absent when there is none distinct from chat(). */
  deepChat?(): VisionChatProvider | null;
  /** Ring a walkthrough step on screen (absent: no guided walkthroughs). */
  guide?: GuidePort;
  /** Walkthrough timings and limits, when they differ from GUIDE_DEFAULTS. */
  guideSettings?: Partial<GuideSettings>;
  /** Voice and guidance features that are switched on. Each is off when absent. */
  features?(): VoiceFeatures;
}

export interface VoiceFeatures {
  /** A short spoken beat ("On it.") before slow work: agent tasks, hard questions, drawings. */
  beats?: boolean;
  /** Hard questions go to the stronger model (deepChat). */
  deep?: boolean;
  /** Multi-click how-to questions become guided walkthroughs that advance on the user's own clicks. */
  walkthroughs?: boolean;
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

/** An answer admitting the screen doesn't show it ("I can't see how much space is left"). */
const CANT_SEE =
  /\b(?:can'?t|cannot|can not|unable to|don'?t|do not)\s+(?:see|tell|find|determine|show)\b|\b(?:not|isn'?t|aren'?t)\s+(?:currently\s+)?(?:visible|shown|displayed|available|on (?:the|this|your) screen)\b|\byou (?:may|might|would|will) need to (?:open|check|go)\b/i;

/**
 * The answer model said it can't do something, or claimed it did something only the agent can do
 * ("I've opened your Downloads", "I can't open applications", "you can open YouTube by clicking…"):
 * the request was a task, so hand it to the agent instead of leaving the user with that answer.
 */
const NOT_DONE =
  /\b(?:i(?:'ve| have)? (?:opened|created|made|written|typed|saved|closed|moved|copied)|i (?:can'?t|cannot|am unable to|'m unable to|am not able to) (?:open|create|make|access|write|type|save|move|copy|check|control|browse|go to|provide|give|get|look up|search)|you can (?:open|go to|find|access) (?:it|them|\w+)(?: \w+){0,4} by (?:clicking|opening|going|pressing|typing))\b/i;

/** A question rather than a request ("what's the weather…"): the agent is asked to find it out. */
const ASKS = /^(?:how|where|what|what's|why|when|which|who|is|are|does|do|did|can you tell|tell me)\b/i;

/** Asking Clicky to draw over the screen. */
const DRAW_REQUEST =
  /\b(?:draw|sketch|circle|underline|highlight|cross out|tick|write)\b[^.?!]*\b(?:on|over|around|across) (?:my|the|this) screen\b|^(?:\W*(?:hey\s+)?click(?:y|ey)\W+)?(?:please\s+)?(?:draw|sketch|circle|underline|highlight)\b/i;

const DEFAULT_TIMEOUTS: Timeouts = { transcriptMs: 6000, firstTokenMs: 20000, answerMs: 90000 };

/** Keep recording this long after key-up so the last syllable isn't clipped in the audio pipeline. */
export const MIC_TAIL_MS = 80;

/**
 * A key held longer than this is treated as a missed key-up (e.g. Windows switched desktops), and
 * what was said so far is used. It was one minute and threw the words away, which dropped long
 * prompts (2026-10-11).
 */
export const MAX_LISTEN_MS = 5 * 60_000;

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

/** Drawings tried (each checked) before Clicky draws its best one. */
const SKETCH_ATTEMPTS = 3;

/** Longest an answer waits for the list of open windows and tabs. */
const PC_MAP_WAIT_MS = 2500;

/** A key-press screenshot younger than this is good enough for an agent task's first plan. */
export const AGENT_SCREENS_FRESH_MS = 6000;

interface Run {
  /**
   * What's open on the PC (windows, last used, unsaved work, browser tabs), fetched when the key
   * goes down so answers know it ("which apps do I have open?") without hunting the screenshot.
   */
  pcMap?: Promise<string[]>;
  /** This run handed the request to the agent (its summary is the answer). */
  ranTask?: boolean;
  /** The map once it arrived (for the answer prompt). */
  pcMapText?: string;
  /** Marks drawn by this answer (a drawing request that drew nothing is retried once). */
  drawn?: number;
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
  /** When this run's screenshot was taken (an agent task plans over it if it is recent). */
  screensAt?: number;
  /** A warm-up request went out for this press. */
  cacheWarmed: boolean;
  listenTimer?: ReturnType<typeof setTimeout>;
  result?: AskResult;
  /** This run is the next step of a guided walkthrough. */
  guide?: GuideSession;
  /** The beat played for this run (at most one), which later speech waits for. */
  beat?: Promise<void>;
}

/** The walkthrough in progress, if any. */
interface GuideState {
  session: GuideSession;
  ticker: ReturnType<typeof setInterval> | null;
  /** The follow-up waiting for the screen to settle. */
  pending: ReturnType<typeof setTimeout> | null;
  /** The follow-up answer in flight. */
  followUp: Run | null;
  /** That follow-up was cancelled to look again; its end must not end the walkthrough. */
  refreshing: boolean;
}

export class Orchestrator {
  readonly machine: InteractionMachine;
  private run: Run | null = null;
  /** The last write-mode insert, for one-tap undo and "shorter"-style rewrites. */
  private lastInsert: LastInsert | null = null;
  private readonly timeouts: Timeouts;
  private readonly now: () => number;
  private readonly beats = new BeatPicker();
  private guideState: GuideState | null = null;

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
    guide?: GuideSession,
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
      // A walkthrough step has its own history in the question; earlier turns would only distract.
      history: guide ? [] : this.deps.recentTurns(),
      speed: this.deps.speed?.() ?? {},
      cacheWarmed: false,
      ...(guide ? { guide } : {}),
    };
    if (mode !== 'dictate' && !guide) {
      const windows = this.deps.agentHooks?.().openWindows;
      if (windows) {
        run.pcMap = windows().catch(() => []);
        run.pcMap.catch(() => undefined);
      }
    }
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
    // A new question ends the walkthrough, unless it is waiting for "next" after a manual step.
    if (this.guideState && (this.guideState.session.stage !== 'parked' || mode === 'dictate'))
      this.endGuide('superseded');
    const t = this.machine.dispatch({ type: 'keyDown' });
    if (!t) return;
    const interaction = this.machine.interaction;
    if (!interaction) return;
    const run = this.newRun(interaction, 'voice', '', mode);
    const dictating = mode === 'dictate';
    const { signal } = interaction;
    run.listenTimer = setTimeout(() => {
      if (this.run === run && this.machine.state === 'listening') {
        this.deps.overlay.message('Listening stopped after five minutes; using what you said.', 'info');
        this.keyUp();
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
    run.earlyScreens = this.stamp(run, screens);
    screens.then(
      (s) => {
        if (signal.aborted || this.machine.state !== 'listening') return;
        run.cacheWarmed = true;
        run.latency.event('answer', 'cache-warm-sent');
        const userContext = this.deps.userContext?.();
        warm({
          system: answerSystemPrompt(s, {
            ...(userContext ? { userContext } : {}),
            ...this.taskRouting(),
            ...this.answerModes(run),
          }),
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

  /** Note when the screenshot arrives, so an agent task can tell whether it is still fresh. */
  private stamp(run: Run, screens: Promise<ScreenCapture>): Promise<ScreenCapture> {
    screens.then(
      () => (run.screensAt = this.now()),
      () => undefined,
    );
    return screens;
  }

  /** The run's screenshot, if it is already here and recent enough to plan a task over. */
  private async freshScreens(run: Run, screens?: Promise<ScreenCapture>): Promise<ScreenCapture | undefined> {
    if (!screens) return undefined;
    const shot = await Promise.race([screens.catch(() => null), delay(0).then(() => null)]);
    if (!shot || run.screensAt === undefined || this.now() - run.screensAt > AGENT_SCREENS_FRESH_MS) return undefined;
    return shot;
  }

  /**
   * How long to wait for the final transcript. On-device speech recognition only starts at key-up,
   * so a long recording needs longer (about 0.3 s per second spoken on top of the usual budget).
   */
  private transcriptBudget(listen: ListenStage): number {
    return this.timeouts.transcriptMs + Math.round(listen.recordedSeconds * 300);
  }

  /** Recent agent tasks in this session: what was asked, what was done and how it ended. */
  private readonly recentRuns: { goal: string; outcome: string; summary: string; steps: string[]; at: number }[] = [];

  /** Recent questions, answers and tasks (the last 20 minutes), for follow-ups in agent runs. */
  private conversationText(run: Run): string {
    const lines: string[] = [];
    for (const t of run.history.slice(-8))
      lines.push(`${t.role === 'user' ? 'User' : 'Clicky'}: ${t.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    const since = this.now() - 20 * 60_000;
    for (const r of this.recentRuns.filter((x) => x.at >= since).reverse())
      lines.push(
        `Task "${r.goal.slice(0, 160)}" ${r.outcome}: ${r.summary.slice(0, 200)} Steps: ${r.steps.slice(-8).join('; ').slice(0, 500)}`,
      );
    return lines.join('\n');
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

  /** Esc, or the user asked to stop. Also ends a walkthrough. */
  cancel(reason = 'cancelled'): void {
    this.endGuide('cancelled');
    this.cancelRun(reason);
  }

  private cancelRun(reason: string): void {
    if (this.run && !this.run.finished) this.machine.dispatch({ type: 'cancel', reason });
  }

  /**
   * Ask a typed question (dashboard) or replay a saved action: no microphone, same answer path.
   */
  async ask(question: string, source: 'typed' | 'action'): Promise<AskResult | null> {
    const q = question.trim();
    if (!q) return null;
    if (this.guideState && this.guideState.session.stage !== 'parked') this.endGuide('superseded');
    if (this.run && !this.run.finished) this.cancelRun('replaced by a new question');
    // Not a voice press: a mic test in the dashboard must not be affected.
    this.machine.dispatch({ type: 'keyDown' });
    const interaction = this.machine.interaction;
    if (!interaction) return null;
    const run = this.newRun(interaction, source, q);
    run.latency.mark('keyUp');
    this.machine.dispatch({ type: 'keyUp' });
    const screens = this.stamp(run, this.deps.capture.take(interaction.signal));
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
      ? run.earlyScreens.catch(() => this.stamp(run, this.deps.capture.take(signal)))
      : this.stamp(run, this.deps.capture.take(signal));
    screens.catch(() => undefined); // handled in answer()
    // The interim transcript often already holds the whole question: start answering it now.
    const partial = listen.partial;
    const spec =
      run.speed.speculate &&
      !listen.direct &&
      !this.agentRequest(partial) &&
      !DRAW_REQUEST.test(partial) &&
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
      transcript = await listen.transcript(this.transcriptBudget(listen));
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
      /** This is the stronger model's answer: it can't hand the question on again. */
      deepAnswer?: boolean;
    },
  ): AnswerRunInput {
    const userContext = [
      this.deps.userContext?.() ?? '',
      run.pcMapText
        ? `What is open on the user's PC right now (windows front first, with when each was last used and any unsaved changes; browser tabs indented). This list is exact and covers every screen: answer from it, not from the screenshot, when asked what is open, how many tabs there are, which windows have unsaved changes (only those marked so), where something is, or what they were doing:\n${run.pcMapText}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
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
      ...(run.guide ? {} : this.taskRouting(p.question)),
      ...this.answerModes(run, p.deepAnswer),
      hooks: {
        point: (target, label, opts) => this.deps.overlay.point(target, label, opts),
        target: (target) => this.armGuide(run, target),
        draw: (shape) => {
          run.drawn = (run.drawn ?? 0) + 1;
          // A sketch is a picture, not an annotation: no "eye", "roof", "smile" labels on its parts.
          const sketch = onScreenDrawing(p.question) && /\b(?:draw|sketch)\b/i.test(p.question);
          this.deps.overlay.draw?.(
            sketch && shape.kind !== 'text' && 'label' in shape ? { ...shape, label: '' } : shape,
          );
        },
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
        // Drawings need a model that follows the drawing tags reliably (the cheapest one often says
        // "I've drawn a star" without drawing anything): use the agent model for them.
        chat = DRAW_REQUEST.test(question) ? (this.deps.agentChat?.() ?? this.deps.chat()) : this.deps.chat();
        speech = this.deps.speech();
      } catch (e) {
        this.fail(run, e, 'config');
        return;
      }
    }
    // The PC map started with the key press; wait a moment for it if it isn't in yet.
    if (run.pcMap && run.pcMapText === undefined) {
      const map = await Promise.race([run.pcMap, delay(PC_MAP_WAIT_MS).then(() => null)]);
      run.pcMapText = map?.length ? map.join('\n').slice(0, 6000) : '';
      this.deps.log?.(
        map ? `answer has the PC map: ${map.length} lines` : 'answer without the PC map (it took too long)',
      );
    }
    run.latency.setMeta('chat', chat.id);
    if (chat.model) run.latency.setMeta('model', chat.model);
    if (speech.id) run.latency.setMeta('voice', speech.id);

    // "Next" after a manual walkthrough step carries the walkthrough on; anything else ends it.
    const resumed = run.guide ? null : this.resumeGuide(run, question, audio);
    if (resumed !== null) {
      spec?.discard();
      spec = undefined;
      question = resumed;
    }
    /** A walkthrough step or an audio question: none of the text shortcuts below apply. */
    const plain = !audio && !run.guide;

    // "Comet is on my taskbar", "remember…": keep it for next time instead of answering.
    if (plain && bareGreeting(question)) {
      spec?.discard();
      await this.sayOnly(run, speech, 'Yes? What can I help with?');
      return;
    }
    const helperLine = !plain ? null : (this.deps.helperNote?.(question) ?? null);
    if (helperLine) {
      spec?.discard();
      await this.sayOnly(run, speech, helperLine);
      return;
    }
    const note = !plain || !this.deps.remember ? null : memoryNote(question);
    const refused = note ? noteRefusal(note) : null;
    if (note && refused) {
      spec?.discard();
      this.deps.log?.(`note not kept (${refused.split('.')[0]})`);
      await this.sayOnly(run, speech, `I won't remember that, because ${refused}.`);
      return;
    }
    if (note) {
      spec?.discard();
      this.deps.remember?.(note);
      this.deps.log?.(`remembered: ${note}`);
      await this.sayOnly(run, speech, "Got it, I'll remember that.");
      return;
    }
    // "Draw a bird": an illustration, planned and checked, not a few marks in a spoken answer.
    const subject = plain ? sketchSubject(question) : null;
    if (subject) {
      spec?.discard();
      await this.drawSketch(run, subject, screens, speech);
      return;
    }
    const agent = plain ? this.agentRequest(question) : null;
    if (agent?.setup) {
      spec?.discard();
      this.deps.agentNotReady?.();
      await this.sayOnly(run, speech, "Agent mode isn't set up yet. I've opened its setup; it takes thirty seconds.");
      return;
    }
    if (agent) {
      spec?.discard();
      run.latency.setMeta('routedBy', 'name');
      await this.runAgentTask(run, chat, speech, agent.goal, agent.confirm, false, screens);
      return;
    }

    let result: AnswerRunResult;
    const deepChat = run.guide ? null : this.deepChat();
    try {
      if (deepChat && plain && wantsDeep(question)) {
        // The request itself asks for depth: skip the fast model's round trip.
        spec?.discard();
        run.latency.setMeta('routedBy', 'request');
        result = await this.runDeep(run, screens, question, speech, deepChat);
      } else {
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
        if (result.outcome === 'deep' && deepChat && !signal.aborted) {
          run.latency.setMeta('routedBy', 'model');
          if (result.heard && !run.question) run.question = result.heard;
          result = await this.runDeep(
            run,
            screens,
            run.question || question,
            speech,
            deepChat,
            result.heard ? undefined : audio,
          );
        }
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
    if (result.outcome === 'task' && result.task) {
      // The answer model saw the screen and the conversation and says this is something to do.
      // Its goal is the request restated in full (references resolved, dropped words put back).
      run.latency.setMeta('routedBy', 'model');
      const cfg = this.deps.agent?.();
      await this.runAgentTask(run, chat, speech, result.task, cfg?.confirm ?? 'risky', true, screens);
      return;
    }
    // A very short answer can finish before first audio was reported (e.g. muted output).
    if (this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    run.latency.mark('done');
    this.machine.dispatch({ type: 'speechDone' });
    this.finish(run, 'answered');
    this.afterGuideAnswer(run, result);
    // Asked to draw on the screen and nothing was drawn ("I've written hello" with no marks): try once more.
    if (!run.drawn && run.source !== 'action' && onScreenDrawing(question)) {
      this.deps.log?.(`asked to draw but nothing was drawn; asking again: ${question}`);
      queueMicrotask(() => void this.ask(`${question} (Draw it now with marks on the screen.)`, 'action'));
    }
  }

  // ---- Fast/deep split and spoken beats

  private features(): VoiceFeatures {
    return this.deps.features?.() ?? {};
  }

  /** The stronger model, when hard-question routing is on and there is one. */
  private deepChat(): VisionChatProvider | null {
    if (!this.features().deep) return null;
    try {
      return this.deps.deepChat?.() ?? null;
    } catch {
      return null; // a deep model that isn't configured just means the fast model answers
    }
  }

  /** Which extra hand-offs the answer model is offered (kept identical for the cache warm-up). */
  private answerModes(run: Run, deepAnswer = false): { deep?: true; guide?: 'offer' | 'follow-up' } {
    const guide = run.guide ? 'follow-up' : this.deps.guide && this.features().walkthroughs ? 'offer' : undefined;
    const deep = !deepAnswer && !run.guide && this.deepChat() !== null;
    return { ...(deep ? { deep: true } : {}), ...(guide ? { guide } : {}) };
  }

  /** A hard question: say a beat at once, then let the stronger model answer (after the beat). */
  private runDeep(
    run: Run,
    screens: Promise<ScreenCapture>,
    question: string,
    speech: SpeechFactory,
    chat: VisionChatProvider,
    audio?: VisionChatRequest['audio'],
  ): Promise<AnswerRunResult> {
    run.latency.setMeta('deep', chat.model ?? chat.id);
    run.latency.event('answer', 'deep');
    this.deps.log?.(`hard question: ${chat.model ?? chat.id} answers it`);
    const beat = this.beat(run, speech, 'deep');
    return runAnswer(
      this.answerInput(run, {
        chat,
        speech: afterBeat(speech, beat),
        screens,
        question,
        signal: run.interaction.signal,
        trace: run.latency,
        deepAnswer: true,
        ...(audio ? { audio } : {}),
      }),
    );
  }

  /**
   * Say a short beat now ("On it."), at most once per run, when the beats feature is on. Resolves
   * when it has played; speech that follows waits for it (see voice()).
   */
  private beat(run: Run, speech: SpeechFactory, kind: BeatKind): Promise<void> {
    if (run.beat) return run.beat;
    if (!this.features().beats) return Promise.resolve();
    const line = this.beats.pick(kind);
    run.latency.event('speech', 'beat', { kind });
    run.beat = speakBeat(speech, line, run.interaction.signal, () => run.latency.mark('firstSound'));
    return run.beat;
  }

  /** The voice for this run: after its beat, if one was said. */
  private voice(run: Run, speech: SpeechFactory): SpeechFactory {
    return run.beat ? afterBeat(speech, run.beat) : speech;
  }

  // ---- Guided walkthroughs

  /**
   * Mouse input from the app, for walkthrough targets: button presses and moves, in the coordinate
   * space of the hit areas the guide port returns.
   */
  userInput(ev: { kind: 'click' | 'move'; x: number; y: number; button?: 'left' | 'right' | 'middle' }): void {
    const st = this.guideState;
    if (!st) return;
    const input: GuideInput =
      ev.kind === 'click'
        ? { kind: 'click', x: ev.x, y: ev.y, at: this.now(), ...(ev.button ? { button: ev.button } : {}) }
        : { kind: 'move', x: ev.x, y: ev.y, at: this.now() };
    this.onGuideDecision(st, st.session.input(input));
  }

  /** True while a walkthrough is running (the app forwards mouse input only then). */
  get guiding(): boolean {
    return this.guideState !== null;
  }

  /**
   * An answer rang a step: start (or continue) the walkthrough and arm the target. It is armed while
   * the step is still being spoken, so a quick click counts.
   */
  private armGuide(run: Run, target: GuideTarget): void {
    const port = this.deps.guide;
    if (!port || run.interaction.signal.aborted) return;
    let st = this.guideState;
    if (!st || !run.guide || st.session !== run.guide) {
      this.endGuide('superseded');
      const session = new GuideSession(run.question || 'the request', null, this.deps.guideSettings);
      st = { session, ticker: null, pending: null, followUp: null, refreshing: false };
      this.guideState = st;
      this.deps.log?.(`walkthrough started: ${session.goal.slice(0, 120)}`);
      void port
        .foreground?.()
        .then((app) => {
          if (app && !session.app) session.app = app;
        })
        .catch(() => undefined);
    }
    const state = st;
    const session = state.session;
    if (!session.canArm()) {
      this.deps.log?.(
        `walkthrough target "${target.label}" not armed: ${session.settings.maxRounds} steps is the limit`,
      );
      this.endGuide('round-limit');
      return;
    }
    void port.arm(target).then(
      (area) => {
        if (this.guideState !== state || session.stage === 'ended') return;
        if (!area) {
          this.deps.log?.(`walkthrough target "${target.label}" could not be shown`);
          this.endGuide('failed');
          return;
        }
        if (!session.arm(target, area, this.now())) return this.endGuide('round-limit');
        this.deps.log?.(
          `walkthrough step ${session.armedCount}: ${target.kind} target "${target.label}" armed (radius ${Math.round(area.r)})`,
        );
        state.ticker ??= setInterval(() => this.onGuideDecision(state, session.tick(this.now())), 250);
      },
      (e: unknown) => {
        this.deps.log?.(`walkthrough target failed: ${String(e)}`);
        if (this.guideState === state) this.endGuide('failed');
      },
    );
  }

  private onGuideDecision(st: GuideState, d: GuideDecision): void {
    if (this.guideState !== st) return;
    const s = st.session;
    switch (d.type) {
      case 'hit':
        this.deps.guide?.disarm();
        this.deps.log?.(
          `walkthrough step ${s.armedCount} done: ${d.hover ? 'hovered' : `clicked ${d.distance} px from the centre`}`,
        );
        st.pending = setTimeout(() => {
          st.pending = null;
          void this.guideFollowUp(st);
        }, s.settings.settleMs);
        return;
      case 'miss':
        this.deps.log?.(`walkthrough ended: clicked ${d.distance} px away from "${s.previous?.label ?? 'the target'}"`);
        return this.endGuide('off-target');
      case 'idle':
        this.deps.log?.('walkthrough ended: nobody clicked the target');
        return this.endGuide('idle');
      case 'acted': {
        // Clicked again while the next step was being worked out: look again (once per step), unless
        // the step is already being spoken.
        const run = st.followUp;
        if (run && !run.finished && this.machine.state === 'thinking' && s.shouldRefresh()) {
          this.deps.log?.('walkthrough: the user acted while waiting; looking at the screen again');
          st.refreshing = true;
          this.cancelRun('the screen changed; looking again');
          if (st.pending) clearTimeout(st.pending);
          st.pending = setTimeout(() => {
            st.pending = null;
            void this.guideFollowUp(st);
          }, s.settings.settleMs);
        }
        return;
      }
      case 'none':
        if (s.stage === 'ended') this.endGuide(s.endReason ?? 'done');
        return;
    }
  }

  /** After a step: once the screen has settled, look again and ask for the next step. */
  private async guideFollowUp(st: GuideState): Promise<void> {
    const s = st.session;
    // The user may click while the step is still being spoken: let it finish first.
    const waitFrom = this.now();
    while (!isResting(this.machine.state)) {
      if (this.guideState !== st) return;
      if (this.now() - waitFrom > 20_000) return this.endGuide('failed');
      await delay(100);
    }
    if (this.guideState !== st || s.stage === 'ended') return;
    const app = this.deps.guide?.foreground
      ? await Promise.race([this.deps.guide.foreground().catch(() => null), delay(1500).then(() => null)])
      : null;
    if (this.guideState !== st) return;
    if (s.appChanged(app, this.now()) === 'left') {
      this.deps.log?.(`walkthrough ended quietly: the user switched to ${app ?? 'another app'}`);
      return this.endGuide('app-switch');
    }
    // A new interaction, like a typed question: Esc or a key press stops it.
    if (!this.machine.dispatch({ type: 'keyDown' })) return this.endGuide('failed');
    const interaction = this.machine.interaction;
    if (!interaction) return this.endGuide('failed');
    const run = this.newRun(interaction, 'action', `Walkthrough step ${s.armedCount + 1}: ${s.goal}`, 'answer', s);
    run.latency.mark('keyUp');
    this.machine.dispatch({ type: 'keyUp' });
    st.followUp = run;
    st.refreshing = false;
    s.asking();
    const screens = this.settledCapture(s, interaction.signal);
    screens.catch(() => undefined); // handled in answer()
    await this.answer(run, screens, guideFollowUpQuestion(s));
    if (this.guideState !== st || st.refreshing) return;
    if (run.result?.outcome !== 'answered') {
      this.deps.log?.(`walkthrough ended: the next step ${run.result?.outcome ?? 'failed'}`);
      this.endGuide(run.result?.outcome === 'cancelled' ? 'cancelled' : 'failed');
    }
  }

  /** A screenshot once the screen stops changing (a menu opening, a page loading), within a few tries. */
  private async settledCapture(s: GuideSession, signal: AbortSignal): Promise<ScreenCapture> {
    let shot = await this.deps.capture.take(signal);
    const sizes = (c: ScreenCapture): number[] => c.images.map((i) => i.data.byteLength);
    for (let i = 1; i < s.settings.settleTries && !signal.aborted; i++) {
      await delay(s.settings.settleStepMs);
      const next = await this.deps.capture.take(signal);
      if (screenSettled(sizes(shot), sizes(next))) return next;
      shot = next;
    }
    return shot;
  }

  /** A walkthrough step was answered: with a target it is already armed; without one the walkthrough waits for "next". */
  private afterGuideAnswer(run: Run, result: AnswerRunResult): void {
    const st = this.guideState;
    if (!run.guide || !st || st.session !== run.guide || result.target) return;
    const s = st.session;
    if (s.remaining === 0) {
      this.deps.log?.('walkthrough finished: step limit reached');
      return this.endGuide('round-limit');
    }
    s.park(result.answer, this.now());
    this.deps.log?.('walkthrough: waiting for "next" after a manual step');
    st.ticker ??= setInterval(() => this.onGuideDecision(st, s.tick(this.now())), 250);
  }

  /** "Next" or "done" while a walkthrough waits after a manual step: the follow-up question, else null. */
  private resumeGuide(run: Run, question: string, audio?: VisionChatRequest['audio']): string | null {
    const st = this.guideState;
    if (!st) return null;
    if (audio || !st.session.resumes(splitWake(question).rest || question, this.now())) {
      this.endGuide('superseded');
      return null;
    }
    const s = st.session;
    run.guide = s;
    run.history = [];
    run.question = `Walkthrough step ${s.armedCount + 1}: ${s.goal}`;
    st.followUp = run;
    s.asking();
    this.deps.log?.('walkthrough: the user finished a manual step; next step');
    return guideFollowUpQuestion(s);
  }

  private endGuide(reason: GuideEndReason): void {
    const st = this.guideState;
    if (!st) return;
    this.guideState = null;
    if (st.ticker) clearInterval(st.ticker);
    if (st.pending) clearTimeout(st.pending);
    st.session.end(reason);
    this.deps.guide?.disarm();
    this.deps.log?.(
      `walkthrough over (${reason}): ${st.session.armedCount} target${st.session.armedCount === 1 ? '' : 's'}, ${st.session.history.filter((h) => !h.startsWith('They were asked')).length} step(s) done`,
    );
  }

  /** The task, if this question asks agent mode to do something and agent mode is on. */
  private agentRequest(question: string): { goal: string; confirm: AgentConfirmMode; setup?: boolean } | null {
    const cfg = this.deps.agent?.();
    if (!cfg) return null;
    const goal = agentGoal(question);
    // Asked by name while agent mode isn't set up: offer the setup instead of acting.
    if (goal && (!cfg.enabled || cfg.ready === false)) return { goal, confirm: cfg.confirm, setup: true };
    if (!cfg.enabled || cfg.ready === false) return null;
    // The name plus a request goes straight to the agent with no model call. Everything else goes
    // to the answer model, which decides from the screen whether it's a task ([TASK:goal]).
    return goal ? { goal, confirm: cfg.confirm } : null;
  }

  /** Let the answer model hand requests to agent mode, when agent mode is on and can act here. */
  private taskRouting(question = ''): { tasks?: true } {
    // Drawing on the screen is always answered with marks, never handed to the agent (it would
    // open Paint, or drag the mouse over the desktop).
    if (question && onScreenDrawing(question)) return {};
    const cfg = this.deps.agent?.();
    return cfg?.enabled && cfg.ready !== false && this.deps.input && this.deps.confirm ? { tasks: true } : {};
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
      text = (await listen.transcript(this.transcriptBudget(listen))).trim();
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, 'stt');
      return;
    }
    if (signal.aborted) return;
    const context = await contextP;
    if (signal.aborted) return;
    const last = this.lastInsert;
    let plan = planDictation(text, { hasSelection: !!context.selection, last, now: this.now() });
    // "Hey Clicky, open WhatsApp" on the write key: the user is talking to Clicky, not dictating.
    if (plan.kind === 'assistant' || plan.kind === 'greet') {
      run.mode = 'answer';
      run.record = true;
      const screens = this.deps.capture.take(signal);
      screens.catch(() => undefined);
      await this.answer(run, screens, plan.kind === 'assistant' ? plan.question : text);
      return;
    }
    run.latency.mark('transcriptFinal');
    const t = this.machine.dispatch({ type: 'transcriptFinal', text });
    if (!t || t.to !== 'thinking') {
      if (t?.to === 'cancelled') this.deps.overlay.message(NO_SPEECH, 'info');
      this.finish(run, 'cancelled', 'no speech detected');
      return;
    }
    const input = this.deps.input;
    if (!input) return this.fail(run, new ConfigError('Typing into other apps is not available here.'), 'config');
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
    const wantsAi = plan.kind !== 'plain' || ((this.deps.tidyDictation?.() ?? false) && needsTidy(text));
    /** Tidied text is checked against what was said before it's typed, so it's collected first. */
    let tidied = '';
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
              const piece = splitter.push(r.value);
              if (tidyOnly) tidied += piece;
              else typeNow(piece);
            }
          } finally {
            void it.return?.().catch(() => undefined);
          }
          const tail = splitter.end();
          if (tidyOnly) {
            tidied += tail.text;
            const ok = faithfulTidy(text, tidied);
            if (!ok) this.deps.log?.(`dictation tidy discarded (not the user's words): ${tidied.slice(0, 80)}`);
            typeNow(ok ? tidied : text);
          } else typeNow(tail.text);
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
    goalFromModel = false,
    /** The screenshot the request was asked over: the first plan reuses it while it is fresh. */
    screens?: Promise<ScreenCapture>,
  ): Promise<void> {
    // A task's own summary ("…not saved yet") must not start another run to find things out.
    run.ranTask = true;
    const { signal } = run.interaction;
    const { input, confirm } = this.deps;
    if (!input || !confirm) return this.fail(run, new ConfigError('Agent mode is not available here.'), 'config');
    run.latency.setMeta('agent', true);
    // The task takes a while: say so at once.
    void this.beat(run, speech, 'task');
    const userContext = this.deps.userContext?.();
    const plan = this.deps.agentTaskPlan?.(goal) ?? null;
    if (plan) {
      goal = plan.goal;
      if (plan.helper) run.latency.setMeta('helper', plan.helper);
    }
    let result: AgentResult;
    try {
      const hints = this.deps.agentHints?.(goal);
      const inventory = this.deps.inventory?.();
      const skills = this.deps.agentSkills?.(goal);
      const conversation = this.conversationText(run);
      const briefing = [this.deps.agentBriefing?.(), plan?.briefing].filter(Boolean).join('\n\n') || undefined;
      const shot = await this.freshScreens(run, screens);
      if (shot) run.latency.event('answer', 'agent-plans-over-key-screenshot');
      result = await runAgent(goal, {
        ...(shot ? { screens: shot } : {}),
        ...(hints ? { hints } : {}),
        ...(skills ? { skills } : {}),
        ...(conversation ? { conversation } : {}),
        ...(briefing ? { briefing } : {}),
        ...(inventory ? { inventory } : {}),
        chat: this.deps.agentChat?.() ?? chat,
        capture: this.deps.capture,
        input,
        overlay: this.deps.overlay,
        confirm,
        confirmMode,
        signal,
        ...(goalFromModel ? { goalFromModel } : {}),
        ...(userContext ? { userContext } : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
        onStep: (say) => this.deps.overlay.caption?.(say),
        ...(this.deps.atCaret ? { atCaret: () => this.deps.atCaret?.() } : {}),
        ...(this.deps.agentHooks?.() ?? {}),
      });
    } catch (e) {
      if (!signal.aborted) this.fail(run, e, 'answer');
      return;
    } finally {
      this.deps.agentRunEnded?.();
    }
    if (signal.aborted) return;
    this.deps.log?.(`agent ${result.outcome} after ${result.steps.length} steps`);
    this.deps.agentRunFinished?.(goal, result);
    this.recentRuns.unshift({
      goal,
      outcome: result.outcome,
      summary: result.summary,
      steps: result.steps,
      at: this.now(),
    });
    this.recentRuns.splice(5);
    // Tag text from a final-message tail is never spoken; a repeat that was set up is confirmed.
    const spoken = [visibleText(result.summary), result.outcome === 'done' ? plan?.after : undefined]
      .filter(Boolean)
      .join(' ');
    run.answer = spoken;
    const out = this.voice(run, speech).create(signal);
    out.onFirstAudio(() => {
      if (this.run === run && this.machine.state === 'thinking') this.machine.dispatch({ type: 'firstAudio' });
    });
    out.say(spoken);
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
  /**
   * Draw a thing on the screen like an illustrator: plan its parts, draw strokes on a square canvas,
   * look at a rendered copy to check it really shows the subject, redraw with the fixes (at most
   * twice), then draw it in the middle of the screen the user is on. Drawings that pass are kept.
   */
  private async drawSketch(
    run: Run,
    subject: string,
    screens: Promise<ScreenCapture>,
    speech: SpeechFactory,
  ): Promise<void> {
    const { signal } = run.interaction;
    const chat = this.deps.agentChat?.() ?? this.deps.chat();
    const key = sketchKey(subject);
    this.deps.overlay.message(`Drawing ${subject}…`, 'info');
    if (!this.deps.sketchLibrary?.get(key)) void this.beat(run, speech, 'draw');
    const collect = async (
      system: string,
      question: string,
      images: ImageInput[],
      maxTokens: number,
    ): Promise<string> => {
      let text = '';
      for await (const t of chat.stream({
        system,
        history: [],
        question,
        images,
        maxTokens,
        thinkingTokens: 2048,
        signal,
      }))
        text += t;
      return text;
    };
    let sketch = this.deps.sketchLibrary?.get(key) ?? null;
    if (sketch) this.deps.log?.(`sketch of "${subject}" from a drawing that passed before`);
    else {
      let fixes = '';
      for (let attempt = 1; attempt <= SKETCH_ATTEMPTS && !signal.aborted; attempt++) {
        let reply: string;
        try {
          reply = await collect(
            SKETCH_PROMPT,
            [
              `Draw: ${subject}`,
              sketch && fixes
                ? `Your last drawing was checked and it needs fixing: ${fixes}\nYour last drawing: ${JSON.stringify({ strokes: sketch.strokes.map((st) => ({ part: st.part, points: st.points.map((p) => [p.x, p.y]) })) })}`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n'),
            [],
            12000,
          );
        } catch (e) {
          if (signal.aborted) return;
          this.deps.log?.(`sketch attempt ${attempt} failed: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        const unclear = sketchUnclear(reply);
        if (unclear) {
          this.deps.log?.(`sketch subject unclear ("${subject}"): ${unclear}`);
          await this.sayOnly(run, speech, unclear);
          return;
        }
        const next = parseSketch(reply);
        if (!next) {
          this.deps.log?.(`sketch attempt ${attempt}: no usable drawing in the reply`);
          continue;
        }
        sketch = next;
        this.deps.log?.(
          `sketch attempt ${attempt}: ${next.strokes.length} strokes (${next.strokes
            .map((st) => st.part)
            .filter(Boolean)
            .join(', ')
            .slice(0, 200)})`,
        );
        const picture = await this.deps.renderSketch?.(sketchToSvg(next)).catch(() => null);
        if (!picture) break; // can't check it here: draw what we have
        let verdict = { ok: true, fixes: '' };
        try {
          verdict = parseSketchCheck(await collect(SKETCH_CHECK_PROMPT, `Subject: ${subject}`, [picture], 600));
        } catch {
          // an unchecked drawing is still drawn
        }
        this.deps.log?.(`sketch check ${attempt}: ${verdict.ok ? 'looks right' : `needs work: ${verdict.fixes}`}`);
        if (verdict.ok) {
          this.deps.sketchLibrary?.put(key, next);
          break;
        }
        fixes = verdict.fixes;
      }
    }
    if (signal.aborted) return;
    if (!sketch) {
      await this.sayOnly(run, speech, `I couldn't work out how to draw ${subject}. Try describing it another way.`);
      return;
    }
    const scr = await screens.catch(() => null);
    const cap = scr ? (scr.geometry[scr.cursorScreen - 1] ?? scr.geometry[0]) : undefined;
    if (!cap) {
      await this.sayOnly(run, speech, "I couldn't find the screen to draw on.");
      return;
    }
    const marks = placeSketch(sketch, {
      id: cap.display.id,
      width: cap.display.bounds.width,
      height: cap.display.bounds.height,
    });
    for (const m of marks) this.deps.overlay.draw?.(m);
    run.drawn = marks.length;
    this.deps.log?.(`sketch of "${subject}" drawn: ${marks.length} marks`);
    await this.sayOnly(run, speech, `Here's ${subject}.`);
  }

  private async sayOnly(run: Run, speech: SpeechFactory, text: string): Promise<void> {
    const { signal } = run.interaction;
    run.answer = text;
    this.deps.overlay.message(text, 'info');
    const out = this.voice(run, speech).create(signal);
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
    if (outcome === 'answered' && this.shouldFindOut(run))
      queueMicrotask(() => {
        this.deps.log?.(`not on screen; finding it out: ${run.question}`);
        const rest = splitWake(run.question).rest;
        // A refused or claimed action is the request itself; a missing fact is something to find out.
        void this.ask(
          NOT_DONE.test(run.answer) && !ASKS.test(rest) ? `Clicky, ${rest}` : `Clicky, find out and tell me: ${rest}`,
          'action',
        );
      });
  }

  /** The answer said it can't see that on screen, and agent mode can go and look. */
  private shouldFindOut(run: Run): boolean {
    if (run.mode !== 'answer' || run.source === 'action' || run.ranTask) return false;
    if (!CANT_SEE.test(run.answer) && !NOT_DONE.test(run.answer)) return false;
    const cfg = this.deps.agent?.();
    return !!cfg?.enabled && cfg.ready !== false;
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
