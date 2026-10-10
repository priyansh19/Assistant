import type { SttProvider, SttSession } from '@clicky/core';
import { ensureOk, type FetchLike } from './http.js';

/**
 * AssemblyAI Universal Streaming (v3). The connection opens at key-down with a short-lived token,
 * audio streams while the key is held, and at key-up we send ForceEndpoint so the final transcript
 * arrives without waiting for silence detection (plan §3.3 step 3).
 */

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export interface AssemblyAIOptions {
  apiKey: string;
  fetch?: FetchLike;
  WebSocket?: WebSocketCtor;
  /** Wait this long after ForceEndpoint for the final turn. */
  finalizeTimeoutMs?: number;
}

const TOKEN_TTL_S = 600;
const TOKEN_URL = `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${TOKEN_TTL_S}`;
const KEY_CHECK_URL = 'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60';

/**
 * One spare single-use streaming token per API key, fetched ahead of time so key-down only has to
 * open the WebSocket (the token round trip used to sit on the key-up → first audio path for short
 * questions).
 */
const spareTokens = new Map<string, { token: Promise<string>; expiresAt: number }>();

function fetchToken(fetchImpl: FetchLike, apiKey: string, signal?: AbortSignal): Promise<string> {
  return fetchImpl(TOKEN_URL, { headers: { authorization: apiKey }, ...(signal ? { signal } : {}) })
    .then((r) => ensureOk('AssemblyAI', r))
    .then((r) => r.json() as Promise<{ token?: string }>)
    .then((j) => {
      if (!j.token) throw new Error('AssemblyAI: no streaming token returned');
      return j.token;
    });
}

function prefetchToken(fetchImpl: FetchLike, apiKey: string): void {
  const token = fetchToken(fetchImpl, apiKey);
  token.catch(() => spareTokens.delete(apiKey));
  spareTokens.set(apiKey, { token, expiresAt: Date.now() + (TOKEN_TTL_S - 60) * 1000 });
}

async function takeToken(fetchImpl: FetchLike, apiKey: string, signal: AbortSignal): Promise<string> {
  const spare = spareTokens.get(apiKey);
  spareTokens.delete(apiKey);
  let token: string | null = null;
  if (spare && spare.expiresAt > Date.now()) token = await spare.token.catch(() => null);
  token ??= await fetchToken(fetchImpl, apiKey, signal);
  prefetchToken(fetchImpl, apiKey); // keep one ready for the next question
  return token;
}
const WS_URL = 'wss://streaming.assemblyai.com/v3/ws';
/** AssemblyAI wants 50–1000 ms per message; 16 kHz × 0.1 s = 1600 samples. */
const SEND_SAMPLES = 1600;

interface TurnMessage {
  type: 'Turn';
  transcript: string;
  end_of_turn: boolean;
  turn_order?: number;
}

export class AssemblyAIStt implements SttProvider {
  readonly id = 'assemblyai';
  private readonly fetchImpl: FetchLike;
  private readonly WS: WebSocketCtor;

