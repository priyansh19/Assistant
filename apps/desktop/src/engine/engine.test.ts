import { DEFAULT_SETTINGS, type HoldKey } from '@clicky/core';
import { describe, expect, it } from 'vitest';
import type { HoldKeyHook } from '../platform/types';
import type { EngineConfig, EngineToMain } from '../shared/engine-protocol';
import type { WorkerEvent, WorkerRequest } from '../shared/worker-protocol';
import { Engine } from './engine';
import { PortMediaChannel, type MediaChannel, type MediaPortMessage, type PortLike } from './media-channel';

/** A media renderer stand-in: mic that records, a 1280x800 screen, and a voice that plays instantly. */
function fakeMedia(): MediaChannel & { requests: WorkerRequest[] } {
  const handlers = new Set<(e: WorkerEvent) => void>();
  const emit = (e: WorkerEvent): void => {
    for (const h of handlers) h(e);
  };
  const requests: WorkerRequest[] = [];
  const handle = async (req: WorkerRequest): Promise<unknown> => {
    requests.push(req);
    switch (req.op) {
      case 'mic.start':
        setTimeout(() => emit({ type: 'mic.frame', frame: new Int16Array(320) }), 1);
        return;
      case 'capture.take':
        return [{ data: new Uint8Array(100), width: 1280, height: 800 }];
      case 'voice.say':
        setTimeout(() => emit({ type: 'audio.started', streamId: req.streamId }), 1);
        return;
      case 'voice.finish':
        setTimeout(() => emit({ type: 'audio.finished', streamId: req.streamId }), 2);
        return;
      default:
        return;
    }
  };
  return {
    requests,
    request: <T>(req: WorkerRequest) => handle(req) as Promise<T>,
    send: (req) => void handle(req),
    on: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
}

function fakeHook() {
  const h: { down?: () => void; up?: () => void; cancel?: () => void; key?: HoldKey; stopped: number } = {
    stopped: 0,
  };
  const create = (key: HoldKey): HoldKeyHook => ({
    start({ onDown, onUp, onCancel }) {
      h.key = key;
      h.down = onDown;
      h.up = onUp;
      if (onCancel) h.cancel = onCancel;
    },
    stop: () => void h.stopped++,
  });
  return { h, create };
}

const config = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  settings: { ...DEFAULT_SETTINGS, ttsProvider: 'system' },
  keys: {},
  missing: [],
  history: [],
  demo: true,
  modelsDir: '/nonexistent/models',
  playbooks: [],
  ...over,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(cfg = config()) {
  const posts: EngineToMain[] = [];
  const media = fakeMedia();
  const hook = fakeHook();
  const engine = new Engine({ post: (m) => posts.push(m), media, createHoldKeyHook: hook.create });
  // Main answers capture plan requests with one display.
  const plan = (m: EngineToMain): void => {
    if (m.type === 'capturePlan')
      queueMicrotask(() =>
        engine.handle({
          type: 'capturePlan.reply',
          id: m.id,
          plan: {
            displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 1 }],
            sources: [{ sourceId: 'screen:1', width: 1280, height: 800 }],
          },
        }),
      );
  };
  const origPush = posts.push.bind(posts);
  posts.push = (...items: EngineToMain[]) => {
    for (const m of items) plan(m);
    return origPush(...items);
  };
  engine.handle({ type: 'config', config: cfg });
  engine.handle({ type: 'holdKey.start' });
  return { engine, posts, media, hook };
}

