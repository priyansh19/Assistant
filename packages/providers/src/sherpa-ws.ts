import type { SttProvider, SttSession } from '@clicky/core';
import type { WebSocketCtor } from './assemblyai.js';

/**
 * Speech to text through a local sherpa-onnx offline WebSocket server, such as the Parakeet server
 * OpenWhispr runs on port 6006. Audio is recorded while the key is held and sent in one go at
 * key-up; on a modern laptop CPU a few seconds of speech decodes in ~0.3–0.6 s, fully offline.
 *
 * Protocol (sherpa-onnx offline-websocket-server): int32 LE sample rate, int32 LE byte length,
 * then float32 samples, in chunks; the server replies with a JSON result; the client sends "Done".
 */
export const OPENWHISPR_SHERPA_URL = 'ws://127.0.0.1:6006';

export interface SherpaWsOptions {
  url?: string;
  WebSocket?: WebSocketCtor;
  /** Give up on the server after this long at key-up. */
  timeoutMs?: number;
}

export function encodeSherpaRequest(samples: Int16Array, sampleRate: number): Uint8Array {
  const f32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) f32[i] = (samples[i] ?? 0) / 32768;
  const out = new Uint8Array(8 + f32.byteLength);
  const view = new DataView(out.buffer);
  view.setInt32(0, sampleRate, true);
  view.setInt32(4, f32.byteLength, true);
  out.set(new Uint8Array(f32.buffer), 8);
  return out;
}

export function parseSherpaResult(data: unknown): string {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
  try {
    const j = JSON.parse(text) as { text?: string };
    return (j.text ?? '').trim();
  } catch {
    return text.trim();
  }
}

export class SherpaWsStt implements SttProvider {
  readonly id = 'local-sherpa';
  private readonly url: string;
  private readonly WS: WebSocketCtor;

  constructor(opts: SherpaWsOptions = {}) {
    this.url = opts.url ?? OPENWHISPR_SHERPA_URL;
    const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    const ws = opts.WebSocket ?? g;
    if (!ws) throw new Error('WebSocket is not available in this runtime');
    this.WS = ws;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private readonly timeoutMs: number;

  async start({ sampleRate, signal }: { sampleRate: 16000; signal: AbortSignal }): Promise<SttSession> {
    const frames: Int16Array[] = [];
    let total = 0;
    return {
      pushAudio(frame) {
        frames.push(frame);
        total += frame.length;
      },
      finish: () =>
        new Promise<string>((resolve, reject) => {
          if (total < sampleRate * 0.2) return resolve('');
          const all = new Int16Array(total);
          let o = 0;
          for (const f of frames) {
            all.set(f, o);
            o += f.length;
          }
          const payload = encodeSherpaRequest(all, sampleRate);
          const ws = new this.WS(this.url);
          ws.binaryType = 'arraybuffer';
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error('Local speech recognition did not answer in time.'));
          }, this.timeoutMs);
          const onAbort = (): void => {
            clearTimeout(timer);
            ws.close();
            reject(new Error('aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          ws.onopen = () => {
            for (let i = 0; i < payload.length; i += 10240) ws.send(payload.subarray(i, i + 10240));
          };
          ws.onmessage = (ev) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            try {
              ws.send('Done');
            } catch {
              // closing anyway
            }
            ws.close();
            resolve(parseSherpaResult(ev.data));
          };
          ws.onerror = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new Error('Local speech recognition is not running (could not connect).'));
          };
        }),
      close() {
        frames.length = 0;
      },
    };
  }
}

/** Is a sherpa-onnx server answering at this URL? Resolves quickly either way. */
export function probeSherpaWs(url = OPENWHISPR_SHERPA_URL, timeoutMs = 800): Promise<boolean> {
  const g = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!g) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ws = new g(url);
    const t = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      ws.close();
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve(false);
    };
  });
}
