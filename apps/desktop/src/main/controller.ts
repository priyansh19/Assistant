import { app } from 'electron';
import {
  cloudSpeech,
  HOLD_KEY_LABELS,
  contextTurns,
  Orchestrator,
  requiredCredentials,
  type AskResult,
  type CredentialId,
  type InteractionState,
  type Settings,
  type SpeechFactory,
} from '@clicky/core';
import { createChat, createStt, createTts } from '@clicky/providers';
import type { HoldKeyHook, Platform } from '../platform';
import type { CredentialStore } from './credential-store';
import { DEMO, demoChat, demoStt } from './demo';
import type { HistoryStore } from './history-store';
import { log } from './log';
import type { OverlayManager } from './overlay-manager';
import { createAudioSink, createCapturePort, createMicPort, systemSpeech } from './ports';
import type { SettingsStore } from './settings-store';
import type { WorkerHost } from './worker-host';

type StateListener = (state: InteractionState) => void;

export interface ControllerHooks {
  /** Called on key-down before listening starts, e.g. to get the Clicky window out of the shot. */
  beforeListen?(): void;
  /** Keys are missing: show the user where to add them. */
  needKeys?(): void;
}

/** Owns the orchestrator and the hold key, and connects them to settings, keys and storage. */
export class Controller {
  readonly orchestrator: Orchestrator;
  private holdKey: HoldKeyHook | null = null;
  private readonly stateListeners = new Set<StateListener>();
  private readonly speechFactory: () => SpeechFactory;
  /** While set (setup wizard "press your key"), key presses are reported here instead of asking. */
  private keyTest: ((down: boolean) => void) | null = null;
  hooks: ControllerHooks = {};

  constructor(
    private readonly platform: Platform,
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly history: HistoryStore,
    private readonly overlays: OverlayManager,
    private readonly worker: WorkerHost,
  ) {
    const getKey = (id: CredentialId): string | null => this.credentials.get(id);
    this.speechFactory = (): SpeechFactory => {
      const tts = DEMO ? null : createTts(this.settings.get(), getKey);
      return tts ? cloudSpeech(tts, () => createAudioSink(this.worker)) : systemSpeech(this.worker);
    };
    this.orchestrator = new Orchestrator({
      chat: () => (DEMO ? demoChat() : createChat(this.settings.get(), getKey)),
      stt: () => (DEMO ? demoStt() : createStt(this.settings.get(), getKey)),
      speech: () => this.speechFactory(),
      capture: createCapturePort(this.worker, () => this.settings.get()),
      mic: createMicPort(
        this.worker,
        () => this.settings.get().micDeviceId,
        (level) => this.overlays.level(level),
      ),
      overlay: this.overlays,
      listensDirectly: () => !DEMO && this.settings.get().sttProvider === 'model',
      recentTurns: () => (this.settings.get().useRecentContext ? contextTurns(this.history.list(), Date.now()) : []),
      record: (entry) => this.history.add(entry, this.settings.get().rememberHistory),
      onLatency: (summary) => {
        this.history.logLatency(summary);
        log.info('latency', summary);
      },
      onState: (state) => {
        for (const fn of this.stateListeners) fn(state);
        // After each answer, get the speech-to-text service ready for the next question.
        if (state === 'idle' || state === 'cancelled' || state === 'error') this.prewarm();
      },
      log: (m) => log.info(m),
    });
    this.worker.onRestart = () => this.syncMicArm();
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** Keys the current provider choices need but don't have. */
  missingKeys(s: Settings = this.settings.get()): CredentialId[] {
    if (DEMO) return [];
    const status = this.credentials.status();
    return requiredCredentials(s).filter((id) => !status[id]);
  }

  /** Idle-time preparation for the next question (e.g. a streaming token). Never throws. */
  prewarm(): void {
    if (DEMO || this.missingKeys().length) return;
    try {
      createStt(this.settings.get(), (id) => this.credentials.get(id)).prewarm?.();
    } catch {
      // missing config shows up when the user asks
    }
  }

  /** Report hold-key presses to the setup wizard instead of starting a question. */
  setKeyTest(fn: ((down: boolean) => void) | null): void {
    this.keyTest = fn;
  }

  startHoldKey(): void {
    this.holdKey?.stop();
    const s = this.settings.get();
    this.holdKey = this.platform.createHoldKeyHook(s.holdKey);
    this.holdKey.start({
      onDown: () => {
        if (this.keyTest) return this.keyTest(true);
        if (this.settings.get().paused) return;
        if (this.missingKeys().length) {
          // Nothing can work yet: say so and open the place to fix it, instead of failing later.
          this.overlays.message('Clicky needs your API keys first. Opening Clicky…', 'info');
          this.hooks.needKeys?.();
          return;
        }
        // The mic and capture start first; moving windows can wait a millisecond.
        this.orchestrator.keyDown();
        this.hooks.beforeListen?.();
      },
      onUp: () => {
        if (this.keyTest) return this.keyTest(false);
        this.orchestrator.keyUp();
      },
      onCancel: () => this.orchestrator.cancel('escape'),
    });
  }

  /** Open or close the warm microphone to match settings (see Settings.micAlwaysReady). */
  syncMicArm(): void {
    const s = this.settings.get();
    const arm = s.micAlwaysReady && !s.paused && s.onboardingDone;
    this.worker
      .request({ op: 'mic.arm', deviceId: arm ? s.micDeviceId : null }, 10000)
      .then(() => log.info(arm ? 'microphone kept ready' : 'microphone closed'))
      .catch((e: unknown) => log.warn('could not keep the microphone ready', String(e)));
  }

  stopHoldKey(): void {
    this.holdKey?.stop();
    this.holdKey = null;
  }

  async ask(question: string, source: 'typed' | 'action'): Promise<AskResult | null> {
    if (this.missingKeys().length) {
      this.overlays.message('Clicky needs your API keys first. Opening Clicky…', 'info');
      this.hooks.needKeys?.();
      return { outcome: 'error', answer: '', pointLabel: null, detail: 'Add your API keys first.' };
    }
    return this.orchestrator.ask(question, source);
  }

  /** Voice preview for the dashboard. */
  async speakSample(): Promise<void> {
    const key = HOLD_KEY_LABELS[this.settings.get().holdKey];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const out = this.speechFactory().create(ac.signal);
    try {
      out.say(`Hi, I'm Clicky. Hold ${key}, ask me about anything on your screen, and let go.`);
      out.end();
      await out.done;
      if (ac.signal.aborted) throw new Error('The voice took too long to respond. Check your internet connection.');
    } finally {
      clearTimeout(timer);
      out.stop();
    }
  }

  applyLaunchAtLogin(enabled: boolean): void {
    // Only meaningful for the installed app; in dev it would register electron.exe.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
  }
}