describe('Engine', () => {
  it('runs a voice question end to end from the hook and reports to main', async () => {
    const { posts, hook, media } = setup();
    expect(hook.h.key).toBe(DEFAULT_SETTINGS.holdKey);
    hook.h.down?.();
    await wait(300);
    hook.h.up?.();
    for (let i = 0; i < 100 && !posts.some((p) => p.type === 'latency'); i++) await wait(20);
    const states = posts.flatMap((p) => (p.type === 'state' ? [p.state] : []));
    expect(states).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'idle']);
    expect(posts).toContainEqual({ type: 'listening' });
    expect(posts.some((p) => p.type === 'overlay' && p.overlay.op === 'point')).toBe(true);
    expect(posts.find((p) => p.type === 'record')).toMatchObject({
      entry: { question: 'Where is the start button?', outcome: 'answered' },
    });
    const latency = posts.find((p) => p.type === 'latency');
    expect(latency).toMatchObject({ summary: { meta: { chat: 'demo-chat', voice: 'system' } } });
    expect(media.requests.some((r) => r.op === 'capture.take')).toBe(true);
  });

  it('opens the keys page instead of listening when keys are missing', () => {
    const { posts, hook, media } = setup(config({ missing: ['anthropic'] }));
    hook.h.down?.();
    expect(posts).toContainEqual({ type: 'needKeys' });
    expect(media.requests.some((r) => r.op === 'mic.start')).toBe(false);
  });

  it('reports presses to the setup wizard in key-test mode', () => {
    const { engine, posts, hook } = setup();
    engine.handle({ type: 'keyTest', on: true });
    hook.h.down?.();
    hook.h.up?.();
    expect(posts.filter((p) => p.type === 'keyTest')).toEqual([
      { type: 'keyTest', down: true },
      { type: 'keyTest', down: false },
    ]);
  });

  it('answers typed questions with a result', async () => {
    const { engine, posts } = setup();
    engine.handle({ type: 'ask', id: 7, question: 'where is start?', source: 'typed' });
    for (let i = 0; i < 100 && !posts.some((p) => p.type === 'askResult'); i++) await wait(20);
    expect(posts.find((p) => p.type === 'askResult')).toMatchObject({ id: 7, result: { outcome: 'answered' } });
  });

  it('restarts the hook when the hold key changes', () => {
    const { engine, hook } = setup();
    engine.handle({ type: 'config', config: config({ settings: { ...DEFAULT_SETTINGS, holdKey: 'F9' } }) });
    expect(hook.h.key).toBe('F9');
    expect(hook.h.stopped).toBeGreaterThan(0);
  });
});

/** Two connected in-memory ports, shaped like Electron's MessagePortMain. */
function portPair(): [PortLike & { closed: boolean }, (msg: MediaPortMessage) => void, MediaPortMessage[]] {
  const sent: MediaPortMessage[] = [];
  let listener: ((e: { data: unknown }) => void) | null = null;
  let onClose: (() => void) | null = null;
  const port = {
    closed: false,
    postMessage: (m: unknown) => void sent.push(m as MediaPortMessage),
    on(event: 'message' | 'close', fn: ((e: { data: unknown }) => void) | (() => void)) {
      if (event === 'message') listener = fn as (e: { data: unknown }) => void;
      else onClose = fn as () => void;
      return port;
    },
    start: () => undefined,
    close() {
      port.closed = true;
      onClose?.();
    },
  };
  return [port, (msg) => listener?.({ data: msg }), sent];
}

describe('PortMediaChannel', () => {
  it('queues requests until a port is attached, then matches replies by id', async () => {
    const ch = new PortMediaChannel();
    const p = ch.request<string[]>({ op: 'mic.devices' }, 1000);
    const [port, deliver, sent] = portPair();
    ch.attach(port);
    expect(sent[0]).toMatchObject({ kind: 'request', req: { op: 'mic.devices' } });
    const id = (sent[0] as { id: number }).id;
    deliver({ kind: 'reply', reply: { id, ok: true, result: ['mic'] } });
    await expect(p).resolves.toEqual(['mic']);
  });

  it('forwards events and fails everything in flight when the renderer goes away', async () => {
    const ch = new PortMediaChannel();
    const [port, deliver] = portPair();
    ch.attach(port);
    const events: WorkerEvent[] = [];
    ch.on((e) => events.push(e));
    deliver({ kind: 'event', event: { type: 'mic.level', level: 0.5 } });
    const p = ch.request({ op: 'mic.start', deviceId: '', owner: 'voice' }, 1000);
    ch.crashed();
    await expect(p).rejects.toThrow(/crashed/);
    expect(events).toEqual([{ type: 'mic.level', level: 0.5 }, { type: 'worker.crashed' }]);
    expect(port.closed).toBe(true);
  });

  it('times out when no port arrives', async () => {
    const ch = new PortMediaChannel();
    await expect(ch.request({ op: 'mic.devices' }, 5)).rejects.toThrow(/timed out/);
  });
});
