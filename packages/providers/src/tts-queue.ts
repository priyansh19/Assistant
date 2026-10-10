import type { TtsAudioChunk, TtsSession } from '@clicky/core';

/**
 * Turns a per-sentence synthesis function into a streaming TtsSession: every sentence starts
 * synthesising as soon as it's pushed (so sentence 2 is ready when sentence 1 finishes), but audio
 * comes out strictly in order.
 */
export function sentenceQueueSession(
  signal: AbortSignal,
  synthesize: (text: string) => AsyncIterable<TtsAudioChunk>,
  maxParallel = 2,
): TtsSession {
  interface Job {
    chunks: TtsAudioChunk[];
    done: boolean;
    error: unknown;
    started: boolean;
    text: string;
  }
  const jobs: Job[] = [];
  let ended = false;
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const run = (job: Job): void => {
    job.started = true;
    void (async () => {
      try {
        for await (const c of synthesize(job.text)) {
          if (closed || signal.aborted) break;
          job.chunks.push(c);
          notify();
        }
      } catch (e) {
        job.error = e;
      } finally {
        job.done = true;
        notify();
        startMore();
      }
    })();
  };
  let consumed = 0;
  const startMore = (): void => {
    let running = jobs.filter((j, i) => i >= consumed && j.started && !j.done).length;
    for (let i = consumed; i < jobs.length && running < maxParallel; i++) {
      const j = jobs[i];
      if (j && !j.started) {
        run(j);
        running++;
      }
    }
  };

  return {
    pushText(text) {
      if (closed || ended || !text.trim()) return;
      jobs.push({ chunks: [], done: false, error: null, started: false, text });
      startMore();
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *audio() {
      for (;;) {
        if (closed || signal.aborted) return;
        const job = jobs[consumed];
        if (!job) {
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        const c = job.chunks.shift();
        if (c) {
          yield c;
          continue;
        }
        if (job.done) {
          if (job.error) throw job.error;
          consumed++;
          startMore();
          continue;
        }
        await new Promise<void>((r) => (wake = r));
      }
    },
    close() {
      closed = true;
      notify();
    },
  };
}
