import type { TtsAudioChunk, TtsProvider, TtsSession } from '@clicky/core';
import type { WebSocketCtor, WebSocketLike } from './assemblyai.js';
import { bodyChunks, ensureOk, fromBase64, prewarmOrigin, ProviderError, type FetchLike } from './http.js';
import { sentenceQueueSession } from './tts-queue.js';

const BASE = 'https://api.elevenlabs.io/v1';
/** "Rachel", one of ElevenLabs' default voices available to every account. */
export const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
/** Flash is ElevenLabs' lowest-latency model. */
export const ELEVENLABS_MODEL = 'eleven_flash_v2_5';

const WS_BASE = 'wss://api.elevenlabs.io/v1';
/** The server closes an idle input stream after this many seconds (its maximum). */
const WS_INACTIVITY_S = 180;
/** A socket opened at key-down is reused only while younger than this. */
const SPARE_MAX_AGE_MS = 150_000;

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId?: string;
  fetch?: FetchLike;
  /** One WebSocket input stream per answer, opened at key-down (default). False: one HTTP stream per sentence. */
  streaming?: boolean;
  WebSocket?: WebSocketCtor;
}

interface OpenSocket {
  ws: WebSocketLike;
  openedAt: number;
  /** Set once the server closes it or it errors; a closed spare is never handed out. */
  closed: boolean;
  /** Messages that arrived before a session took the socket (none expected before text is sent). */
  onMessage: ((data: unknown) => void) | null;
  onClose: ((code?: number, reason?: string) => void) | null;
}

/**
 * ElevenLabs streaming TTS (Flash, raw 24 kHz PCM so playback starts on the first bytes).
 *
 * Default: the WebSocket input-streaming API (plan §3.3, architecture §7). The socket is opened
 * and authenticated at key-down (prewarm), so when the first clause of the answer is ready it goes
 * straight in and audio comes back on the same connection; later sentences follow without a new
 * request each. If the socket can't be opened, or `streaming` is off, each sentence is its own HTTP
 * stream (the earlier approach, still the fallback).
 */
export class ElevenLabsTts implements TtsProvider {
  readonly id = 'elevenlabs';
  private readonly fetchImpl: FetchLike;
  private readonly WS: WebSocketCtor | null;
  private spare: Promise<OpenSocket | null> | null = null;

  constructor(private readonly opts: ElevenLabsOptions) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    this.WS = opts.streaming === false ? null : (opts.WebSocket ?? g ?? null);
  }

  private get voice(): string {
    return this.opts.voiceId?.trim() || ELEVENLABS_DEFAULT_VOICE;
  }

  prewarm(signal: AbortSignal): Promise<void> {
    if (this.WS) {
      // Key-down: open and authenticate the answer's socket now, while the user is still talking.
      if (!this.spare) {
        const spare = this.openSocket().catch(() => null);
        this.spare = spare;
        signal.addEventListener(
          'abort',
          () => {
            if (this.spare !== spare) return;
            this.spare = null;
            void spare.then((s) => s?.ws.close());
          },
          { once: true },
        );
      }
      return this.spare.then(() => undefined);
    }
    return prewarmOrigin(this.fetchImpl, `${BASE}/models`, signal);
  }

  /** Open an input stream and send the initial message with the key (never in the URL). */
  private openSocket(): Promise<OpenSocket> {
    const WS = this.WS;
    if (!WS) return Promise.reject(new Error('WebSocket is not available'));
    const url =
      `${WS_BASE}/text-to-speech/${encodeURIComponent(this.voice)}/stream-input` +
      `?model_id=${ELEVENLABS_MODEL}&output_format=pcm_24000&auto_mode=true&inactivity_timeout=${WS_INACTIVITY_S}`;
    const ws = new WS(url);
    const sock: OpenSocket = { ws, openedAt: Date.now(), closed: false, onMessage: null, onClose: null };
    return new Promise<OpenSocket>((resolve, reject) => {
      let open = false;
      ws.onopen = () => {
        open = true;
        // The first message must be a single space; it carries the key and voice settings.
        ws.send(JSON.stringify({ text: ' ', xi_api_key: this.opts.apiKey }));
        resolve(sock);
      };
      ws.onerror = () => {
        sock.closed = true;
        if (!open) reject(new Error('ElevenLabs: could not open the voice stream'));
      };
      ws.onclose = (ev) => {
        sock.closed = true;
        if (!open) reject(new Error(`ElevenLabs: voice stream closed (${ev.code ?? ''} ${ev.reason ?? ''})`.trim()));
        sock.onClose?.(ev.code, ev.reason);
      };
      ws.onmessage = (ev) => sock.onMessage?.(ev.data);
    });
  }

  private async takeSocket(): Promise<OpenSocket | null> {
    const spare = this.spare;
    this.spare = null;
    const s = spare ? await spare : null;
    if (s && !s.closed && Date.now() - s.openedAt < SPARE_MAX_AGE_MS) return s;
    s?.ws.close();
    return this.openSocket().catch(() => null);
  }

  async start({ signal }: { signal: AbortSignal }): Promise<TtsSession> {
    if (this.WS) {
      const sock = await this.takeSocket();
      if (signal.aborted) {
        sock?.ws.close();
        throw new Error('aborted');
      }
      if (sock) return socketSession(sock, signal);
      // The socket couldn't be opened: fall back to one HTTP stream per sentence.
    }
    return this.httpSession(signal);
  }

  private httpSession(signal: AbortSignal): TtsSession {
    const voice = this.voice;
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
      if (!res.body) throw new Error('ElevenLabs: empty audio response');
      for await (const data of bodyChunks(res.body)) yield { data, format: 'pcm_24000' };
    }.bind(this);
    return sentenceQueueSession(signal, synth);
  }
}

