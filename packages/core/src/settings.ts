/**
 * User settings (everything except API keys, which live in the OS-encrypted credential store).
 * `normalizeSettings` accepts anything read from disk or sent from the settings window and
 * returns a valid object, falling back to defaults field by field.
 */

export const CREDENTIAL_IDS = ['anthropic', 'openrouter', 'openai', 'assemblyai', 'elevenlabs'] as const;
export type CredentialId = (typeof CREDENTIAL_IDS)[number];

export const CHAT_PROVIDERS = ['anthropic', 'openrouter', 'openai'] as const;
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
export type HoldKey = (typeof HOLD_KEYS)[number];

export const HOLD_KEY_LABELS: Record<HoldKey, string> = {
  RightCtrl: 'Right Ctrl',
  RightAlt: 'Right Alt',
  RightShift: 'Right Shift',
  CapsLock: 'Caps Lock',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
};

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
  sttProvider: SttProviderId;
  ttsProvider: TtsProviderId;
  /** ElevenLabs voice id; empty means the default voice. */
  ttsVoice: string;
  /** Which local speech-to-text model to use when sttProvider is 'local'. */
  localSttModel: LocalSttModel;
  /** Local voice as 'engine:voice', e.g. 'kokoro:af_heart' or 'piper:lessac'. */
  localVoice: string;
  /** Local voice speed, 0.7–1.5. */
  localVoiceSpeed: number;
  holdKey: HoldKey;
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
  /** Hold-to-talk is ignored while paused (tray toggle). */
  paused: boolean;
  /** The first-run setup wizard has been completed or skipped. */
  onboardingDone: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  chatProvider: 'anthropic',
  chatModel: '',
  sttProvider: 'assemblyai',
  ttsProvider: 'elevenlabs',
  ttsVoice: '',
  localSttModel: 'auto',
  localVoice: 'piper:en_US-lessac',
  localVoiceSpeed: 1.1,
  holdKey: 'RightCtrl',
  captureMaxEdge: 1280,
  captureAllDisplays: false,
  launchAtLogin: false,
  rememberHistory: true,
  useRecentContext: true,
  micDeviceId: '',
  micAlwaysReady: true,
  cursorColor: 'blue',
  cursorSize: 'medium',
  showPointLabels: true,
  paused: false,
  onboardingDone: false,
});

export const CAPTURE_EDGE_RANGE = { min: 640, max: 2560 } as const;

/** Which credential each provider choice needs. `system` TTS needs none. */
export function requiredCredentials(s: Settings): CredentialId[] {
  const ids = new Set<CredentialId>([s.chatProvider]);
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
  const edge =
    typeof o['captureMaxEdge'] === 'number' && Number.isFinite(o['captureMaxEdge'])
      ? o['captureMaxEdge']
      : base.captureMaxEdge;
  return {
    chatProvider: oneOf(CHAT_PROVIDERS, o['chatProvider'], base.chatProvider),
    chatModel: shortString(o['chatModel'], base.chatModel),
    sttProvider: oneOf(STT_PROVIDERS, o['sttProvider'], base.sttProvider),
    ttsProvider: oneOf(TTS_PROVIDERS, o['ttsProvider'], base.ttsProvider),
    ttsVoice: shortString(o['ttsVoice'], base.ttsVoice),
    localSttModel: oneOf(LOCAL_STT_MODELS, o['localSttModel'], base.localSttModel),
    localVoice: /^(kokoro|piper):[a-z0-9_-]{1,40}$/i.test(String(o['localVoice'] ?? ''))
      ? String(o['localVoice'])
      : base.localVoice,
    localVoiceSpeed:
      typeof o['localVoiceSpeed'] === 'number' && Number.isFinite(o['localVoiceSpeed'])
        ? Math.min(1.5, Math.max(0.7, o['localVoiceSpeed']))
        : base.localVoiceSpeed,
    holdKey: oneOf(HOLD_KEYS, o['holdKey'], base.holdKey),
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
