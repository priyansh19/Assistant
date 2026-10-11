import {
  pcmToWav,
  type SttProvider,
  type SttSession,
  type TtsAudioChunk,
  type TtsProvider,
  type TtsSession,
} from '@clicky/core';
import { bodyChunks, ensureOk, prewarmOrigin, type FetchLike } from './http.js';
import { OPENAI_BASE } from './openai-compatible.js';
import { sentenceQueueSession } from './tts-queue.js';

export { pcmToWav };

/** OpenAI transcription: records while the key is held, uploads once at key-up. */
export class OpenAIStt implements SttProvider {
  readonly id = 'openai-stt';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: { apiKey: string; model?: string; fetch?: FetchLike }) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  async start({ sampleRate, signal }: { sampleRate: 16000; signal: AbortSignal }): Promise<SttSession> {
    void prewarmOrigin(this.fetchImpl, `${OPENAI_BASE}/models`, signal);
    const frames: Int16Array[] = [];
    let total = 0;
    return {
      pushAudio(frame) {
        frames.push(frame);
        total += frame.length;
      },
      finish: async () => {
        if (total < sampleRate * 0.2) return ''; // under 200 ms: nothing to transcribe
        const all = new Int16Array(total);
        let o = 0;
        for (const f of frames) {
          all.set(f, o);
          o += f.length;
        }
        const form = new FormData();
        form.append('model', this.opts.model ?? 'gpt-4o-mini-transcribe');
        form.append('response_format', 'json');
        form.append('file', new Blob([pcmToWav(all, sampleRate)], { type: 'audio/wav' }), 'audio.wav');
        const res = await ensureOk(
          'OpenAI',
          await this.fetchImpl(`${OPENAI_BASE}/audio/transcriptions`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.opts.apiKey}` },
            body: form,
            signal,
          }),
        );
        const json = (await res.json()) as { text?: string };
        return json.text ?? '';
      },
      close() {
        frames.length = 0;
      },
    };
  }
}

/** OpenAI speech: one streaming request per sentence, raw 24 kHz PCM. */
export class OpenAITts implements TtsProvider {
  readonly id = 'openai-tts';
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: { apiKey: string; voice?: string; model?: string; fetch?: FetchLike }) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  prewarm(signal: AbortSignal): Promise<void> {
    return prewarmOrigin(this.fetchImpl, `${OPENAI_BASE}/models`, signal);
  }

  async start({ signal }: { signal: AbortSignal }): Promise<TtsSession> {
    return sentenceQueueSession(
      signal,
      async function* (this: OpenAITts, text: string): AsyncGenerator<TtsAudioChunk> {
        const res = await ensureOk(
          'OpenAI',
          await this.fetchImpl(`${OPENAI_BASE}/audio/speech`, {
            method: 'POST',
            headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: this.opts.model ?? 'gpt-4o-mini-tts',
              voice: this.opts.voice || 'alloy',
              input: text,
              response_format: 'pcm',
            }),
            signal,
          }),
        );
        if (!res.body) throw new Error('OpenAI: empty audio response');
        for await (const data of bodyChunks(res.body)) yield { data, format: 'pcm_24000' };
      }.bind(this),
    );
  }
}
