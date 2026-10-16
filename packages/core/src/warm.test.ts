import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WARM_BACKOFF_MS, WarmKeeper, type WarmTarget } from './warm.js';

describe('WarmKeeper', () => {
  let now = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
  });
  afterEach(() => vi.useRealTimers());

  const advance = async (ms: number): Promise<void> => {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  function target(
    name: string,
    everyMs: number,
    fail = () => false,
  ): WarmTarget & { calls: number; signals: AbortSignal[] } {
    const t = {
      name,
      everyMs,
      calls: 0,
      signals: [] as AbortSignal[],
      warm(signal: AbortSignal) {
        t.calls++;
        t.signals.push(signal);
        if (fail()) throw new Error('offline');
      },
    };
    return t;
  }

  it('warms every target at once, then on each one’s interval while in use', async () => {
    const chat = target('chat', 60_000);
    const voice = target('voice', 120_000);
    const k = new WarmKeeper({ targets: () => [chat, voice], idleMs: 600_000, now: () => now });
    k.touch('launch');
    await advance(0);
    expect([chat.calls, voice.calls]).toEqual([1, 1]);
    await advance(120_000);
    expect([chat.calls, voice.calls]).toEqual([3, 2]);
    k.stop();
  });

  it('lets go after the quiet spell, aborting the signal so spare sockets close', async () => {
    const voice = target('voice', 60_000);
    const k = new WarmKeeper({ targets: () => [voice], idleMs: 100_000, now: () => now });
    k.touch('answer');
    await advance(0);
    await advance(120_000);
    expect(k.active).toBe(false);
    expect(voice.signals[0]?.aborted).toBe(true);
    const calls = voice.calls;
    await advance(300_000);
    expect(voice.calls).toBe(calls);
    // The next use warms again.
    k.touch('press');
    await advance(0);
    expect(voice.calls).toBe(calls + 1);
    k.stop();
  });

  it('a use during the warm spell extends it without restarting', async () => {
    const chat = target('chat', 60_000);
    const k = new WarmKeeper({ targets: () => [chat], idleMs: 100_000, now: () => now });
    k.touch('a');
    await advance(0);
    await advance(90_000);
    k.touch('b');
    await advance(60_000);
    expect(k.active).toBe(true);
    expect(chat.calls).toBe(3);
    k.stop();
  });

  it('stays warm while busy (an agent task), whatever the idle time', async () => {
    const chat = target('chat', 60_000);
    const k = new WarmKeeper({ targets: () => [chat], idleMs: 10_000, now: () => now });
    k.touch('task');
    k.busy(true);
    await advance(300_000);
    expect(k.active).toBe(true);
    k.busy(false);
    await advance(80_000);
    expect(k.active).toBe(false);
  });

  it('retries a failed warm-up with backoff, not at full rate', async () => {
    let failing = true;
    const stt = target('stt', 240_000, () => failing);
    const log: string[] = [];
    const k = new WarmKeeper({ targets: () => [stt], idleMs: 3_600_000, now: () => now, log: (m) => log.push(m) });
    k.touch('launch');
    await advance(0);
    expect(stt.calls).toBe(1);
    await advance(WARM_BACKOFF_MS[0]);
    expect(stt.calls).toBe(2);
    failing = false;
    await advance(WARM_BACKOFF_MS[1]);
    expect(stt.calls).toBe(3);
    // Healthy again: back to its own interval.
    await advance(WARM_BACKOFF_MS[2]);
    expect(stt.calls).toBe(3);
    expect(log.some((m) => m.includes('warm-up of stt failed'))).toBe(true);
    k.stop();
  });

  it('restart drops the old generation and warms the new providers', async () => {
    let gen = 1;
    const seen: number[] = [];
    const k = new WarmKeeper({
      targets: () => {
        const g = gen;
        return [{ name: 'voice', everyMs: 60_000, warm: () => void seen.push(g) }];
      },
      now: () => now,
    });
    k.touch('launch');
    await advance(0);
    gen = 2;
    k.restart('settings changed');
    await advance(60_000);
    expect(seen).toEqual([1, 2, 2]);
    k.stop();
  });
});
