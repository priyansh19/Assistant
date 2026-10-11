import {
  cloudSpeech,
  contextTurns,
  isResting,
  Orchestrator,
  type CredentialId,
  type HoldKey,
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
  createHoldKeyHook(key: HoldKey): HoldKeyHook;
  now?(): number;
}

/** How long main may take to answer a capture plan request before the question fails. */
const PLAN_TIMEOUT_MS = 3000;

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
    const factory = tts ? cloudSpeech(tts, () => createAudioSink(this.opts.media)) : systemSpeech(this.opts.media);
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
        if (prev && prev.settings.holdKey !== msg.config.settings.holdKey && this.hook) this.startHoldKey();
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
      const hook = this.opts.createHoldKeyHook(this.config.settings.holdKey);
      hook.start({
        onDown: () => this.keyDown(),
        onUp: () => {
          if (this.keyTest) return this.post({ type: 'keyTest', down: false });
          this.orchestrator.keyUp();
        },
        onCancel: () => this.orchestrator.cancel('escape'),
      });
      this.hook = hook;
    } catch (e) {
      this.post({ type: 'holdKey.failed', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private keyDown(): void {
    if (this.keyTest) return this.post({ type: 'keyTest', down: true });
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
  private async speakSample(text: string): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const out = this.speech().create(ac.signal);
    try {
      out.say(text);
      out.end();
      await out.done;
      if (ac.signal.aborted) throw new Error('The voice took too long to respond. Check your internet connection.');
    } finally {
      clearTimeout(timer);
      out.stop();
    }
  }
}

function sameKeys(a: EngineConfig, b: EngineConfig): boolean {
  const ids = new Set([...Object.keys(a.keys), ...Object.keys(b.keys)]) as Set<CredentialId>;
  for (const id of ids) if (a.keys[id] !== b.keys[id]) return false;
  return true;
}
