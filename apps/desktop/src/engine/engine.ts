import {
  HOLD_KEY_LABELS,
  agentReady,
  buildUserContext,
  contextOf,
  learningAllowed,
  parseStyleReply,
  STYLE_PROMPT,
  type ScreenCapture,
  type StyleContext,
  cloudSpeech,
  contextTurns,
  hedgedSpeech,
  isResting,
  Orchestrator,
  type CredentialId,
  type HoldKey,
  type InputAction,
  type WriteContext,
  type AppInfo,
  type SpeechFactory,
  type SttProvider,
  type TtsProvider,
  type VisionChatProvider,
} from '@clicky/core';
import { createChat, createStt, createTts } from '@clicky/providers';
import type { CapturePlan, EngineConfig, EngineToMain, MainToEngine } from '../shared/engine-protocol';
import type { HoldKeyHook } from '../platform/types';
import { demoChat, demoStt } from './demo';
import { LocalSpeechEngine } from './local-speech/engine';
import { ModelFiles } from './local-speech/files';
import { localStt, localTts } from './local-speech/providers';
import type { MediaChannel } from './media-channel';
import { createAudioSink, createCapturePort, createMicPort, systemSpeech } from './media-ports';

export interface EngineOptions {
  /** Engine → main. */
  post(msg: EngineToMain): void;
  media: MediaChannel;
  createHoldKeyHook(key: HoldKey, dictationKey: HoldKey | null): HoldKeyHook;
  now?(): number;
}

/** How long main may take to answer a capture plan request before the question fails. */
const PLAN_TIMEOUT_MS = 3000;
/** A mouse or keyboard request main hasn't answered in this long has failed. */
const INPUT_TIMEOUT_MS = 25_000;
/** How long agent mode waits for the user to allow a risky step. */
const CONFIRM_TIMEOUT_MS = 30_000;
/** Esc presses this soon after Clicky itself typed are its own keys, not the user cancelling. */
const OWN_KEYS_MS = 300;

/**
 * The data plane (architecture §4): hold-to-talk hook, orchestrator and providers. It runs in
 * an Electron utilityProcess, so key events and provider sockets never wait behind window work in
 * main, or inside main as a fallback. Everything it needs from main arrives as messages.
 */
export class Engine {
  readonly orchestrator: Orchestrator;
  private config: EngineConfig | null = null;
  /** Providers are rebuilt only when the config changes, not on every key press. */
  private providers: {
    chat?: VisionChatProvider;
    stt?: SttProvider;
    tts?: TtsProvider | null;
    speech?: SpeechFactory;
  } = {};
  /** On-device models stay loaded across config changes; rebuilt only if the folder moves. */
  private local: { files: ModelFiles; engine: LocalSpeechEngine } | null = null;
  private hook: HoldKeyHook | null = null;
  private keyTest = false;
  private nextPlanId = 1;
  private readonly plans = new Map<number, { resolve: (p: CapturePlan) => void; reject: (e: Error) => void }>();
  private readonly inputs = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly contexts = new Map<number, (c: WriteContext) => void>();
  private readonly foregrounds = new Map<number, (a: AppInfo | null) => void>();
  /** Last mouse or key use that wasn't Clicky's own input. */
  private lastUserInputAt = 0;
  /** Mouse events until then are Clicky's own clicks moving the pointer. */
  private ownMouseUntil = 0;
  /** When the current agent step started, to tell if the user acted since. */
  private stepStartedAt = 0;
  private agentPaused = false;
  /** Last style lesson per context, so learning runs at most every couple of minutes. */
  private readonly learnedAt = new Map<StyleContext, number>();
  /** Until then, an Esc may be one Clicky typed itself. */
  private ownKeysUntil = 0;
  /** Agent mode is waiting for the user to allow a step with the hold key. */
  private pendingConfirm: ((ok: boolean) => void) | null = null;
  /** The hold-key press that answered a confirmation; its release must not end anything. */
  private swallowUp = false;

