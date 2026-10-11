import {
  ConfigError,
  type CredentialId,
  type Settings,
  type SttProvider,
  type TtsProvider,
  type VisionChatProvider,
} from '@clicky/core';
import { AnthropicChat, ANTHROPIC_DEFAULT_MODEL, checkAnthropicKey } from './anthropic.js';
import { AssemblyAIStt, checkAssemblyAIKey } from './assemblyai.js';
import { checkElevenLabsKey, ElevenLabsTts } from './elevenlabs.js';
import type { FetchLike } from './http.js';
import { OpenAIStt, OpenAITts } from './openai-audio.js';
import {
  checkOpenAICompatibleKey,
  OpenAICompatibleChat,
  OPENAI_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
} from './openai-compatible.js';

export * from './anthropic.js';
export * from './assemblyai.js';
export * from './elevenlabs.js';
export * from './http.js';
export * from './openai-audio.js';
export * from './openai-compatible.js';
export * from './tts-queue.js';

const PROVIDER_NAMES: Record<CredentialId, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  assemblyai: 'AssemblyAI',
  elevenlabs: 'ElevenLabs',
};

export type KeyLookup = (id: CredentialId) => string | null;

function need(getKey: KeyLookup, id: CredentialId): string {
  const key = getKey(id);
  if (!key) throw new ConfigError(`Add your ${PROVIDER_NAMES[id]} API key in Clicky Settings.`);
  return key;
}

/** The model actually used when the setting is empty. */
export function defaultChatModel(provider: Settings['chatProvider']): string {
  return provider === 'anthropic'
    ? ANTHROPIC_DEFAULT_MODEL
    : provider === 'openrouter'
      ? OPENROUTER_DEFAULT_MODEL
      : OPENAI_DEFAULT_MODEL;
}

export function createChat(s: Settings, getKey: KeyLookup, fetchImpl?: FetchLike): VisionChatProvider {
  const model = s.chatModel || undefined;
  const extra = { ...(model ? { model } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  if (s.chatProvider === 'anthropic') return new AnthropicChat({ apiKey: need(getKey, 'anthropic'), ...extra });
  return new OpenAICompatibleChat({ id: s.chatProvider, apiKey: need(getKey, s.chatProvider), ...extra });
}

export function createStt(s: Settings, getKey: KeyLookup): SttProvider {
  if (s.sttProvider === 'model')
    throw new ConfigError('The answer model listens directly; no speech-to-text service is used.');
  if (s.sttProvider === 'assemblyai') return new AssemblyAIStt({ apiKey: need(getKey, 'assemblyai') });
  return new OpenAIStt({ apiKey: need(getKey, 'openai') });
}

/** Cloud TTS for the chosen voice, or null for the offline system voice. */
export function createTts(s: Settings, getKey: KeyLookup): TtsProvider | null {
  if (s.ttsProvider === 'system') return null;
  if (s.ttsProvider === 'elevenlabs') {
    return new ElevenLabsTts({ apiKey: need(getKey, 'elevenlabs'), ...(s.ttsVoice ? { voiceId: s.ttsVoice } : {}) });
  }
  return new OpenAITts({ apiKey: need(getKey, 'openai') });
}

/** Live check that a key works (no tokens spent). Throws a ProviderError/SDK error with the reason. */
export async function checkKey(id: CredentialId, key: string, s: Settings): Promise<void> {
  switch (id) {
    case 'anthropic':
      return checkAnthropicKey(key, s.chatProvider === 'anthropic' ? s.chatModel : undefined);
    case 'openai':
    case 'openrouter':
      return checkOpenAICompatibleKey(id, key);
    case 'assemblyai':
      return checkAssemblyAIKey(key);
    case 'elevenlabs':
      return checkElevenLabsKey(key);
  }
}
