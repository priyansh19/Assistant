import Anthropic from '@anthropic-ai/sdk';
import {
  ConfigError,
  StageError,
  type CachePrefix,
  type VisionChatProvider,
  type VisionChatRequest,
} from '@clicky/core';
import { prewarmOrigin, ProviderError, toBase64, type FetchLike } from './http.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/** Models that accept the `effort` setting. */
const EFFORT_MODELS = /^claude-(opus-4-[5-9]|opus-5|sonnet-5|haiku-5|fable-5|mythos-5)/;
/** Models that accept `fallbacks: "default"` on refusals. */
const FALLBACK_MODELS = /^claude-(opus-5|opus-5-5|fable-5|fable-5-1|sonnet-5-5)$/;

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  /** For tests. */
  fetch?: FetchLike;
  baseURL?: string;
}

export class AnthropicChat implements VisionChatProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model?.trim() || ANTHROPIC_DEFAULT_MODEL;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: 1,
      ...(opts.fetch ? { fetch: opts.fetch as unknown as typeof fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  prewarm(signal: AbortSignal): Promise<void> {
    return prewarmOrigin(this.fetchImpl, 'https://api.anthropic.com/', signal);
  }

  /** The prompt up to and including the screenshots; identical for the warm-up and the question. */
  private prefix(p: CachePrefix, cacheImages: boolean) {
    const messages: Anthropic.Beta.BetaMessageParam[] = p.history.map((t) => ({ role: t.role, content: t.text }));
    const images = p.images.map((img, i): Anthropic.Beta.BetaImageBlockParam => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: toBase64(img.data) },
      // Breakpoint on the last screenshot: everything up to here is read from the cache.
      ...(cacheImages && i === p.images.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    return {
      model: this.model,
      // The system prompt is identical across questions, so caching it saves time on every request.
      system: [{ type: 'text' as const, text: p.system, cache_control: { type: 'ephemeral' as const } }],
      messages,
      images,
      // Short spoken answers: lowest effort keeps time-to-first-token down. Effort is part of the
      // cached prompt, so the warm-up sends the same value.
      ...(EFFORT_MODELS.test(this.model) ? { output_config: { effort: 'low' as const } } : {}),
    };
  }

  /**
   * Write the system prompt, context and screenshots to the prompt cache while the user is still
   * talking. max_tokens 0 runs prefill only: no output, billed as a cache write.
   */
  async warmCache(p: CachePrefix): Promise<void> {
    if (!p.images.length) return;
    const { images, messages, ...rest } = this.prefix(p, true);
    try {
      await this.client.beta.messages.create(
        {
          ...rest,
          max_tokens: 0,
          // Read during prefill, never answered; it sits after the breakpoint so it isn't cached.
          messages: [...messages, { role: 'user', content: [...images, { type: 'text', text: 'warmup' }] }],
        },
        { signal: p.signal },
      );
    } catch (e) {
      if (e instanceof Anthropic.APIError && typeof e.status === 'number')
        throw new ProviderError('anthropic', e.status, e.message);
      throw e;
    }
  }

  async *stream(req: VisionChatRequest): AsyncIterable<string> {
    if (req.audio)
      throw new ConfigError(
        "Claude can't listen to audio directly. In Clicky > AI and voice, choose a speech-to-text service.",
      );
    const { images, messages, ...rest } = this.prefix(req, req.cache ?? false);
    messages.push({ role: 'user', content: [...images, { type: 'text', text: req.question }] });
    const useFallbacks = FALLBACK_MODELS.test(this.model);
    const stream = this.client.beta.messages.stream(
      {
        ...rest,
        max_tokens: req.maxTokens,
        messages,
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal: req.signal },
    );
    let final: Anthropic.Beta.BetaMessage;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
      }
      final = await stream.finalMessage();
    } catch (e) {
      // SDK errors carry the HTTP status; tag them with the provider so the user sees who failed.
      if (e instanceof Anthropic.APIError && typeof e.status === 'number')
        throw new ProviderError('anthropic', e.status, e.message);
      throw e;
    }
    if (final.stop_reason === 'refusal')
      throw new StageError('answer', 'refused', 'The AI declined to answer this question.', { provider: 'anthropic' });
    // No stop reason means the stream ended without message_stop: the answer was cut off.
    if (final.stop_reason === null)
      throw new StageError('answer', 'bad-output', 'the answer was cut off (connection closed early)', {
        provider: 'anthropic',
      });
  }
}

/** Cheap key check: retrieving model metadata costs no tokens. */
export async function checkAnthropicKey(apiKey: string, model?: string, fetchImpl?: FetchLike): Promise<void> {
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl as unknown as typeof fetch } : {}),
  });
  await client.models.retrieve(model?.trim() || ANTHROPIC_DEFAULT_MODEL);
}
