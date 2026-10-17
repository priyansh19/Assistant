/**
 * User settings (everything except API keys, which live in the OS-encrypted credential store).
 * `normalizeSettings` accepts anything read from disk or sent from the settings window and
 * returns a valid object, falling back to defaults field by field.
 */

export const CREDENTIAL_IDS = ['anthropic', 'openrouter', 'openai', 'assemblyai', 'elevenlabs'] as const;
export type CredentialId = (typeof CREDENTIAL_IDS)[number];

export const CHAT_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'ollama'] as const;
export type ChatProviderId = (typeof CHAT_PROVIDERS)[number];

/** 'model': the answer model listens to the recorded audio itself (e.g. Gemini via OpenRouter). */
/** 'local': on this PC (OpenWhispr's Parakeet server if running, else a downloaded model). */
export const STT_PROVIDERS = ['assemblyai', 'openai', 'model', 'local'] as const;
export type SttProviderId = (typeof STT_PROVIDERS)[number];

/** 'local': Kokoro or Piper running on this PC. */
export const TTS_PROVIDERS = ['elevenlabs', 'openai', 'system', 'local'] as const;

/** Downloadable local speech-to-text models. 'auto' prefers a running OpenWhispr server. */
export const LOCAL_STT_MODELS = ['auto', 'moonshine-tiny', 'parakeet-v3'] as const;
export type LocalSttModel = (typeof LOCAL_STT_MODELS)[number];
export type TtsProviderId = (typeof TTS_PROVIDERS)[number];

/** Keys that work well for hold-to-talk because they do nothing on their own. */
export const HOLD_KEYS = ['RightCtrl', 'RightAlt', 'RightShift', 'CapsLock', 'F8', 'F9', 'F10'] as const;
export type PresetKey = (typeof HOLD_KEYS)[number];
/**
 * A key combination the user recorded in settings ("Win + Alt"): "combo:<keycode>+<keycode>=<label>",
 * keycodes as the keyboard hook reports them. Held means every key in it is down.
 */
export type ComboKey = `combo:${string}`;
export type HoldKey = PresetKey | ComboKey;

const COMBO = /^combo:(\d{1,5}(?:\+\d{1,5}){0,3})=(.{1,40})$/;

export function isComboKey(k: unknown): k is ComboKey {
  return typeof k === 'string' && COMBO.test(k);
}

/** The keycodes of a recorded combination. */
export function comboKeycodes(k: ComboKey): number[] {
  return (COMBO.exec(k)?.[1] ?? '').split('+').map(Number);
}

export function makeComboKey(codes: readonly number[], label: string): ComboKey {
  return `combo:${[...new Set(codes)].slice(0, 4).join('+')}=${label.replace(/[\r\n=]/g, ' ').slice(0, 40)}`;
}

/** How to name the key in the UI and in spoken hints ("Right Ctrl", "Win + Alt"). */
export function holdKeyLabel(k: HoldKey | 'off'): string {
  if (k === 'off') return 'Off';
  if (isComboKey(k)) return COMBO.exec(k)?.[2] ?? 'your key combination';
  return HOLD_KEY_LABELS[k];
}

export const HOLD_KEY_LABELS: Record<PresetKey, string> = {
  RightCtrl: 'Right Ctrl',
  RightAlt: 'Right Alt',
  RightShift: 'Right Shift',
  CapsLock: 'Caps Lock',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
};

/** The dictation key: hold it, talk, release, and the words are typed into the focused app. */
export type DictationKey = HoldKey | 'off';

/** When agent mode asks before acting: only for risky steps (send, buy, delete…) or every step. */
export const AGENT_CONFIRM_MODES = ['risky', 'always'] as const;
export type AgentConfirmMode = (typeof AGENT_CONFIRM_MODES)[number];

/** Short sounds when the hold key goes down and comes back up (synthesised, Clicky's own). */
export const CUE_SOUNDS = ['soft', 'bubble', 'glass', 'off'] as const;
export type CueSound = (typeof CUE_SOUNDS)[number];

export const CURSOR_COLORS = ['blue', 'purple', 'green', 'orange', 'pink'] as const;
export type CursorColor = (typeof CURSOR_COLORS)[number];

export const CURSOR_COLOR_HEX: Record<CursorColor, string> = {
  blue: '#2f8cff',
  purple: '#8b5cf6',
  green: '#22c55e',
  orange: '#f97316',
  pink: '#ec4899',
};

export const CURSOR_SIZES = ['small', 'medium', 'large'] as const;
export type CursorSize = (typeof CURSOR_SIZES)[number];