  constructor(private readonly opts: EngineOptions) {
    const settings = () => this.cfg().settings;
    this.orchestrator = new Orchestrator({
      chat: () => (this.providers.chat ??= this.cfg().demo ? demoChat() : createChat(settings(), this.key)),
      stt: () => (this.providers.stt ??= this.createStt()),
      speech: () => this.speech(),
      capture: createCapturePort(opts.media, (all) => this.plan(all), settings),
      mic: createMicPort(opts.media, () => settings().micDeviceId),
      overlay: {
        state: (state) => this.post({ type: 'overlay', overlay: { op: 'state', state } }),
        point: (target, label) => this.post({ type: 'overlay', overlay: { op: 'point', target, label } }),
        draw: (shape) => this.post({ type: 'overlay', overlay: { op: 'draw', shape } }),
        message: (text, kind) => this.post({ type: 'overlay', overlay: { op: 'message', text, kind } }),
        caption: (text) => this.post({ type: 'overlay', overlay: { op: 'caption', text } }),
      },
      listensDirectly: () => !this.cfg().demo && settings().sttProvider === 'model',
      recentTurns: () => (settings().useRecentContext ? contextTurns(this.cfg().history, Date.now()) : []),
      record: (entry) => this.post({ type: 'record', entry }),
      onLatency: (summary) => this.post({ type: 'latency', summary }),
      onState: (state, interaction) => {
        this.post({ type: 'state', state, interactionId: interaction.id });
        // After each answer, get the speech-to-text service ready for the next question.
        if (isResting(state)) this.prewarm();
      },
      log: (message) => this.post({ type: 'log', level: 'info', message }),
      input: { run: (action, signal) => this.input(action, signal) },
      dictationStt: () =>
        // When the answer model listens itself there is no speech-to-text service: dictate on this PC.
        settings().sttProvider === 'model' ? this.localStt() : (this.providers.stt ??= this.createStt()),
      agent: () => ({
        enabled: settings().agentEnabled,
        confirm: settings().agentConfirm,
        ready: agentReady(settings()),
      }),
      agentNotReady: () => this.post({ type: 'agentSetup' }),
      learnFromScreen: (screens, app) => void this.learnFromScreen(screens, app),
      learnFromDictation: (text, app) => {
        const s = settings();
        if (!s.styleLearning || !learningAllowed(app, s.styleExcludeApps)) return;
        this.post({ type: 'styleLearned', context: contextOf(app), notes: [], examples: [text.slice(0, 200)] });
      },
      agentHooks: () => ({
        blockedApp: () => this.blockedApp(),
        whilePaused: async (signal) => {
          while (this.agentPaused && !signal.aborted) await new Promise((r) => setTimeout(r, 150));
        },
        userInterrupted: () => {
          const took = this.stepStartedAt > 0 && this.lastUserInputAt > this.stepStartedAt;
          this.stepStartedAt = Date.now();
          return took;
        },
        onProgress: (p) => this.post({ type: 'agentProgress', ...p }),
      }),
      confirm: (text, signal) => this.confirm(text, signal),
      writeContext: () => this.writeContext(),
      atCaret: () => this.post({ type: 'caretAnchor' }),
      tidyDictation: () => settings().tidyDictation,
      undoHint: () => {
        const k = settings().dictationKey;
        return k === 'off' ? '' : `Tap ${HOLD_KEY_LABELS[k]} to undo, or hold it and say "shorter" to rewrite.`;
      },
      userContext: (app) => {
        const s = settings();
        const ctx = buildUserContext(
          { name: s.profileName, signOff: s.profileSignOff, tone: s.profileTone, samples: s.profileSamples },
          this.cfg().playbooks,
          app ?? null,
          this.cfg().style,
        );
        return ctx || undefined;
      },
      speed: () => {
        const s = settings();
        return {
          eagerFirstClause: s.eagerFirstClause,
          speculate: s.speculativeAnswer,
          warmCache: s.warmImageCache,
        };
      },
      ...(opts.now ? { now: opts.now } : {}),
    });
  }

  private post(msg: EngineToMain): void {
    this.opts.post(msg);
  }

  private cfg(): EngineConfig {
    if (!this.config) throw new Error('engine not configured yet');
    return this.config;
  }

  private readonly key = (id: CredentialId): string | null => this.config?.keys[id] ?? null;

  private localSpeech(): { files: ModelFiles; engine: LocalSpeechEngine } {
    const dir = this.cfg().modelsDir;
    if (this.local?.files.root !== dir) {
      const files = new ModelFiles(dir);
      const engine = new LocalSpeechEngine(files, (message) => this.post({ type: 'log', level: 'warn', message }));
      this.local = { files, engine };
    }
    return this.local;
  }

  private localStt(): SttProvider {
    return localStt(this.localSpeech().engine, () => this.cfg().settings.localSttModel);
  }

  private localTts(): TtsProvider {
    const { engine, files } = this.localSpeech();
    return localTts(engine, files, () => this.cfg().settings);
  }

