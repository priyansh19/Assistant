import type { TtsAudioChunk, TtsProvider, TtsSession } from '@clicky/core';
import { bodyChunks, ensureOk, prewarmOrigin, type FetchLike } from './http.js';
import { sentenceQueueSession } from './tts-queue.js';

const BASE = 'https://api.elevenlabs.io/v1';
/** "Rachel", one of ElevenLabs' default voices available to every account. */
export const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
/** Flash is ElevenLabs' lowest-latency model. */
export const ELEVENLABS_MODEL = 'eleven_flash_v2_5';

/**
 * ElevenLabs streaming TTS, one HTTP stream per sentence (raw 24 kHz PCM, so playback can start on
 * the first bytes). Deviation from plan §3.3: the plan named the WebSocket input-streaming API;
 * per-sentence HTTP streaming gets first audio after the first sentence too, and is simpler to make
 * robust. Revisit with `pnpm bench` once real keys are available.
 */
export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: { apiKey: string; voiceId?: string; fetch?: FetchLike }) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  prewarm(signal: AbortSignal): Promise<void> {
    return prewarmOrigin(this.fetchImpl, `${BASE}/models`, signal);
  }

  async start({ signal }: { signal: AbortSignal }): Promise<TtsSession> {
    const voice = this.opts.voiceId?.trim() || ELEVENLABS_DEFAULT_VOICE;
    const synth = async function* (this: ElevenLabsTts, text: string): AsyncGenerator<TtsAudioChunk> {
      const res = await ensureOk(
        'ElevenLabs',
        await this.fetchImpl(
          `${BASE}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000&optimize_streaming_latency=3`,
          {
            method: 'POST',
            headers: { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json', accept: 'audio/pcm' },
            body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
            signal,
          },
        ),
      );
      if (!res.body) return;
      for await (const data of bodyChunks(res.body)) yield { data, format: 'pcm_24000' };
    }.bind(this);
    return sentenceQueueSession(signal, synth);
  }
}

export async function checkElevenLabsKey(apiKey: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<void> {
  await ensureOk('ElevenLabs', await fetchImpl(`${BASE}/voices?page_size=1`, { headers: { 'xi-api-key': apiKey } }));
}
