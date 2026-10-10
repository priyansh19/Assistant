import { app } from 'electron';
import {
  cloudSpeech,
  HOLD_KEY_LABELS,
  contextTurns,
  Orchestrator,
  requiredCredentials,
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

/** Owns the orchestrator and the hold key, and connects them to settings, keys and storage. */
export class Controller {
  readonly orchestrator: Orchestrator;
  private holdKey: HoldKeyHook | null = null;
  private readonly stateListeners = new Set<StateListener>();
  private readonly speechFactory: () => SpeechFactory;

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
      recentTurns: () => (this.settings.get().useRecentContext ? contextTurns(this.history.list(), Date.now()) : []),
      record: (entry) => this.history.add(entry, this.settings.get().rememberHistory),
      onLatency: (summary) => {
        this.history.logLatency(summary);
        log.info('latency', summary);
      },
      onState: (state) => {
        for (const fn of this.stateListeners) fn(state);
      },
      log: (m) => log.info(m),
    });
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

  startHoldKey(): void {
    this.holdKey?.stop();
    const s = this.settings.get();
    this.holdKey = this.platform.createHoldKeyHook(s.holdKey);
    this.holdKey.start({
      onDown: () => {
        if (this.settings.get().paused) return;
        const missing = this.missingKeys();
        if (missing.length) {
          // Nothing can work yet: say so instead of listening and failing later.
          this.overlays.message('Clicky needs your API keys first. Click the tray icon to open Clicky.', 'info');
          return;
        }
        this.orchestrator.keyDown();
      },
      onUp: () => this.orchestrator.keyUp(),
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

  async ask(question: string, source: 'typed' | 'action'): Promise<void> {
    const missing = this.missingKeys();
    if (missing.length) {
      this.overlays.message('Clicky needs your API keys first. Open Clicky from the tray to add them.', 'info');
      return;
    }
    await this.orchestrator.ask(question, source);
  }

  /** Voice preview for the dashboard. */
  async speakSample(): Promise<void> {
    const key = HOLD_KEY_LABELS[this.settings.get().holdKey];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const out = this.speechFactory().create(ac.signal);
      out.say(`Hi, I'm Clicky. Hold ${key}, ask me about anything on your screen, and let go.`);
      out.end();
      await out.done;
      if (ac.signal.aborted) throw new Error('The voice took too long to respond.');
    } finally {
      clearTimeout(timer);
    }
  }

  applyLaunchAtLogin(enabled: boolean): void {
    // Only meaningful for the installed app; in dev it would register electron.exe.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
  }
}
