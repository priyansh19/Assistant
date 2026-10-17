import type { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// A fake libuiohook: tests press keys by emitting its events.
const hook = vi.hoisted(() => ({ emitter: null as EventEmitter | null }));
vi.mock('uiohook-napi', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const emitter = new Emitter();
  hook.emitter = emitter;
  const UiohookKey = {
    Escape: 1,
    Space: 57,
    CtrlRight: 3613,
    AltRight: 3640,
    ShiftRight: 54,
    Meta: 3675,
    Alt: 56,
    CapsLock: 58,
    F8: 66,
    F9: 67,
    F10: 68,
  };
  return {
    UiohookKey,
    uIOhook: {
      on: (e: string, fn: (...a: unknown[]) => void) => emitter.on(e, fn),
      off: (e: string, fn: (...a: unknown[]) => void) => emitter.off(e, fn),
      start: () => undefined,
      stop: () => undefined,
    },
  };
});

const { win32Platform } = await import('./win32');
const press = (keycode: number): void => void hook.emitter?.emit('keydown', { keycode });
const release = (keycode: number): void => void hook.emitter?.emit('keyup', { keycode });

describe('hold keys after the move to uiohook-keys', () => {
  it('Right Ctrl talks and Right Alt dictates', () => {
    const calls: string[] = [];
    const h = win32Platform.createHoldKeyHook('RightCtrl', 'RightAlt');
    h.start({
      onDown: () => calls.push('talk down'),
      onUp: () => calls.push('talk up'),
      onDictateDown: () => calls.push('dictate down'),
      onDictateUp: () => calls.push('dictate up'),
    });
    press(3613);
    release(3613);
    press(3640);
    release(3640);
    h.stop();
    expect(calls).toEqual(['talk down', 'talk up', 'dictate down', 'dictate up']);
  });

  it('records a key combination with a friendly label', async () => {
    const recorded = win32Platform.recordKeys(1000);
    press(56);
    press(3675);
    release(56);
    release(3675);
    await expect(recorded).resolves.toEqual({ codes: [56, 3675], label: 'Win + Alt' });
  });
});
