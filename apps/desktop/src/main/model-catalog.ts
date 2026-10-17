import { net } from 'electron';
import type { ModelOption } from '../shared/ipc';
import { log } from './log';

/** Models installed in Ollama on this PC (names), or empty if Ollama isn't running. */
export async function ollamaModels(url: string): Promise<string[]> {
  try {
    const res = await net.fetch(`${url}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/** Open-weight model families, for the "Open-source" group. */
const OPEN =
  /^(meta-llama|qwen|mistralai|google\/gemma|deepseek|~deepseek|nvidia|microsoft|z-ai|moonshotai|inclusionai|allenai|thudm|baidu|tencent|nousresearch|01-ai|ibm-granite|arcee-ai|bytedance)/i;
const TTL_MS = 60 * 60_000;
let cache: { at: number; list: ModelOption[] } | null = null;

/** Rough cost of one answer with a screenshot: ~2,000 tokens in, ~120 out. */
function perThousandAnswers(prompt: number, completion: number): number {
  return (prompt * 2000 + completion * 120) * 1000;
}

/**
 * OpenRouter's live model list, reduced to models that can see a screenshot, cheapest first. Used
 * for the model picker; no key needed.
 */
export async function openRouterModels(): Promise<ModelOption[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  try {
    const res = await net.fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{
        id: string;
        name?: string;
        pricing?: { prompt?: string; completion?: string };
        architecture?: { input_modalities?: string[] };
      }>;
    };
    const list = data.data
      .filter((m) => (m.architecture?.input_modalities ?? []).includes('image') && !m.id.endsWith(':batch'))
      .map((m) => {
        const prompt = Number(m.pricing?.prompt ?? 0);
        const completion = Number(m.pricing?.completion ?? 0);
        return {
          id: m.id,
          name: (m.name ?? m.id).replace(/\s*\(free\)$/i, ''),
          free: m.id.endsWith(':free') || (prompt === 0 && completion === 0),
          openSource: OPEN.test(m.id),
          per1000: perThousandAnswers(prompt, completion),
        };
      })
      .filter((m) => Number.isFinite(m.per1000) && m.per1000 >= 0)
      .sort((a, b) => a.per1000 - b.per1000);
    cache = { at: Date.now(), list };
    return list;
  } catch (e) {
    log.warn('could not load the OpenRouter model list', String(e));
    return cache?.list ?? [];
  }
}
