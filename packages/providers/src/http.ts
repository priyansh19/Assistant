/** Small HTTP helpers shared by the provider clients. Runtime: Node 22+/Electron main (global fetch). */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(status ? `${provider} ${status}: ${message}` : `${provider}: ${message}`);
  }
}

/** Throw a ProviderError with the API's own error text for a non-2xx response. */
export async function ensureOk(provider: string, res: Response): Promise<Response> {
  if (res.ok) return res;
  let detail = res.statusText;
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; detail?: unknown; message?: string };
      const e = j.error;
      detail =
        (typeof e === 'string' ? e : e?.message) ?? j.message ?? (typeof j.detail === 'string' ? j.detail : '') ?? text;
      if (!detail) detail = text.slice(0, 300);
    } catch {
      detail = text.slice(0, 300) || res.statusText;
    }
  } catch {
    // body unreadable; keep statusText
  }
  throw new ProviderError(provider, res.status, detail);
}

/** Parse a Server-Sent Events body into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
        // comments (":") and other fields (event:, id:) are ignored
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length) yield data.join('\n');
  } finally {
    reader.releaseLock();
  }
}

/** Read a streaming binary body as chunks. */
export async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value && value.byteLength) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function toBase64(data: Uint8Array): string {
  // Buffer exists in Node/Electron main; fall back to btoa elsewhere.
  const B = (globalThis as { Buffer?: { from(d: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(data).toString('base64');
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const B = (globalThis as { Buffer?: { from(d: string, enc: string): Uint8Array } }).Buffer;
  if (B) return new Uint8Array(B.from(b64, 'base64'));
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Fire a cheap request so DNS + TLS are warm before the real one. Errors are ignored. */
export function prewarmOrigin(fetchImpl: FetchLike, url: string, signal: AbortSignal): Promise<void> {
  return fetchImpl(url, { method: 'HEAD', signal })
    .then((r) => void r.body?.cancel().catch(() => undefined))
    .catch(() => undefined);
}