export interface Settings {
  chatProvider: ChatProviderId;
  /** Model id for the chat provider; empty means the provider's fast default. */
  chatModel: string;
  /** The model for agent steps (OpenRouter id); empty uses the default, chosen for click accuracy. */
  agentModel: string;
  /** Where Ollama runs, for the local answer model. */
  ollamaUrl: string;
  sttProvider: SttProviderId;
  ttsProvider: TtsProviderId;
  /** ElevenLabs voice id; empty means the default voice. */
  ttsVoice: string;
  /** Which local speech-to-text model to use when sttProvider is 'local'. */
  localSttModel: LocalSttModel;
  /** Local voice as 'engine:voice', e.g. 'kokoro:af_heart' or 'piper:lessac'. */
  localVoice: string;
  /** Voice speed, 0.7–2.0 (on-device voices; OpenAI voices too). */
  localVoiceSpeed: number;
  holdKey: HoldKey;
  /** Second hold key for dictation; 'off' disables it. Never the same as holdKey. */
  dictationKey: DictationKey;
  /** Questions that start with "agent" are carried out with the mouse and keyboard. */
  agentEnabled: boolean;
  agentConfirm: AgentConfirmMode;
  /** When the user accepted the agent rules (ms since epoch); 0 = never. Agent mode needs it. */
  agentConsentAt: number;
  /** The rules version they accepted; a material change asks again. */
  agentRulesVersion: number;
  /** Apps agent mode must never act in (comma-separated process or window names). */
  agentBlockedApps: string;
  /** Plain dictation is tidied by the AI (punctuation, lists) before it's typed. */
  tidyDictation: boolean;
  /** Sound on key press and release. */
  cueSound: CueSound;
  /** "Writes like me": used when Clicky writes for the user. Stored on this PC only. */
  profileName: string;
  profileSignOff: string;
  profileTone: string;
  profileSamples: string;
  /** Learn how the user writes from write-mode screenshots and their dictation (stored on this PC). */
  styleLearning: boolean;
  /** Apps Clicky never learns from (comma-separated). */
  styleExcludeApps: string;
  /** Long edge of the screenshot sent to the model, in pixels. */
  captureMaxEdge: number;
  captureAllDisplays: boolean;
  launchAtLogin: boolean;
  /** Keep a local, text-only history of questions and answers. */
  rememberHistory: boolean;
  /** Send the last few answered turns as context so follow-up questions work. */
  useRecentContext: boolean;
  /** Microphone device id; empty means the Windows default. */
  micDeviceId: string;
  /**
   * Keep the microphone open (but not recording) between presses. Opening a Windows audio device
   * takes ~0.5–1 s, which would cut off the start of every question. Nothing is sent anywhere
   * until the key is held.
   */
  micAlwaysReady: boolean;
  cursorColor: CursorColor;
  cursorSize: CursorSize;
  /** Show the label bubble when Clicky points at something. */
  showPointLabels: boolean;
  /**
   * Keep the companion beside the pointer all the time. Off: it appears when the hold key goes
   * down and fades out a second after the answer (the official Clicky's "Show Clicky" toggle).
   */
  showCompanion: boolean;
  /**
   * Keep Clicky's own windows (cursor, bubbles, task strip, orb) out of every screenshot, as the
   * official Clicky does, so the model never sees them. Screen recordings and screen sharing then
   * don't show them either.
   */
  hideFromCapture: boolean;
  /**
   * Speed features (architecture §7). Each can be turned off to compare its effect in the trace.
   * Start speaking at the first clause instead of the first full sentence.
   */
  eagerFirstClause: boolean;
  /** Send the question at key-up from the interim transcript; discarded if the final one differs. */
  speculativeAnswer: boolean;
  /** Upload the screenshot while the key is held so the model has it cached at key-up (Anthropic). */
  warmImageCache: boolean;
  /** Keep one streaming connection to the voice service for the whole answer (ElevenLabs). */
  streamingVoice: boolean;
  /** Switch to the Windows voice if the cloud voice has not started after a moment. */
  backupVoice: boolean;
  /**
   * Keep the voice path warm between presses while Clicky is in use: the answer model's connection,
   * a spare voice socket and a speech-recognition token, so the first press after a pause is as fast
   * as the rest.
   */
  keepVoiceWarm: boolean;
  /** Say a few words at once ("On it.") before slow work: agent tasks, hard questions, drawings. */
  spokenBeats: boolean;
  /** Hand hard questions to a stronger model (deepModel) instead of a quick, shallow answer. */
  deepRouting: boolean;
  /** OpenRouter model for hard questions; empty uses the agent model. */
  deepModel: string;
  /** "How do I…" questions in an app become walkthroughs that advance when the user clicks each step. */
  guidedWalkthroughs: boolean;
  /** Hold-to-talk is ignored while paused (tray toggle). */
  paused: boolean;
  /** The first-run setup wizard has been completed or skipped. */
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  chatProvider: 'anthropic',
  chatModel: '',
  agentModel: '',
  ollamaUrl: 'http://localhost:11434',
  sttProvider: 'assemblyai',
  ttsProvider: 'elevenlabs',
  ttsVoice: '',
  localSttModel: 'auto',
  localVoice: 'piper:en_US-lessac',
  localVoiceSpeed: 1.1,
  holdKey: 'RightCtrl',
  dictationKey: 'RightAlt',
  agentEnabled: false,
  agentConfirm: 'risky',
  agentConsentAt: 0,
  agentRulesVersion: 0,
  agentBlockedApps:
    '1password, bitwarden, keepass, keepassxc, lastpass, dashlane, keeper, enpass, protonpass, roboform',
  tidyDictation: true,
  cueSound: 'soft',
  profileName: '',
  profileSignOff: '',
  profileTone: '',
  profileSamples: '',
  styleLearning: true,
  styleExcludeApps: '1password, bitwarden, keepass, lastpass, dashlane, keeper, bank',
  captureMaxEdge: 1280,
  captureAllDisplays: true,
  launchAtLogin: false,
  rememberHistory: true,
  useRecentContext: true,
  micDeviceId: '',
  micAlwaysReady: true,
  cursorColor: 'blue',
  cursorSize: 'medium',
  showPointLabels: true,
  showCompanion: true,
  hideFromCapture: true,
  eagerFirstClause: true,
  speculativeAnswer: true,
  warmImageCache: true,
  streamingVoice: true,
  backupVoice: true,
  keepVoiceWarm: true,
  spokenBeats: true,
  deepRouting: true,
  deepModel: '',
  guidedWalkthroughs: true,
  paused: false,
  onboardingDone: false,
});

