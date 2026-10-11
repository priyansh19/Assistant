import { app } from 'electron';
import {
  CREDENTIAL_IDS,
  isResting,
  HOLD_KEY_LABELS,
  requiredCredentials,
  type AskResult,
  type CredentialId,
  type InteractionState,
  type Settings,
} from '@clicky/core';
import { DEMO } from '../engine/demo';
import type { EngineConfig, EngineToMain } from '../shared/engine-protocol';
import type { Platform } from '../platform';
import { CapturePlanner } from './capture-planner';
import type { CredentialStore } from './credential-store';
import { EngineHost } from './engine-host';
import { InputHost } from './input-host';
import { PlaybookStore } from './playbook-store';
import type { HistoryStore } from './history-store';
import { log } from './log';
import type { OverlayManager } from './overlay-manager';
import type { SettingsStore } from './settings-store';
import { ModelStore } from './local-speech/store';
import type { WorkerHost } from './worker-host';

type StateListener = (state: InteractionState) => void;

export interface ControllerHooks {
  /** Called on key-down after listening starts, e.g. to get the Clicky window out of the shot. */
  beforeListen?(): void;
  /** Keys are missing: show the user where to add them. */
  needKeys?(): void;
}

/** A typed question that outlives this is answered with an error rather than left hanging. */
const ASK_TIMEOUT_MS = 180_000;

/**
 * Main's side of the interaction loop. The loop itself runs in the engine (architecture §4); this
 * keeps the engine's config current, carries out what the engine asks of main (overlay, history,
 * logs, screen layout) and gives the rest of main a small API.
 */
export class Controller {
  private readonly engine: EngineHost;
  private readonly planner = new CapturePlanner();
  private readonly stateListeners = new Set<StateListener>();
  private current: { state: InteractionState; interactionId: string | null } = { state: 'idle', interactionId: null };
  /** While set (setup wizard "press your key"), key presses are reported here instead of asking. */
  private keyTest: ((down: boolean, key: 'talk' | 'dictate') => void) | null = null;
  private nextId = 1;
  private readonly asks = new Map<number, (r: AskResult | null) => void>();
  private readonly samples = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  hooks: ControllerHooks = {};
  /** On-device speech model downloads. The models themselves run in the engine. */
  readonly local = { store: new ModelStore() };
  private readonly input: InputHost;
  readonly playbooks = new PlaybookStore();
  private anchorTimer: NodeJS.Timeout | null = null;

  constructor(
    platform: Platform,
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly history: HistoryStore,
    private readonly overlays: OverlayManager,
    private readonly worker: WorkerHost,
  ) {
    this.engine = new EngineHost(platform, worker);
    this.input = new InputHost(platform.createInputDriver());
    this.engine.onMessage((msg) => this.onEngine(msg));
    // The overlay waveform: levels come from the media renderer through main, only while listening.
    worker.on((e) => {
      if (e.type === 'mic.level' && this.current.state === 'listening') overlays.level(e.level);
      else if (e.type === 'worker.crashed') this.engine.mediaCrashed();
    });
    worker.onRestart = () => {
      this.syncMicArm();
      this.engine.connectMedia();
    };
    const push = (): void => this.pushConfig();
    settings.onChange(push);
    credentials.onChange(push);
    history.onChange(push);
    this.playbooks.onChange(push);
    this.pushConfig();
    this.engine.start();
  }

  private config(): EngineConfig {
    const keys: Partial<Record<CredentialId, string>> = {};
    for (const id of CREDENTIAL_IDS) {
      const k = this.credentials.get(id);
      if (k) keys[id] = k;
    }
    return {
      settings: this.settings.get(),
      keys,
      missing: this.missingKeys(),
      history: this.history.list(),
      demo: DEMO,
      modelsDir: this.local.store.root,
      playbooks: this.playbooks.list(),
    };
  }

  private pushConfig(): void {
    this.engine.send({ type: 'config', config: this.config() });
  }