  private createStt(): SttProvider {
    const cfg = this.cfg();
    // Demo mode swaps out cloud services only; on-device speech is real either way.
    if (cfg.settings.sttProvider === 'local') return this.localStt();
    return cfg.demo ? demoStt() : createStt(cfg.settings, this.key);
  }

  private createTts(): TtsProvider | null {
    const cfg = this.cfg();
    if (cfg.settings.ttsProvider === 'local') return this.localTts();
    return cfg.demo ? null : createTts(cfg.settings, this.key);
  }

  private speech(): SpeechFactory {
    if (this.providers.speech) return this.providers.speech;
    const tts = this.providers.tts === undefined ? (this.providers.tts = this.createTts()) : this.providers.tts;
    const system = systemSpeech(this.opts.media);
    let factory = system;
    if (tts) {
      factory = cloudSpeech(tts, () => createAudioSink(this.opts.media));
      // An online voice that stalls falls back to the Windows voice for that answer.
      if (this.cfg().settings.backupVoice && this.cfg().settings.ttsProvider !== 'local')
        factory = hedgedSpeech(factory, system);
    }
    this.providers.speech = factory;
    return factory;
  }

  private plan(allDisplays: boolean): Promise<CapturePlan> {
    const id = this.nextPlanId++;
    return new Promise<CapturePlan>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.plans.delete(id);
        reject(new Error('screen layout request timed out'));
      }, PLAN_TIMEOUT_MS);
      this.plans.set(id, {
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({ type: 'capturePlan', id, allDisplays });
    });
  }

  handle(msg: MainToEngine): void {
    switch (msg.type) {
      case 'config': {
        const prev = this.config;
        this.config = msg.config;
        // Rebuild providers lazily if anything they depend on changed (provider, model, voice, keys).
        if (
          !prev ||
          JSON.stringify(prev.settings) !== JSON.stringify(msg.config.settings) ||
          !sameKeys(prev, msg.config)
        )
          this.providers = {};
        if (
          prev &&
          this.hook &&
          (prev.settings.holdKey !== msg.config.settings.holdKey ||
            prev.settings.dictationKey !== msg.config.settings.dictationKey)
        )
          this.startHoldKey();
        return;
      }
      case 'holdKey.start':
        return this.startHoldKey();
      case 'holdKey.stop':
        return this.stopHoldKey();
      case 'keyTest':
        this.keyTest = msg.on;
        return;
      case 'ask':
        void this.orchestrator
          .ask(msg.question, msg.source)
          .catch(() => null)
          .then((result) => this.post({ type: 'askResult', id: msg.id, result }));
        return;
      case 'cancel':
        return this.orchestrator.cancel(msg.reason);
      case 'speakSample':
        void this.speakSample(msg.text).then(
          () => this.post({ type: 'speakSampleResult', id: msg.id }),
          (e: unknown) =>
            this.post({ type: 'speakSampleResult', id: msg.id, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
      case 'prewarm':
        return this.prewarm();
      case 'input.reply': {
        const p = this.inputs.get(msg.id);
        if (!p) return;
        this.inputs.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve();
        return;
      }
      case 'foreground.reply': {
        const done = this.foregrounds.get(msg.id);
        this.foregrounds.delete(msg.id);
        done?.(msg.app);
        return;
      }
      case 'agent.pause':
        this.agentPaused = msg.on;
        this.post({ type: 'agentPaused', on: msg.on });
        return;
      case 'agent.allow':
        this.pendingConfirm?.(true);
        return;
      case 'writeContext.reply': {
        const done = this.contexts.get(msg.id);
        this.contexts.delete(msg.id);
        done?.(msg.context);
        return;
      }
      case 'capturePlan.reply': {
        const p = this.plans.get(msg.id);
        if (!p) return;
        this.plans.delete(msg.id);
        if (msg.plan) p.resolve(msg.plan);
        else p.reject(new Error(msg.error ?? 'no screen to capture'));
        return;
      }
      case 'media.crashed':
        // The port side handles in-flight requests; nothing to do for an in-process channel.
        return;
      case 'shutdown':
        this.stopHoldKey();
        this.orchestrator.cancel('quitting');
        return;
    }
  }

  private startHoldKey(): void {
    this.stopHoldKey();
    if (!this.config) return;
    try {
      const s = this.config.settings;
      const hook = this.opts.createHoldKeyHook(s.holdKey, s.dictationKey === 'off' ? null : s.dictationKey);
      hook.start({
        onDown: () => this.keyDown(),
        onUp: () => {
          if (this.keyTest) return this.post({ type: 'keyTest', down: false, key: 'talk' });
          if (this.swallowUp) {
            this.swallowUp = false;
            return;
          }
          this.orchestrator.keyUp();
        },
        onCancel: () => {
          if (Date.now() < this.ownKeysUntil) return;
          this.pendingConfirm?.(false);
          this.orchestrator.cancel('escape');
        },
        onDictateDown: () => this.dictateDown(),
        onUserInput: () => {
          const now = Date.now();
          if (now < this.ownKeysUntil || now < this.ownMouseUntil) return;
          this.lastUserInputAt = now;
        },
        onDictateUp: () => {
          if (this.keyTest) return this.post({ type: 'keyTest', down: false, key: 'dictate' });
          this.orchestrator.keyUp();
        },
      });
      this.hook = hook;
    } catch (e) {
      this.post({ type: 'holdKey.failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private keyDown(): void {
    if (this.keyTest) return this.post({ type: 'keyTest', down: true, key: 'talk' });
    if (this.pendingConfirm) {
      // Agent mode asked "press the key to allow": this press is the answer, not a new question.
      this.swallowUp = true;
      this.pendingConfirm(true);
      return;
    }
    const cfg = this.config;
    if (!cfg || cfg.settings.paused) return;
    if (cfg.missing.length) {
      // Nothing can work yet: say so and open the place to fix it, instead of failing later.
      this.post({
        type: 'overlay',
        overlay: { op: 'message', text: 'Clicky needs your API keys first. Opening Clicky…', kind: 'info' },
      });
      this.post({ type: 'needKeys' });
      return;
    }
    // The mic and capture start first; moving windows can wait a millisecond.
    this.orchestrator.keyDown();
    this.post({ type: 'listening' });
  }

  private dictateDown(): void {
    if (this.keyTest) return this.post({ type: 'keyTest', down: true, key: 'dictate' });
    if (this.pendingConfirm) return;
    const cfg = this.config;
    if (!cfg || cfg.settings.paused) return;
    // Releasing Alt on its own opens the menu bar in many apps; a no-op key while it's held stops that.
    if (cfg.settings.dictationKey === 'RightAlt')
      void this.input({ kind: 'keys', keys: ['mask'] }, new AbortController().signal).catch(() => undefined);
    this.orchestrator.dictateDown();
    this.post({ type: 'caretAnchor' });
  }

  /**
   * Background, after a write: ask the model what the user's own visible writing says about their
   * style. At most every two minutes per kind of app, never in excluded apps, never blocking anything.
   */
  private async learnFromScreen(screens: ScreenCapture, app: AppInfo | null): Promise<void> {
    const s = this.cfg().settings;
    if (!s.styleLearning || this.cfg().demo || !learningAllowed(app, s.styleExcludeApps)) return;
    const ctx = contextOf(app);
    if (ctx === 'other' || Date.now() - (this.learnedAt.get(ctx) ?? 0) < 120_000) return;
    this.learnedAt.set(ctx, Date.now());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      const chat = (this.providers.chat ??= createChat(s, this.key));
      let reply = '';
      for await (const t of chat.stream({
        system: STYLE_PROMPT,
        history: [],
        question: "Study the user's own writing in this screenshot.",
        images: screens.images,
        maxTokens: 300,
        signal: ac.signal,
      }))
        reply += t;
      const obs = parseStyleReply(reply);
      if (obs) this.post({ type: 'styleLearned', context: ctx, ...obs });
    } catch (e) {
      this.post({
        type: 'log',
        level: 'warn',
        message: `style learning skipped: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** The app in front if it's on the never-touch list. */
  private async blockedApp(): Promise<string | null> {
    const list = this.cfg()
      .settings.agentBlockedApps.split(',')
      .map((a) =>
        a
          .trim()
          .toLowerCase()
          .replace(/\.exe$/, '')
          .replace(/\s+/g, ''),
      )
      .filter((a) => a.length >= 2);
    if (!list.length) return null;
    const id = this.nextPlanId++;
    const app = await new Promise<AppInfo | null>((resolve) => {
      const timer = setTimeout(() => {
        this.foregrounds.delete(id);
        resolve(null);
      }, 1500);
      this.foregrounds.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      this.post({ type: 'foreground', id });
    });
    if (!app) return null;
    const hay = `${app.process} ${app.title}`.toLowerCase().replace(/\s+/g, '');
    return list.some((n) => hay.includes(n)) ? app.title || app.process : null;
  }

  /** Ask main for the app in front and the selection; an empty context if main is slow. */
  private writeContext(): Promise<WriteContext> {
    const id = this.nextPlanId++;
    return new Promise<WriteContext>((resolve) => {
      const timer = setTimeout(() => {
        this.contexts.delete(id);
        resolve({ app: null, selection: null });
      }, 1500);
      this.contexts.set(id, (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      this.post({ type: 'writeContext', id });
    });
  }

  /** Ask main to press keys or use the mouse, and wait until it has. */
  private input(action: InputAction, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('cancelled'));
    const id = this.nextPlanId++;
    if (action.kind === 'keys' || action.kind === 'type' || action.kind === 'backspace')
      this.ownKeysUntil = Date.now() + 60_000;
    if (action.kind === 'click' || action.kind === 'scroll') this.ownMouseUntil = Date.now() + 60_000;
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.inputs.delete(id);
        this.ownKeysUntil = Math.min(this.ownKeysUntil, Date.now() + OWN_KEYS_MS);
        this.ownMouseUntil = Math.min(this.ownMouseUntil, Date.now() + OWN_KEYS_MS);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error('Windows did not accept the mouse or keyboard input in time.'));
      }, INPUT_TIMEOUT_MS);
      this.inputs.set(id, {
        resolve: () => {
          done();
          resolve();
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      this.post({ type: 'input', id, action });
    });
  }

  /** Agent mode: show what's about to happen and wait for a hold-key press (allow) or Esc (stop). */
  private confirm(text: string, signal: AbortSignal): Promise<boolean> {
    const key = HOLD_KEY_LABELS[this.cfg().settings.holdKey];
    const prompt = `${text}? Press ${key} to allow, or Esc to stop.`;
    const show = (): void => this.post({ type: 'overlay', overlay: { op: 'message', text: prompt, kind: 'info' } });
    return new Promise<boolean>((resolve) => {
      show();
      this.post({ type: 'agentAsk', text: `${text}?` });
      const again = setInterval(show, 8000); // overlay messages fade; keep the question up
      const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
      const onAbort = (): void => finish(false);
      const finish = (ok: boolean): void => {
        clearInterval(again);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.pendingConfirm === finish) this.pendingConfirm = null;
        this.post({ type: 'agentAsk', text: null });
        resolve(ok);
      };
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingConfirm = finish;
    });
  }

  private stopHoldKey(): void {
    this.hook?.stop();
    this.hook = null;
  }

  /** Idle-time preparation for the next question (e.g. a streaming token). Never throws. */
  private prewarm(): void {
    const cfg = this.config;
    if (!cfg) return;
    try {
      // On-device models need no key: load them even before keys are entered.
      if (cfg.settings.sttProvider === 'local') this.localStt().prewarm?.();
      if (cfg.settings.ttsProvider === 'local') void this.localTts().prewarm?.(new AbortController().signal);
      if (
        cfg.demo ||
        cfg.missing.length ||
        cfg.settings.sttProvider === 'model' ||
        cfg.settings.sttProvider === 'local'
      )
        return;
      (this.providers.stt ??= createStt(cfg.settings, this.key)).prewarm?.();
    } catch {
      // missing config shows up when the user asks
    }
  }

  /** Voice preview for the dashboard. */
  private sampleAc: AbortController | null = null;

  /**
   * One preview at a time: a new one stops the one playing. Previews skip the backup Windows voice
   * so a slow cloud voice can't end up playing alongside it.
   */
  private async speakSample(text: string): Promise<void> {
    this.sampleAc?.abort();
    const ac = new AbortController();
    this.sampleAc = ac;
    const timer = setTimeout(() => ac.abort(), 20000);
    const tts = this.providers.tts === undefined ? (this.providers.tts = this.createTts()) : this.providers.tts;
    const factory = tts ? cloudSpeech(tts, () => createAudioSink(this.opts.media)) : systemSpeech(this.opts.media);
    const out = factory.create(ac.signal);
    try {
      out.say(text);
      out.end();
      await out.done;
      if (ac.signal.aborted && this.sampleAc === ac)
        throw new Error('The voice took too long to respond. Check your internet connection.');
    } finally {
      clearTimeout(timer);
      out.stop();
      if (this.sampleAc === ac) this.sampleAc = null;
    }
  }
}

function sameKeys(a: EngineConfig, b: EngineConfig): boolean {
  const ids = new Set([...Object.keys(a.keys), ...Object.keys(b.keys)]) as Set<CredentialId>;
  for (const id of ids) if (a.keys[id] !== b.keys[id]) return false;
  return true;
}
