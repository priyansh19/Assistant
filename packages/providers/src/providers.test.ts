import { DEFAULT_SETTINGS, describeError, type TtsAudioChunk } from '@clicky/core';
import { describe, expect, it } from 'vitest';
import { AnthropicChat } from './anthropic.js';
import { AssemblyAIStt, type WebSocketLike } from './assemblyai.js';
import { ElevenLabsTts } from './elevenlabs.js';
import { ensureOk, ProviderError, sseData, type FetchLike } from './http.js';
import { createChat, createTts } from './index.js';
import { pcmToWav } from './openai-audio.js';
import { OpenAICompatibleChat } from './openai-compatible.js';
import { sentenceQueueSession } from './tts-queue.js';

function streamOf(parts: string[] | Uint8Array[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      c.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const signal = () => new AbortController().signal;
const image = { data: new Uint8Array([255, 216]), mediaType: 'image/jpeg' as const, width: 2, height: 1 };

describe('sseData', () => {
  it('handles events split across chunks and CRLF', async () => {
    const out = await collect(
      sseData(streamOf(['data: {"a"', ':1}\r\n\r\n: comment\n', 'event: x\ndata: two\n\ndata: [DONE]'])),
    );
    expect(out).toEqual(['{"a":1}', 'two', '[DONE]']);
  });
});

describe('ensureOk', () => {
  it('extracts the API error message', async () => {
    const res = new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
    await expect(ensureOk('Anthropic', res)).rejects.toThrow('Anthropic 401: invalid x-api-key');
    await expect(ensureOk('X', new Response('plain text', { status: 500 }))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('OpenAICompatibleChat', () => {
  it('streams deltas and sends the image as a data URL', async () => {
    let sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    const fetchImpl: FetchLike = async (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> };
      return new Response(
        streamOf([
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"[POINT:1,1:a]"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Hi."}}]}\n\ndata: [DONE]\n\n',
        ]),
      );
    };
    const chat = new OpenAICompatibleChat({ id: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    const out = await collect(
      chat.stream({
        system: 's',
        history: [{ role: 'user', text: 'p' }],
        question: 'q',
        images: [image],
        maxTokens: 50,
        signal: signal(),
      }),
    );
    expect(out.join('')).toBe('[POINT:1,1:a]Hi.');
    expect(sent!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent!.headers['authorization']).toBe('Bearer k');
    const msgs = sent!.body['messages'] as Array<{ role: string; content: unknown }>;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(JSON.stringify(msgs[2]?.content)).toContain('data:image/jpeg;base64,/9g=');
  });

  it('surfaces in-stream errors', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(streamOf(['data: {"error":{"message":"model not found"}}\n\n']));
    const chat = new OpenAICompatibleChat({ id: 'openai', apiKey: 'k', fetch: fetchImpl });
    await expect(
      collect(chat.stream({ system: '', history: [], question: 'q', images: [], maxTokens: 5, signal: signal() })),
    ).rejects.toThrow('model not found');
  });
});

describe('OpenAICompatibleChat completion', () => {
  it('treats a stream that ends without [DONE] as cut off', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(streamOf(['data: {"choices":[{"delta":{"content":"Half an"}}]}\n\n']));
    const chat = new OpenAICompatibleChat({ id: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    await expect(
      collect(chat.stream({ system: '', history: [], question: 'q', images: [], maxTokens: 5, signal: signal() })),
    ).rejects.toThrow(/cut off/);
  });

  it('sends the question audio as input_audio', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(streamOf(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n']));
    };
    const chat = new OpenAICompatibleChat({ id: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    await collect(
      chat.stream({
        system: '',
        history: [],
        question: 'q',
        images: [],
        audio: { data: new Uint8Array([1, 2]), format: 'wav' },
        maxTokens: 7,
        signal: signal(),
      }),
    );
    expect(JSON.stringify(body['messages'])).toContain('"input_audio":{"data":"AQI=","format":"wav"}');
  });

  it('sends max_completion_tokens to OpenAI', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(streamOf(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n']));
    };
    const chat = new OpenAICompatibleChat({ id: 'openai', apiKey: 'k', fetch: fetchImpl });
    await collect(chat.stream({ system: '', history: [], question: 'q', images: [], maxTokens: 7, signal: signal() }));
    expect(body['max_completion_tokens']).toBe(7);
    expect(body['max_tokens']).toBeUndefined();
  });
});

describe('sentenceQueueSession abort', () => {
  it('ends the audio loop when aborted with nothing in flight', async () => {
    const ac = new AbortController();
    const session = sentenceQueueSession(ac.signal, async function* () {
      yield { data: new Uint8Array([1]), format: 'pcm_24000' };
    });
    const p = collect(session.audio());
    ac.abort();
    await expect(p).resolves.toEqual([]);
  });
});

describe('AnthropicChat', () => {
  const sse = (events: Array<Record<string, unknown>>) =>
    events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`);
  const msgStart = {
    type: 'message_start',
    message: {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
  const body = (stop: string, texts: string[]) =>
    sse([
      msgStart,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...texts.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);

  it('streams text and sends image + low effort + fallbacks', async () => {
    let req: Record<string, unknown> = {};
    let headers = new Headers();
    const fetchImpl: FetchLike = async (_url, init) => {
      req = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return new Response(streamOf(body('end_turn', ['[POINT:none]', 'Hello.'])), {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const chat = new AnthropicChat({ apiKey: 'sk-ant-test', fetch: fetchImpl });
    const out = await collect(
      chat.stream({ system: 'sys', history: [], question: 'q', images: [image], maxTokens: 100, signal: signal() }),
    );
    expect(out.join('')).toBe('[POINT:none]Hello.');
    expect(req['model']).toBe('claude-opus-5-5');
    expect(req['output_config']).toEqual({ effort: 'low' });
    expect(req['fallbacks']).toBe('default');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(JSON.stringify(req['messages'])).toContain('"media_type":"image/jpeg"');
  });

  it('turns a refusal into an error', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(streamOf(body('refusal', ['I'])), { headers: { 'content-type': 'text/event-stream' } });
    const chat = new AnthropicChat({ apiKey: 'k', model: 'claude-haiku-5-5', fetch: fetchImpl });
    await expect(
      collect(chat.stream({ system: '', history: [], question: 'q', images: [], maxTokens: 10, signal: signal() })),
    ).rejects.toThrow(/declined/);
  });

  it('tags HTTP errors with the provider and status', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      );
    const chat = new AnthropicChat({ apiKey: 'k', model: 'claude-haiku-5-5', fetch: fetchImpl });
    const err: unknown = await collect(
      chat.stream({ system: '', history: [], question: 'q', images: [], maxTokens: 10, signal: signal() }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: 'anthropic', status: 401 });
    expect(describeError(err, 'answer')).toMatch(/^Your Anthropic key was rejected/);
  });

  it('warms the cache with the same prefix the cached question then sends', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(b);
      if (b['stream'])
        return new Response(streamOf(body('end_turn', ['Hi.'])), { headers: { 'content-type': 'text/event-stream' } });
      return new Response(
        JSON.stringify({
          ...msgStart.message,
          stop_reason: 'max_tokens',
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    const chat = new AnthropicChat({ apiKey: 'k', fetch: fetchImpl });
    const history = [{ role: 'user' as const, text: 'earlier' }];
    await chat.warmCache({ system: 'sys', history, images: [image, image], signal: signal() });
    await collect(
      chat.stream({
        system: 'sys',
        history,
        question: 'q',
        images: [image, image],
        maxTokens: 10,
        signal: signal(),
        cache: true,
      }),
    );
    const [warm, real] = bodies as [Record<string, unknown>, Record<string, unknown>];
    expect(warm['max_tokens']).toBe(0);
    expect(warm['stream']).toBeFalsy();
    expect(warm['output_config']).toEqual(real['output_config']);
    expect(warm['system']).toEqual(real['system']);
    type Msg = { content: string | Array<Record<string, unknown>> };
    const lastUser = (b: Record<string, unknown>) =>
      (b['messages'] as Msg[]).at(-1)?.content as Array<Record<string, unknown>>;
    // Everything up to and including the last image matches byte for byte.
    expect(lastUser(warm).slice(0, 2)).toEqual(lastUser(real).slice(0, 2));
    expect(lastUser(real)[1]?.['cache_control']).toEqual({ type: 'ephemeral' });
    expect(lastUser(real)[0]?.['cache_control']).toBeUndefined();
    expect((warm['messages'] as Msg[]).slice(0, -1)).toEqual((real['messages'] as Msg[]).slice(0, -1));
  });

  it('marks no image cacheable on an ordinary question', async () => {
    let req: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      req = JSON.parse(String(init?.body));
      return new Response(streamOf(body('end_turn', ['Hi.'])), { headers: { 'content-type': 'text/event-stream' } });
    };
    const chat = new AnthropicChat({ apiKey: 'k', fetch: fetchImpl });
    await collect(
      chat.stream({ system: 's', history: [], question: 'q', images: [image], maxTokens: 10, signal: signal() }),
    );
    expect(JSON.stringify(req['messages'])).not.toContain('cache_control');
  });
});

class FakeWS implements WebSocketLike {
  static last: FakeWS | null = null;
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(d: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(d);
    if (d === JSON.stringify({ type: 'ForceEndpoint' })) {
      setTimeout(() => this.emit({ type: 'Turn', turn_order: 1, end_of_turn: true, transcript: 'export it' }), 5);
    }
  }
  close() {
    this.readyState = 3;
  }
  emit(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

describe('AssemblyAIStt', () => {
  const tokenFetch: FetchLike = async () => new Response(JSON.stringify({ token: 'tok' }));

  it('streams audio in ≥50 ms chunks and finalises on ForceEndpoint', async () => {
    const stt = new AssemblyAIStt({ apiKey: 'k', fetch: tokenFetch, WebSocket: FakeWS });
    const session = await stt.start({ sampleRate: 16000, signal: signal() });
    const ws = FakeWS.last!;
    expect(ws.url).toContain('token=tok');
    expect(ws.url).toContain('sample_rate=16000');
    session.pushAudio(new Int16Array(1000));
    expect(ws.sent).toHaveLength(0); // waits for 100 ms of audio
    session.pushAudio(new Int16Array(1000));
    expect(ws.sent).toHaveLength(1);
    ws.emit({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'where is' });
    ws.emit({ type: 'Turn', turn_order: 1, end_of_turn: false, transcript: 'export' });
    const text = await session.finish();
    expect(text).toBe('where is export it');
    expect(ws.sent.some((d) => d === JSON.stringify({ type: 'Terminate' }))).toBe(true);
  });

  it('returns quickly with an empty transcript when nothing was said', async () => {
    class SilentWS extends FakeWS {
      override send(d: string | ArrayBufferLike | ArrayBufferView) {
        this.sent.push(d);
      }
    }
    const stt = new AssemblyAIStt({ apiKey: 'k', fetch: tokenFetch, WebSocket: SilentWS, finalizeTimeoutMs: 3000 });
    const session = await stt.start({ sampleRate: 16000, signal: signal() });
    const t0 = Date.now();
    expect(await session.finish()).toBe('');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('reports a bad key from the token endpoint', async () => {
    const bad: FetchLike = async () => new Response('{"error":"Invalid API key"}', { status: 401 });
    const stt = new AssemblyAIStt({ apiKey: 'bad-key', fetch: bad, WebSocket: FakeWS });
    await expect(stt.start({ sampleRate: 16000, signal: signal() })).rejects.toThrow('401');
  });
});

describe('sentenceQueueSession', () => {
  it('synthesises in parallel but yields in order', async () => {
    const started: string[] = [];
    const session = sentenceQueueSession(signal(), async function* (text) {
      started.push(text);
      await new Promise((r) => setTimeout(r, text === 'one' ? 20 : 1));
      yield { data: new TextEncoder().encode(text), format: 'pcm_24000' } satisfies TtsAudioChunk;
    });
    session.pushText('one');
    session.pushText('two');
    session.pushText('three');
    session.end();
    const out = (await collect(session.audio())).map((c) => new TextDecoder().decode(c.data));
    expect(out).toEqual(['one', 'two', 'three']);
    expect(started.slice(0, 2)).toEqual(['one', 'two']);
  });

  it('propagates synthesis errors', async () => {
    const session = sentenceQueueSession(signal(), async function* () {
      throw new Error('ElevenLabs 401: bad key');
    });
    session.pushText('x');
    session.end();
    await expect(collect(session.audio())).rejects.toThrow('401');
  });
});

describe('ElevenLabsTts', () => {
  it('requests low-latency PCM per sentence', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return new Response(streamOf([new Uint8Array([1, 2, 3, 4])]));
    };
    const tts = new ElevenLabsTts({ apiKey: 'k', fetch: fetchImpl, streaming: false });
    const s = await tts.start({ signal: signal() });
    s.pushText('Hello.');
    s.end();
    const chunks = await collect(s.audio());
    expect(chunks[0]?.format).toBe('pcm_24000');
    expect(urls[0]).toContain('output_format=pcm_24000');
  });

  /** ElevenLabs' input stream: audio for each flushed chunk, isFinal after the empty end message. */
  class FakeElevenWS implements WebSocketLike {
    static all: FakeElevenWS[] = [];
    static failOpen = false;
    static closeWith: { code: number; reason: string } | null = null;
    readyState = 0;
    binaryType = 'blob';
    sent: Array<Record<string, unknown>> = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
    constructor(readonly url: string) {
      FakeElevenWS.all.push(this);
      setTimeout(() => {
        if (FakeElevenWS.failOpen) {
          this.onerror?.({});
          this.onclose?.({ code: 1006 });
          return;
        }
        this.readyState = 1;
        this.onopen?.({});
      }, 1);
    }
    send(d: string | ArrayBufferLike | ArrayBufferView) {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      this.sent.push(m);
      const reply = (x: unknown) => setTimeout(() => this.onmessage?.({ data: JSON.stringify(x) }), 1);
      if (m['flush']) {
        const close = FakeElevenWS.closeWith;
        if (close) setTimeout(() => this.onclose?.(close), 1);
        else reply({ audio: Buffer.from([1, 2]).toString('base64'), isFinal: false });
      } else if (m['text'] === '') reply({ isFinal: true });
    }
    close() {
      this.readyState = 3;
    }
  }

  const reset = () => {
    FakeElevenWS.all = [];
    FakeElevenWS.failOpen = false;
    FakeElevenWS.closeWith = null;
  };

  it('opens the voice stream at key-down and reuses it for the answer', async () => {
    reset();
    const tts = new ElevenLabsTts({ apiKey: 'secret', WebSocket: FakeElevenWS, fetch: async () => new Response('') });
    const sig = signal();
    await tts.prewarm(sig);
    expect(FakeElevenWS.all).toHaveLength(1);
    const ws = FakeElevenWS.all[0]!;
    expect(ws.url).toContain('/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000');
    expect(ws.url).not.toContain('secret');
    expect(ws.sent[0]).toEqual({ text: ' ', xi_api_key: 'secret' });
    const s = await tts.start({ signal: sig });
    expect(FakeElevenWS.all).toHaveLength(1);
    s.pushText('Open the File menu,');
    s.pushText('then click Export.');
    s.end();
    const chunks = await collect(s.audio());
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ data: new Uint8Array([1, 2]), format: 'pcm_24000' });
    expect(ws.sent.slice(1)).toEqual([
      { text: 'Open the File menu, ', flush: true },
      { text: 'then click Export. ', flush: true },
      { text: '' },
    ]);
  });

  it('falls back to one HTTP stream per sentence when the socket will not open', async () => {
    reset();
    FakeElevenWS.failOpen = true;
    const urls: string[] = [];
    const tts = new ElevenLabsTts({
      apiKey: 'k',
      WebSocket: FakeElevenWS,
      fetch: async (url) => {
        urls.push(url);
        return new Response(streamOf([new Uint8Array([9, 9])]));
      },
    });
    const s = await tts.start({ signal: signal() });
    s.pushText('Hello.');
    s.end();
    expect(await collect(s.audio())).toHaveLength(1);
    expect(urls[0]).toContain('/stream?output_format=pcm_24000');
  });

  it('reports a refused voice stream as a key problem', async () => {
    reset();
    FakeElevenWS.closeWith = { code: 1008, reason: 'invalid api key' };
    const tts = new ElevenLabsTts({ apiKey: 'k', WebSocket: FakeElevenWS });
    const s = await tts.start({ signal: signal() });
    s.pushText('Hello.');
    const err: unknown = await collect(s.audio()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: 'elevenlabs', status: 401 });
  });
});

describe('factories', () => {
  it('throw a config error naming the missing key', () => {
    expect(() => createChat(DEFAULT_SETTINGS, () => null)).toThrow(/Anthropic API key/);
    expect(createTts({ ...DEFAULT_SETTINGS, ttsProvider: 'system' }, () => null)).toBeNull();
  });
});

describe('pcmToWav', () => {
  it('writes a valid header', () => {
    const wav = pcmToWav(new Int16Array([1, -1]), 16000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
    expect(wav.length).toBe(48);
  });
});

describe('OpenRouter defaults', () => {
  const capture = () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    return { bodies, fetchImpl };
  };
  const req = (audio = false) => ({
    system: 's',
    history: [],
    question: 'q',
    images: [],
    maxTokens: 10,
    signal: new AbortController().signal,
    ...(audio ? { audio: { data: new Uint8Array([1]), format: 'wav' as const } } : {}),
  });
  const drain = async (it: AsyncIterable<string>) => {
    for await (const _ of it) void _;
  };

  it('sends at most three models, primary first, and none when a model is chosen', async () => {
    const c = capture();
    const free = createChat({ ...DEFAULT_SETTINGS, chatProvider: 'openrouter' }, () => 'sk-or-test', c.fetchImpl);
    await drain(free.stream(req()));
    await drain(free.stream(req(true)));
    const [vision, listen] = c.bodies;
    expect((vision?.['models'] as string[]).length).toBeLessThanOrEqual(3);
    expect(vision?.['model']).toBe((vision?.['models'] as string[])[0]);
    expect(vision?.['model']).toBe('google/gemini-2.5-flash-lite');
    expect((listen?.['models'] as string[]).length).toBeLessThanOrEqual(3);
    const paid = createChat(
      { ...DEFAULT_SETTINGS, chatProvider: 'openrouter', chatModel: 'anthropic/claude-sonnet' },
      () => 'sk-or-test',
      c.fetchImpl,
    );
    await drain(paid.stream(req()));
    expect(c.bodies[2]?.['models']).toBeUndefined();
    expect(c.bodies[2]?.['model']).toBe('anthropic/claude-sonnet');
  });
});
