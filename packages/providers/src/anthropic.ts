import Anthropic from '@anthropic-ai/sdk';
import type { VisionChatProvider, VisionChatRequest } from '@clicky/core';
import { prewarmOrigin, toBase64, type FetchLike } from './http.js';

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
  private readonly model: string;
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

  async *stream(req: VisionChatRequest): AsyncIterable<string> {
    const messages: Anthropic.Beta.BetaMessageParam[] = req.history.map((t) => ({ role: t.role, content: t.text }));
    messages.push({
      role: 'user',
      content: [
        ...req.images.map((img): Anthropic.Beta.BetaImageBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: toBase64(img.data) },
        })),
        { type: 'text', text: req.question },
      ],
    });
    const useFallbacks = FALLBACK_MODELS.test(this.model);
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        // The system prompt is identical across questions, so caching it saves time on every request.
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages,
        // Short spoken answers: lowest effort keeps time-to-first-token down.
        ...(EFFORT_MODELS.test(this.model) ? { output_config: { effort: 'low' as const } } : {}),
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal: req.signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new Error('The AI declined to answer this question.');
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