  private onEngine(msg: EngineToMain): void {
    switch (msg.type) {
      case 'ready':
        return;
      case 'state': {
        if (isResting(msg.state)) {
          if (this.anchorTimer) clearTimeout(this.anchorTimer);
          this.anchorTimer = setTimeout(() => this.overlays.anchor(null), 2500);
        }
        this.current = { state: msg.state, interactionId: msg.interactionId };
        if (msg.interactionId === null) this.engineLost();
        for (const fn of this.stateListeners) fn(msg.state);
        return;
      }
      case 'overlay': {
        const o = msg.overlay;
        if (o.op === 'state') this.overlays.state(o.state);
        else if (o.op === 'point') this.overlays.point(o.target, o.label);
        else if (o.op === 'draw') this.overlays.draw(o.shape);
        else if (o.op === 'message') this.overlays.message(o.text, o.kind);
        return;
      }
      case 'record':
        return this.history.add(msg.entry, this.settings.get().rememberHistory);
      case 'latency':
        this.history.logLatency(msg.summary);
        log.info('latency', msg.summary);
        return;
      case 'log':
        return log[msg.level](msg.message);
      case 'needKeys':
        return this.hooks.needKeys?.();
      case 'listening':
        this.overlays.anchor(null);
        return this.hooks.beforeListen?.();
      case 'keyTest':
        return this.keyTest?.(msg.down, msg.key);
      case 'askResult': {
        const done = this.asks.get(msg.id);
        this.asks.delete(msg.id);
        return done?.(msg.result);
      }
      case 'speakSampleResult': {
        const p = this.samples.get(msg.id);
        this.samples.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error));
        else p?.resolve();
        return;
      }
      case 'capturePlan':
        this.planner.plan(msg.allDisplays).then(
          (plan) => this.engine.send({ type: 'capturePlan.reply', id: msg.id, plan }),
          (e: unknown) =>
            this.engine.send({
              type: 'capturePlan.reply',
              id: msg.id,
              error: e instanceof Error ? e.message : String(e),
            }),
        );
        return;
      case 'input':
        this.input.run(msg.action).then(
          () => this.engine.send({ type: 'input.reply', id: msg.id }),
          (e: unknown) =>
            this.engine.send({ type: 'input.reply', id: msg.id, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      case 'writeContext':
        void this.input
          .writeContext()
          .catch(() => ({ app: null, selection: null }))
          .then((context) => this.engine.send({ type: 'writeContext.reply', id: msg.id, context }));
        return;
      case 'caretAnchor':
        if (this.anchorTimer) clearTimeout(this.anchorTimer);
        void this.input.caret().then((c) => this.overlays.anchor(c));
        return;
      case 'holdKey.failed':
        log.error('hold-to-talk hook failed', msg.message);
        this.overlays.message(`The ${this.holdKeyLabel()} key can't be watched right now. Restart Clicky.`, 'error');
        return;
    }
  }

  /** The engine process died mid-question: answer every waiter instead of leaving it hanging. */
  private engineLost(): void {
    for (const done of this.asks.values())
      done({ outcome: 'error', answer: '', pointLabel: null, detail: 'Clicky restarted its voice engine. Try again.' });
    this.asks.clear();
    for (const p of this.samples.values()) p.reject(new Error('Clicky restarted its voice engine. Try again.'));
    this.samples.clear();
  }

  private holdKeyLabel(): string {
    return HOLD_KEY_LABELS[this.settings.get().holdKey];
  }

  get state(): InteractionState {
    return this.current.state;
  }

  /** Id of the latest interaction, to tell whether a newer question has started since. */
  get interactionId(): string | null {
    return this.current.interactionId;
  }

  /** 'process' when the engine runs in its own process, 'inproc' when it fell back to main. */
  get engineMode(): string {
    return this.engine.mode;
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
    this.engine.send({ type: 'prewarm' });
    const s = this.settings.get();
    if (s.dictationKey !== 'off' || s.agentEnabled) this.input.warm();
  }

  /** Report hold-key presses to the setup wizard instead of starting a question. */
  setKeyTest(fn: ((down: boolean, key: 'talk' | 'dictate') => void) | null): void {
    this.keyTest = fn;
    this.engine.send({ type: 'keyTest', on: fn !== null });
  }

  startHoldKey(): void {
    this.engine.send({ type: 'holdKey.start' });
  }

  stopHoldKey(): void {
    this.engine.send({ type: 'holdKey.stop' });
  }

  cancel(reason: string): void {
    this.engine.send({ type: 'cancel', reason });
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

  async ask(question: string, source: 'typed' | 'action'): Promise<AskResult | null> {
    if (this.missingKeys().length) {
      this.overlays.message('Clicky needs your API keys first. Opening Clicky…', 'info');
      this.hooks.needKeys?.();
      return { outcome: 'error', answer: '', pointLabel: null, detail: 'Add your API keys first.' };
    }
    const id = this.nextId++;
    return new Promise<AskResult | null>((resolve) => {
      const timer = setTimeout(() => {
        this.asks.delete(id);
        resolve({ outcome: 'error', answer: '', pointLabel: null, detail: 'The question took too long.' });
      }, ASK_TIMEOUT_MS);
      this.asks.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.engine.send({ type: 'ask', id, question, source });
    });
  }

  /** Voice preview for the dashboard. */
  speakSample(): Promise<void> {
    const id = this.nextId++;
    const text = `Hi, I'm Clicky. Hold ${this.holdKeyLabel()}, ask me about anything on your screen, and let go.`;
    return new Promise<void>((resolve, reject) => {
      this.samples.set(id, { resolve, reject });
      this.engine.send({ type: 'speakSample', id, text });
    });
  }

  applyLaunchAtLogin(enabled: boolean): void {
    // Only meaningful for the installed app; in dev it would register electron.exe.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
  }

  /** App quitting: stop the hook and the engine process. */
  shutdown(): void {
    this.engine.stop();
    this.input.dispose();
  }
}
