/**
 * User settings (everything except API keys, which live in the OS-encrypted credential store).
 * `normalizeSettings` accepts anything read from disk or sent from the settings window and
 * returns a valid object, falling back to defaults field by field.
 */

export const CREDENTIAL_IDS = ['anthropic', 'openrouter', 'openai', 'assemblyai', 'elevenlabs'] as const;
export type CredentialId = (typeof CREDENTIAL_IDS)[number];

export const CHAT_PROVIDERS = ['anthropic', 'openrouter', 'openai'] as const;
export type ChatProviderId = (typeof CHAT_PROVIDERS)[number];

export const STT_PROVIDERS = ['assemblyai', 'openai'] as const;
export type SttProviderId = (typeof STT_PROVIDERS)[number];

export const TTS_PROVIDERS = ['elevenlabs', 'openai', 'system'] as const;
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

export interface Settings {
  chatProvider: ChatProviderId;
  /** Model id for the chat provider; empty means the provider's fast default. */
  chatModel: string;
  sttProvider: SttProviderId;
  ttsProvider: TtsProviderId;
  /** ElevenLabs voice id; empty means the default voice. */
  ttsVoice: string;
  holdKey: HoldKey;
  /** Long edge of the screenshot sent to the model, in pixels. */
  captureMaxEdge: number;
  captureAllDisplays: boolean;
  launchAtLogin: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  chatProvider: 'anthropic',
  chatModel: '',
  sttProvider: 'assemblyai',
  ttsProvider: 'elevenlabs',
  ttsVoice: '',
  holdKey: 'RightCtrl',
  captureMaxEdge: 1280,
  captureAllDisplays: false,
  launchAtLogin: false,
});

export const CAPTURE_EDGE_RANGE = { min: 640, max: 2560 } as const;

/** Which credential each provider choice needs. `system` TTS needs none. */
export function requiredCredentials(s: Settings): CredentialId[] {
  const ids = new Set<CredentialId>([s.chatProvider, s.sttProvider]);
  if (s.ttsProvider !== 'system') ids.add(s.ttsProvider);
  return [...ids];
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback;
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
    holdKey: oneOf(HOLD_KEYS, o['holdKey'], base.holdKey),
    captureMaxEdge: Math.round(Math.min(Math.max(edge, CAPTURE_EDGE_RANGE.min), CAPTURE_EDGE_RANGE.max)),
    captureAllDisplays:
      typeof o['captureAllDisplays'] === 'boolean' ? o['captureAllDisplays'] : base.captureAllDisplays,
    launchAtLogin: typeof o['launchAtLogin'] === 'boolean' ? o['launchAtLogin'] : base.launchAtLogin,
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
  if (prefix && !k.startsWith(prefix)) return { ok: false, reason: `${id} keys start with "${prefix}".` };
  return { ok: true, key: k };
}
