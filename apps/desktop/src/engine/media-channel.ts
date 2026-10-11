import type { WorkerEvent, WorkerReply, WorkerRequest } from '../shared/worker-protocol';

/**
 * The engine's view of the media renderer (mic, capture, playback). In the engine process this is
 * a MessagePort straight to the renderer, so audio never passes through main (architecture §4);
 * in the in-process fallback it is main's WorkerHost.
 */
export interface MediaChannel {
  /** Send a request; the timeout covers waiting for the channel too, so nothing waits forever. */
  request<T = unknown>(req: WorkerRequest, timeoutMs?: number): Promise<T>;
  /** Fire-and-forget (audio chunks): errors are reported through events instead. */
  send(req: WorkerRequest): void;
  on(handler: (e: WorkerEvent) => void): () => void;
}

/** Messages on the engine ↔ media port. */
export type MediaPortMessage =
  | { kind: 'request'; id: number; req: WorkerRequest }
  | { kind: 'reply'; reply: WorkerReply }
  | { kind: 'event'; event: WorkerEvent };

/** The parts of Electron's MessagePortMain this needs (kept structural for tests). */
export interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}

/**
 * MediaChannel over a MessagePort. Requests made before a port is attached (startup, or while the
 * renderer restarts) wait for one, bounded by their timeout.
 */
export class PortMediaChannel implements MediaChannel {
  private port: PortLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly waiting = new Set<() => void>();
  private readonly handlers = new Set<(e: WorkerEvent) => void>();

  attach(port: PortLike): void {
    this.detach();
    this.port = port;
    port.on('message', (e) => this.receive(port, e.data as MediaPortMessage));
    port.on('close', () => {
      if (this.port === port) this.crashed();
    });
    port.start();
    for (const fn of [...this.waiting]) fn();
  }

  /** The renderer died: fail everything in flight and tell every stream waiter. */
  crashed(): void {
    this.detach();
    for (const p of this.pending.values()) p.reject(new Error('audio/capture worker crashed'));
    this.pending.clear();
    this.emit({ type: 'worker.crashed' });
  }

  private detach(): void {
    const port = this.port;
    this.port = null;
    if (port) {
      try {
        port.close();
      } catch {
        // already closed
      }
    }
  }

  private receive(port: PortLike, msg: MediaPortMessage): void {
    if (port !== this.port) return;
    if (msg.kind === 'event') {
      this.emit(msg.event);
    } else if (msg.kind === 'reply') {
      const p = this.pending.get(msg.reply.id);
      if (!p) return;
      this.pending.delete(msg.reply.id);
      if (msg.reply.ok) p.resolve(msg.reply.result);
      else p.reject(new Error(msg.reply.error ?? 'worker error'));
    }
  }

  private emit(e: WorkerEvent): void {
    for (const h of this.handlers) h(e);
  }

  request<T = unknown>(req: WorkerRequest, timeoutMs = 15000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let wait: (() => void) | null = null;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (wait) this.waiting.delete(wait);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`worker ${req.op} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v as T);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
      });
      const post = (): void => {
        if (wait) this.waiting.delete(wait);
        this.port?.postMessage({ kind: 'request', id, req } satisfies MediaPortMessage);
      };
      // Connected: send synchronously, so a key-down request isn't queued behind other work.
      if (this.port) post();
      else {
        wait = post;
        this.waiting.add(wait);
      }
    });
  }

  send(req: WorkerRequest): void {
    void this.request(req).catch(() => undefined);
  }

  on(handler: (e: WorkerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