/** Server messages on the input stream: audio chunks, the final marker, or an error. */
interface StreamMessage {
  audio?: string | null;
  isFinal?: boolean | null;
  error?: string;
  message?: string;
}

/** One answer on an open input stream: text in as it's chunked, audio out in order. */
function socketSession(sock: OpenSocket, signal: AbortSignal): TtsSession {
  const { ws } = sock;
  const queue: TtsAudioChunk[] = [];
  let finished = false;
  let failure: Error | null = null;
  let closedByUs = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  const close = (): void => {
    if (closedByUs) return;
    closedByUs = true;
    finished = true;
    ws.close();
    notify();
  };
  signal.addEventListener('abort', close, { once: true });

  sock.onMessage = (data) => {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(
        typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer),
      ) as StreamMessage;
    } catch {
      return;
    }
    if (msg.audio) queue.push({ data: fromBase64(msg.audio), format: 'pcm_24000' });
    if (msg.isFinal) finished = true;
    if (!msg.audio && !msg.isFinal && (msg.error || msg.message)) {
      failure = new ProviderError('elevenlabs', 0, String(msg.message ?? msg.error));
      finished = true;
    }
    notify();
  };
  sock.onClose = (code, reason) => {
    if (!finished && !closedByUs) {
      // 1008 is a policy close: bad key, quota or voice. Anything else mid-answer is a dropped connection.
      failure =
        code === 1008
          ? new ProviderError('elevenlabs', 401, reason || 'the voice service refused the request')
          : new Error(`ElevenLabs: voice stream closed early (${code ?? ''} ${reason ?? ''})`.trim());
    }
    finished = true;
    notify();
  };
  if (sock.closed) {
    failure = new Error('ElevenLabs: voice stream closed before the answer');
    finished = true;
  }

  return {
    pushText(text) {
      if (closedByUs || sock.closed || !text.trim()) return;
      // Each chunk is a whole clause or sentence: generate it now rather than waiting for more text.
      ws.send(JSON.stringify({ text: `${text.trim()} `, flush: true }));
    },
    end() {
      if (closedByUs || sock.closed) return;
      ws.send(JSON.stringify({ text: '' }));
    },
    async *audio() {
      for (;;) {
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        if (failure) throw failure;
        if (finished || signal.aborted) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
    close,
  };
}

export async function checkElevenLabsKey(apiKey: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<void> {
  await ensureOk('ElevenLabs', await fetchImpl(`${BASE}/voices?page_size=1`, { headers: { 'xi-api-key': apiKey } }));
}