  constructor(private readonly opts: AssemblyAIOptions) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    const ws = opts.WebSocket ?? g;
    if (!ws) throw new Error('WebSocket is not available in this runtime');
    this.WS = ws;
  }

  /** Fetch a spare streaming token so the next key press skips that round trip. */
  prewarm(): void {
    const spare = spareTokens.get(this.opts.apiKey);
    if (!spare || spare.expiresAt <= Date.now()) prefetchToken(this.fetchImpl, this.opts.apiKey);
  }

  async start({ sampleRate, signal }: { sampleRate: 16000; signal: AbortSignal }): Promise<SttSession> {
    const token = await takeToken(this.fetchImpl, this.opts.apiKey, signal);
    if (signal.aborted) throw new Error('aborted');

    const url = `${WS_URL}?sample_rate=${sampleRate}&encoding=pcm_s16le&format_turns=false&token=${encodeURIComponent(token)}`;
    const ws = new this.WS(url);
    ws.binaryType = 'arraybuffer';

    // Completed turns by order, plus the latest partial; the transcript is all of them joined.
    const turns = new Map<number, string>();
    let partial = '';
    let partialOrder = -1;
    let closed = false;
    let failure: Error | null = null;
    const waiters: Array<() => void> = [];
    const wake = (): void => {
      for (const w of waiters.splice(0)) w();
    };
    const partialListeners: Array<(t: string) => void> = [];

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        ws.close();
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      ws.onopen = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      ws.onerror = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('AssemblyAI: could not connect to streaming speech recognition'));
      };
      ws.onclose = (ev) => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`AssemblyAI: connection closed (${ev.code ?? ''} ${ev.reason ?? ''})`.trim()));
      };
    });

    let sawFinalAfterForce = false;
    let forced = false;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: { type?: string; error?: string } & Partial<TurnMessage>;
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'Turn') {
        const order = msg.turn_order ?? 0;
        if (msg.end_of_turn) {
          turns.set(order, msg.transcript ?? '');
          if (partialOrder === order) partial = '';
          if (forced) sawFinalAfterForce = true;
        } else {
          partial = msg.transcript ?? '';
          partialOrder = order;
        }
        const text = transcript();
        for (const fn of partialListeners) fn(text);
        wake();
      } else if (msg.type === 'Termination') {
        closed = true;
        wake();
      } else if (msg.error) {
        failure = new Error(`AssemblyAI: ${msg.error}`);
        wake();
      }
    };
    ws.onerror = () => {
      failure ??= new Error('AssemblyAI: connection error');
      wake();
    };
    ws.onclose = (ev) => {
      closed = true;
      if (ev.code && ev.code !== 1000 && ev.code !== 1005)
        failure ??= new Error(`AssemblyAI: closed (${ev.code} ${ev.reason ?? ''})`.trim());
      wake();
    };

    const transcript = (): string =>
      [...[...turns.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t), partial]
        .map((t) => t.trim())
        .filter(Boolean)
        .join(' ');

    let pending = new Int16Array(0);
    const flush = (all: boolean): void => {
      while (pending.length >= SEND_SAMPLES || (all && pending.length > 0)) {
        const n = Math.min(SEND_SAMPLES, pending.length);
        // Pad a short final chunk to the 50 ms minimum.
        const out = new Int16Array(Math.max(n, 800));
        out.set(pending.subarray(0, n));
        pending = pending.slice(n);
        if (ws.readyState === 1) ws.send(out.buffer);
      }
    };

    const finalizeTimeout = this.opts.finalizeTimeoutMs ?? 2500;
    signal.addEventListener('abort', () => ws.close(), { once: true });

    return {
      pushAudio(frame) {
        if (closed) return;
        const merged = new Int16Array(pending.length + frame.length);
        merged.set(pending);
        merged.set(frame, pending.length);
        pending = merged;
        flush(false);
      },
      onPartial(fn) {
        partialListeners.push(fn);
      },
      async finish() {
        if (failure) throw failure;
        flush(true);
        if (ws.readyState === 1) {
          forced = true;
          ws.send(JSON.stringify({ type: 'ForceEndpoint' }));
        }
        const started = Date.now();
        // Done when the forced turn ends. If nothing is in progress there's no turn to wait for:
        // give in-flight audio a short grace period, or a little longer if nothing was heard yet.
        while (!sawFinalAfterForce && !closed && !failure) {
          const elapsed = Date.now() - started;
          if (elapsed > finalizeTimeout) break;
          if (partial === '' && turns.size > 0 && elapsed > 300) break;
          if (partial === '' && turns.size === 0 && elapsed > 1200) break;
          await new Promise<void>((r) => {
            waiters.push(r);
            setTimeout(r, 50);
          });
        }
        if (failure && !transcript()) throw failure;
        const text = transcript();
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'Terminate' }));
        return text;
      },
      close() {
        closed = true;
        try {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'Terminate' }));
          ws.close();
        } catch {
          // already closed
        }
      },
    };
  }
}

export async function checkAssemblyAIKey(apiKey: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<void> {
  await ensureOk('AssemblyAI', await fetchImpl(KEY_CHECK_URL, { headers: { authorization: apiKey } }));
}