export const CAPTURE_EDGE_RANGE = { min: 640, max: 2560 } as const;

/** Bump when the agent rules shown to the user change materially; they are asked to agree again. */
export const AGENT_RULES_VERSION = 1;

/** Agent mode may act only when it's on and the current rules were accepted. */
export function agentReady(s: Settings): boolean {
  return s.agentEnabled && s.agentConsentAt > 0 && s.agentRulesVersion >= AGENT_RULES_VERSION;
}

/** Which credential each provider choice needs. `system` TTS needs none. */
export function requiredCredentials(s: Settings): CredentialId[] {
  // Ollama runs on this PC and needs no key.
  const ids = new Set<CredentialId>(s.chatProvider === 'ollama' ? [] : [s.chatProvider]);
  if (s.sttProvider !== 'model' && s.sttProvider !== 'local') ids.add(s.sttProvider);
  if (s.ttsProvider !== 'system' && s.ttsProvider !== 'local') ids.add(s.ttsProvider);
  return [...ids];
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function shortString(value: unknown, fallback: string, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

export function normalizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const holdKey: HoldKey = isComboKey(o['holdKey'])
    ? o['holdKey']
    : oneOf<HoldKey>(HOLD_KEYS, o['holdKey'], base.holdKey);
  const dictation: DictationKey = isComboKey(o['dictationKey'])
    ? o['dictationKey']
    : oneOf<DictationKey>([...HOLD_KEYS, 'off'], o['dictationKey'], base.dictationKey);
  const edge =
    typeof o['captureMaxEdge'] === 'number' && Number.isFinite(o['captureMaxEdge'])
      ? o['captureMaxEdge']
      : base.captureMaxEdge;
  return {
    chatProvider: oneOf(CHAT_PROVIDERS, o['chatProvider'], base.chatProvider),
    chatModel: shortString(o['chatModel'], base.chatModel),
    agentModel: shortString(o['agentModel'], base.agentModel),
    ollamaUrl: /^https?:\/\/[^\s]+$/.test(String(o['ollamaUrl'] ?? ''))
      ? String(o['ollamaUrl']).replace(/\/+$/, '')
      : base.ollamaUrl,
    sttProvider: oneOf(STT_PROVIDERS, o['sttProvider'], base.sttProvider),
    ttsProvider: oneOf(TTS_PROVIDERS, o['ttsProvider'], base.ttsProvider),
    ttsVoice: shortString(o['ttsVoice'], base.ttsVoice),
    localSttModel: oneOf(LOCAL_STT_MODELS, o['localSttModel'], base.localSttModel),
    localVoice: /^(kokoro|piper):[a-z0-9_-]{1,40}$/i.test(String(o['localVoice'] ?? ''))
      ? String(o['localVoice'])
      : base.localVoice,
    localVoiceSpeed:
      typeof o['localVoiceSpeed'] === 'number' && Number.isFinite(o['localVoiceSpeed'])
        ? Math.min(2, Math.max(0.7, o['localVoiceSpeed']))
        : base.localVoiceSpeed,
    holdKey,
    dictationKey: dictation === holdKey ? 'off' : dictation,
    agentEnabled: bool(o['agentEnabled'], base.agentEnabled),
    agentConfirm: oneOf(AGENT_CONFIRM_MODES, o['agentConfirm'], base.agentConfirm),
    agentConsentAt:
      typeof o['agentConsentAt'] === 'number' && Number.isFinite(o['agentConsentAt']) && o['agentConsentAt'] >= 0
        ? o['agentConsentAt']
        : base.agentConsentAt,
    agentRulesVersion:
      typeof o['agentRulesVersion'] === 'number' && Number.isInteger(o['agentRulesVersion'])
        ? o['agentRulesVersion']
        : base.agentRulesVersion,
    agentBlockedApps: shortString(o['agentBlockedApps'], base.agentBlockedApps, 600),
    tidyDictation: bool(o['tidyDictation'], base.tidyDictation),
    cueSound: oneOf(CUE_SOUNDS, o['cueSound'], base.cueSound),
    profileName: shortString(o['profileName'], base.profileName, 80),
    profileSignOff: shortString(o['profileSignOff'], base.profileSignOff, 200),
    profileTone: shortString(o['profileTone'], base.profileTone, 200),
    profileSamples: shortString(o['profileSamples'], base.profileSamples, 4000),
    styleLearning: bool(o['styleLearning'], base.styleLearning),
    styleExcludeApps: shortString(o['styleExcludeApps'], base.styleExcludeApps, 600),
    captureMaxEdge: Math.round(Math.min(Math.max(edge, CAPTURE_EDGE_RANGE.min), CAPTURE_EDGE_RANGE.max)),
    captureAllDisplays:
      typeof o['captureAllDisplays'] === 'boolean' ? o['captureAllDisplays'] : base.captureAllDisplays,
    launchAtLogin: bool(o['launchAtLogin'], base.launchAtLogin),
    rememberHistory: bool(o['rememberHistory'], base.rememberHistory),
    useRecentContext: bool(o['useRecentContext'], base.useRecentContext),
    micDeviceId: shortString(o['micDeviceId'], base.micDeviceId, 300),
    micAlwaysReady: bool(o['micAlwaysReady'], base.micAlwaysReady),
    cursorColor: oneOf(CURSOR_COLORS, o['cursorColor'], base.cursorColor),
    cursorSize: oneOf(CURSOR_SIZES, o['cursorSize'], base.cursorSize),
    showPointLabels: bool(o['showPointLabels'], base.showPointLabels),
    showCompanion: bool(o['showCompanion'], base.showCompanion),
    hideFromCapture: bool(o['hideFromCapture'], base.hideFromCapture),
    eagerFirstClause: bool(o['eagerFirstClause'], base.eagerFirstClause),
    speculativeAnswer: bool(o['speculativeAnswer'], base.speculativeAnswer),
    warmImageCache: bool(o['warmImageCache'], base.warmImageCache),
    streamingVoice: bool(o['streamingVoice'], base.streamingVoice),
    backupVoice: bool(o['backupVoice'], base.backupVoice),
    keepVoiceWarm: bool(o['keepVoiceWarm'], base.keepVoiceWarm),
    spokenBeats: bool(o['spokenBeats'], base.spokenBeats),
    deepRouting: bool(o['deepRouting'], base.deepRouting),
    deepModel: shortString(o['deepModel'], base.deepModel),
    guidedWalkthroughs: bool(o['guidedWalkthroughs'], base.guidedWalkthroughs),
    paused: bool(o['paused'], base.paused),
    onboardingDone: bool(o['onboardingDone'], base.onboardingDone),
  };
}

/** Basic shape check for a pasted API key, so obvious mistakes are caught before saving. */
export function validateApiKey(
  id: CredentialId,
  key: string,
): { ok: true; key: string } | { ok: false; reason: string } {
  const k = key.trim();
  if (!k) return { ok: false, reason: 'The key is empty.' };
  if (/\s/.test(k)) return { ok: false, reason: 'The key contains spaces or line breaks.' };
  if (k.length < 16 || k.length > 300) return { ok: false, reason: 'That does not look like a full API key.' };
  const prefixes: Partial<Record<CredentialId, string>> = { anthropic: 'sk-ant-', openrouter: 'sk-or-', openai: 'sk-' };
  const prefix = prefixes[id];
  const names: Record<CredentialId, string> = {
    anthropic: 'Anthropic',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    assemblyai: 'AssemblyAI',
    elevenlabs: 'ElevenLabs',
  };
  if (prefix && !k.startsWith(prefix)) return { ok: false, reason: `${names[id]} keys start with "${prefix}".` };
  return { ok: true, key: k };
}
