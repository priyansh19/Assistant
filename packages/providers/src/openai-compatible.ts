import type { VisionChatProvider, VisionChatRequest } from '@clicky/core';
import { ensureOk, prewarmOrigin, ProviderError, sseData, toBase64, type FetchLike } from './http.js';

export interface OpenAICompatibleOptions {
  /** 'openai' or 'openrouter' (used in errors and defaults). */
  id: 'openai' | 'openrouter';
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}

export const OPENAI_BASE = 'https://api.openai.com/v1';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini';
/**
 * OpenRouter defaults are free models (owner's rule, 2026-10-11): a fast vision model for answers,
 * writing and agent steps. Free models are rate-limited, so requests list other free vision models
 * as fallbacks and OpenRouter moves to the next one when a model is busy. Paid models are used only
 * when the user types one into the model setting.
 */
export const OPENROUTER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it:free';
export const OPENROUTER_FREE_FALLBACKS = [
  'google/gemma-4-31b-it:free',
  'thinkingmachines/inkling-small:free',
  'dots-studio/dots-3-note-preview:free',
];
/** Free models that also accept audio, for "the answer model listens" mode. */
export const OPENROUTER_FREE_LISTEN_MODELS = ['thinkingmachines/inkling-small:free', 'thinkingmachines/inkling:free'];

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string };
}

/** OpenAI Chat Completions streaming, used for OpenAI and OpenRouter. */
export class OpenAICompatibleChat implements VisionChatProvider {
  readonly id: string;
  private readonly base: string;
  readonly model: string;
  /** No model chosen in settings: use the free defaults with fallbacks. */
  private readonly freeDefaults: boolean;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.base = opts.id === 'openrouter' ? OPENROUTER_BASE : OPENAI_BASE;
    this.model = opts.model?.trim() || (opts.id === 'openrouter' ? OPENROUTER_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL);
    this.freeDefaults = opts.id === 'openrouter' && !opts.model?.trim();
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.apiKey}`,
      'content-type': 'application/json',
      ...(this.opts.id === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/priyansh19/Assistant', 'X-Title': 'Clicky' }
        : {}),
    };
  }

  prewarm(signal: AbortSignal): Promise<void> {
    return prewarmOrigin(this.fetchImpl, `${this.base}/models`, signal);
  }

  async *stream(req: VisionChatRequest): AsyncIterable<string> {
    const free = this.freeDefaults
      ? req.audio
        ? OPENROUTER_FREE_LISTEN_MODELS
        : [OPENROUTER_DEFAULT_MODEL, ...OPENROUTER_FREE_FALLBACKS]
      : null;
    const body = {
      model: free?.[0] ?? this.model,
      ...(free ? { models: free } : {}),
      stream: true,
      // OpenAI's newer models only accept max_completion_tokens; OpenRouter uses max_tokens.
      ...(this.id === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      messages: [
        { role: 'system', content: req.system },
        ...req.history.map((t) => ({ role: t.role, content: t.text })),
        {
          role: 'user',
          content: [
            { type: 'text', text: req.question },
            ...(req.audio
              ? [{ type: 'input_audio', input_audio: { data: toBase64(req.audio.data), format: req.audio.format } }]
              : []),
            ...req.images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mediaType};base64,${toBase64(img.data)}`, detail: 'high' },
            })),
          ],
        },
      ],
    };
    const res = await ensureOk(
      this.id,
      await this.fetchImpl(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      }),
    );
    if (!res.body) throw new Error(`${this.id}: empty response`);
    let finished = false;
    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
      } catch {
        continue; // keep-alive or vendor comment
      }
      if (chunk.error) throw new Error(`${this.id}: ${chunk.error.message ?? 'stream error'}`);
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason === 'error') throw new Error(`${this.id}: the model stopped with an error`);
      if (choice?.finish_reason) finished = true;
      const text = choice?.delta?.content;
      if (text) yield text;
    }
    // The connection ended without [DONE] or a finish reason: the answer was cut off.
    if (!finished) throw new Error(`${this.id}: the answer was cut off (connection closed early)`);
  }
}

export async function checkOpenAICompatibleKey(
  id: 'openai' | 'openrouter',
  apiKey: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<void> {
  // OpenRouter's /models is public, so use the key-specific endpoint there.
  const url = id === 'openrouter' ? `${OPENROUTER_BASE}/key` : `${OPENAI_BASE}/models`;
  const res = await ensureOk(id, await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` } }));
  if (id === 'openrouter') {
    // Management/provisioning keys pass /key but can't run models ("401 User not found" on chat).
    const info = (await res.json().catch(() => ({}))) as {
      data?: { is_management_key?: boolean; is_provisioning_key?: boolean };
    };
    if (info.data?.is_management_key || info.data?.is_provisioning_key) {
      throw new ProviderError(
        'openrouter',
        403,
        'management key: this is a management (provisioning) key, which cannot run models. Create a normal API key at openrouter.ai/keys.',
      );
    }
  }
}
