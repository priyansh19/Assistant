import { app, screen } from 'electron';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import {
  CREDENTIAL_IDS,
  CURSOR_COLOR_HEX,
  isResting,
  holdKeyLabel,
  requiredCredentials,
  type AskResult,
  type CredentialId,
  type InteractionState,
  type MappedPoint,
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
import { SkillStore } from './skill-store';
import { TaskStrip } from './task-strip';
import { AllowOrb } from './allow-orb';
import { StyleStore } from './style-store';
import { TaskQueue } from './task-queue';
import { LessonStore } from './lesson-store';
import { Inventory } from './inventory';
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
  /** Agent mode was asked for but isn't set up: show its rules screen. */
  needAgentSetup?(): void;
}

/** A typed question that outlives this is answered with an error rather than left hanging. */
const ASK_TIMEOUT_MS = 180_000;
/**
 * The first-run look-around (the official Clicky's onboarding demo prompt, as a question): one
 * specific, named thing near the middle of the screen and a few playful words about it.
 */
const HELLO_QUESTION =
  "You're meeting me for the first time. Look around my screen and point at ONE specific thing you can name, " +
  'near the middle of the screen (not the taskbar, edges or corners): an app, a file name, a word, a picture. ' +
  "Say only a short, playful three to six word comment about it, all lowercase, without quoting the screen's text.";
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Longest wait for an answer's point to be matched to a real control (the flight takes ~0.4–1.1 s). */
const SNAP_TIMEOUT_MS = 900;

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
  readonly inventory: Inventory;
  readonly playbooks = new PlaybookStore();
  readonly style = new StyleStore();
  readonly lessons = new LessonStore();
  readonly skills = new SkillStore();
  /** Background tasks: run one at a time while the user is away from the mouse. */
  readonly tasks = new TaskQueue({
    settings: () => this.settings.get(),
    state: () => this.current.state,
    ask: (q) => this.ask(q, 'action'),
  });
  private anchorTimer: NodeJS.Timeout | null = null;
  private readonly strip = new TaskStrip({
    pause: (on) => this.engine.send({ type: 'agent.pause', on }),
    stop: () => this.engine.send({ type: 'cancel', reason: 'stopped from the task strip' }),
    allow: () => this.engine.send({ type: 'agent.allow' }),
    allowAll: (on) => this.engine.send({ type: 'agent.allowAll', on }),
  });
  /** Shown while Allow all is on; hovering it offers Turn off. */
  private readonly orb = new AllowOrb(() => this.engine.send({ type: 'agent.allowAll', on: false }));

  constructor(
    platform: Platform,
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly history: HistoryStore,
    private readonly overlays: OverlayManager,
    private readonly worker: WorkerHost,
  ) {
    this.engine = new EngineHost(platform, worker);
    const driver = platform.createInputDriver();
    this.inventory = new Inventory(driver);
    this.input = new InputHost(driver, (name) => this.inventory.find(name));
    // A click target moved since the screenshot: fly the triangle to where it really is.
    this.input.onRetarget = (at, label) => {
      const d = screen.getDisplayNearestPoint(at);
      const local = { x: at.x - d.bounds.x, y: at.y - d.bounds.y };
      log.info(`click target "${label}" moved; clicking it at its live position`);
      this.overlays.point({ displayId: d.id, local, global: at }, label);
    };
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
    this.style.onChange(push);
    this.lessons.onChange(push);
    this.inventory.onChange(push);
    this.skills.onChange(push);
    this.pushConfig();
    this.engine.start();
    this.tasks.start();
    this.inventory.start();
    void this.checkAltGr();
    this.skills.start();
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
      style: this.style.get(),
      lessons: this.lessons.list(),
      notes: this.lessons.notes(),
      inventory: this.inventory.view(),
      briefing: this.skills.briefing(),
      skills: this.skills.list(),
      outputDir: join(app.getPath('documents'), 'Clicky'),
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
        this.cue(this.current.state, msg.state);
        if (isResting(msg.state)) {
          this.strip.end();
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
        else if (o.op === 'point') {
          log.info(
            `overlay point on display ${o.target.displayId} at ${Math.round(o.target.local.x)},${Math.round(o.target.local.y)} (screen ${Math.round(o.target.global.x)},${Math.round(o.target.global.y)}) "${o.label}"`,
          );
          this.overlays.point(o.target, o.label);
          if (o.snap) this.snapPoint(o.target, o.label);
        } else if (o.op === 'draw') {
          // One line per mark, so the drawing suite can check placement from the log.
          const pts = o.shape.points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ');
          log.info(
            `overlay draw ${o.shape.kind} on display ${o.shape.displayId} at ${pts}${o.shape.r !== undefined ? ` r=${Math.round(o.shape.r)}` : ''} "${o.shape.label}"`,
          );
          this.overlays.draw(o.shape);
        } else if (o.op === 'message') this.overlays.message(o.text, o.kind);
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
      case 'keyRecorded': {
        const done = this.keyRecorded;
        this.keyRecorded = null;
        done?.(msg.key);
        return;
      }
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
        // Keep Clicky's own notch out of the screenshot the model sees.
        this.strip.hideForCapture();
        this.orb.hideForCapture();
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
      case 'elements':
        void this.input
          .elements()
          .then((elements) => this.engine.send({ type: 'elements.reply', id: msg.id, elements }));
        return;
      case 'otherAgent':
        void this.input.otherAgent().then((text) => this.engine.send({ type: 'otherAgent.reply', id: msg.id, text }));
        return;
      case 'windows':
        void this.input.windows().then((windows) => this.engine.send({ type: 'windows.reply', id: msg.id, windows }));
        return;
      case 'foreground':
        void this.input.foreground().then((app) => this.engine.send({ type: 'foreground.reply', id: msg.id, app }));
        return;
      case 'remember':
        this.lessons.remember(msg.note);
        return;
      case 'agentLesson':
        this.lessons.add(msg.lesson);
        this.skills.learn(msg.lesson);
        return;
      case 'styleLearned':
        this.style.learn(msg.context, { notes: msg.notes, examples: msg.examples });
        return;
      case 'agentSetup':
        this.hooks.needAgentSetup?.();
        return;
      case 'agentProgress':
        this.strip.update({
          goal: msg.goal,
          step: msg.step,
          max: msg.max,
          say: msg.say,
          color: CURSOR_COLOR_HEX[this.settings.get().cursorColor],
        });
        return;
      case 'agentAsk':
        if (msg.text) {
          this.tasks.needsApproval(msg.text);
          // A task waiting on the user's OK is easy to miss when they've looked away.
          const sound = this.settings.get().cueSound;
          if (sound !== 'off') this.worker.send({ op: 'cue', kind: 'ask', sound });
        }
        if (msg.text !== null || this.strip.visible) this.strip.update({ ask: msg.text });
        return;
      case 'allowAll':
        if (msg.on) this.orb.show();
        else this.orb.hide();
        if (this.strip.visible || msg.on) this.strip.update({ allowAll: msg.on });
        return;
      case 'agentPaused':
        this.strip.update({
          paused: msg.on,
          pausedForUser: msg.on && msg.reason === 'user',
          pausedForAgent: msg.on && msg.reason === 'agent',
        });
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
    return holdKeyLabel(this.settings.get().holdKey);
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
    // Always: answers use it to land the pointer on the real control.
    this.input.warm();
  }

  /** Key sounds: one as listening starts, one when the key is let go. */
  private cue(from: InteractionState, to: InteractionState): void {
    const sound = this.settings.get().cueSound;
    if (sound === 'off') return;
    if (to === 'listening' && from !== 'listening') this.worker.send({ op: 'cue', kind: 'start', sound });
    else if (from === 'listening' && to === 'transcribing') this.worker.send({ op: 'cue', kind: 'end', sound });
  }

  /** Preview a key sound (dashboard). */
  playCue(sound: 'soft' | 'bubble' | 'glass'): void {
    this.worker.send({ op: 'cue', kind: 'start', sound });
    setTimeout(() => this.worker.send({ op: 'cue', kind: 'end', sound }), 450);
  }

  private keyRecorded: ((key: string | null) => void) | null = null;

  /**
   * Right Alt is AltGr on many keyboards (Italian, German, French: it types @ and €), so holding it
   * to write clashes with typing. Checked once: the writing key moves to a key that's free.
   */
  private async checkAltGr(): Promise<void> {
    const marker = join(app.getPath('userData'), '.altgr-checked');
    if (existsSync(marker)) return;
    const s = this.settings.get();
    try {
      const altGr = await this.input.usesAltGr();
      writeFileSync(marker, String(altGr));
      const uses = (k: string): boolean => s.holdKey === k || s.dictationKey === k;
      if (!altGr || !uses('RightAlt')) return;
      const free = !uses('RightCtrl') ? 'RightCtrl' : 'F9';
      if (s.dictationKey === 'RightAlt') this.settings.update({ dictationKey: free });
      else this.settings.update({ holdKey: free });
      this.overlays.message(
        `Right Alt types characters on your keyboard (AltGr), so Clicky now uses ${holdKeyLabel(free)} instead. Change it in Settings.`,
        'info',
      );
      log.info(`AltGr keyboard: moved Right Alt to ${free}`);
    } catch (e) {
      log.warn('could not check the keyboard layout', String(e));
    }
  }

  /** Settings "Record keys": the next key combination pressed, or null (Esc or nothing pressed). */
  recordKeys(): Promise<string | null> {
    this.keyRecorded?.(null);
    return new Promise((resolve) => {
      this.keyRecorded = resolve;
      this.engine.send({ type: 'keyRecord' });
    });
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

  /**
   * The answer model's point is a guess from a downscaled screenshot. While the triangle is still in
   * the air, look the named control up with UI Automation and, if it's close by, land on it instead.
   */
  private snapPoint(target: MappedPoint, label: string): void {
    const id = this.current.interactionId;
    const started = Date.now();
    void this.input.snap(label, target.global, SNAP_TIMEOUT_MS).then((at) => {
      if (this.current.interactionId !== id) return;
      if (!at) {
        log.info(
          `point "${label}": no matching control near it, kept the model's position (${Date.now() - started} ms)`,
        );
        return;
      }
      const d = screen.getDisplayNearestPoint(at);
      if (d.id !== target.displayId) return;
      log.info(
        `point "${label}" snapped to the control at ${Math.round(at.x)},${Math.round(at.y)} (was ${Math.round(target.global.x)},${Math.round(target.global.y)}, ${Date.now() - started} ms)`,
      );
      this.overlays.point(
        { displayId: d.id, local: { x: at.x - d.bounds.x, y: at.y - d.bounds.y }, global: at },
        label,
      );
    });
  }

  /**
   * "Meet Clicky", after setup and from the tray (the official Clicky's first run, without its video):
   * it says hi beside the pointer, looks around the screen and flies to one specific thing with a
   * playful comment, then shows how to start. Skips the look-around until the API keys are in.
   */
  async sayHello(): Promise<void> {
    if (this.greeting) return;
    this.greeting = true;
    try {
      this.overlays.message("Hey! I'm Clicky.", 'info');
      await wait(2600);
      if (this.missingKeys().length === 0 && isResting(this.current.state)) {
        const r = await this.ask(HELLO_QUESTION, 'action');
        if (r?.outcome === 'answered') await wait(1200);
      }
      if (isResting(this.current.state))
        this.overlays.message(`Hold ${this.holdKeyLabel()} and introduce yourself.`, 'info');
    } finally {
      this.greeting = false;
    }
  }
  private greeting = false;

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
    this.tasks.stop();
    this.inventory.stop();
    this.skills.stop();
    this.engine.stop();
    this.strip.destroy();
    this.orb.destroy();
    this.input.dispose();
  }
}
