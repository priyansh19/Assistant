import type { VisionChatProvider, VisionChatRequest } from '@clicky/core';
import { ensureOk, prewarmOrigin, sseData, toBase64, type FetchLike } from './http.js';

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
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-opus-5-5';

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string };
}

/** OpenAI Chat Completions streaming, used for OpenAI and OpenRouter. */
export class OpenAICompatibleChat implements VisionChatProvider {
  readonly id: string;
  private readonly base: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.base = opts.id === 'openrouter' ? OPENROUTER_BASE : OPENAI_BASE;
    this.model = opts.model?.trim() || (opts.id === 'openrouter' ? OPENROUTER_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL);
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
    const body = {
      model: this.model,
      stream: true,
      max_tokens: req.maxTokens,
      messages: [
        { role: 'system', content: req.system },
        ...req.history.map((t) => ({ role: t.role, content: t.text })),
        {
          role: 'user',
          content: [
            { type: 'text', text: req.question },
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
    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') return;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
      } catch {
        continue; // keep-alive or vendor comment
      }
      if (chunk.error) throw new Error(`${this.id}: ${chunk.error.message ?? 'stream error'}`);
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
  }
}

export async function checkOpenAICompatibleKey(
  id: 'openai' | 'openrouter',
  apiKey: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
): Promise<void> {
  // OpenRouter's /models is public, so use the key-specific endpoint there.
  const url = id === 'openrouter' ? `${OPENROUTER_BASE}/key` : `${OPENAI_BASE}/models`;
  await ensureOk(id, await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` } }));
}
