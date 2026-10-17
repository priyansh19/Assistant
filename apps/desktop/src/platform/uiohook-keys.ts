import { comboKeycodes, isComboKey, type HoldKey, type PresetKey } from '@clicky/core';
import {
  uIOhook,
  UiohookKey,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
  type UiohookWheelEvent,
} from 'uiohook-napi';
import type { HoldKeyHook, Platform } from './types';

// The hold-to-talk hook and key recorder on top of libuiohook, which works the same on Windows,
// macOS and X11 Linux. Each OS passes its own preset keycodes and the names its keyboards print.

/** The keycodes that make up a hold key: one for a preset, up to four for a recorded combination. */
function codesOf(keycodes: Record<PresetKey, number>, key: HoldKey): number[] {
  return isComboKey(key) ? comboKeycodes(key) : [keycodes[key]];
}

const sameKeys = (a: number[], b: number[]): boolean => a.length === b.length && a.every((c) => b.includes(c));

function createHoldKeyHook(
  keycodes: Record<PresetKey, number>,
  key: HoldKey,
  dictationKey: HoldKey | null = null,
): HoldKeyHook {
  const talk = codesOf(keycodes, key);
  const dict = dictationKey && dictationKey !== key ? codesOf(keycodes, dictationKey) : null;
  if (dict && sameKeys(dict, talk)) dict.length = 0;
  const ours = new Set([...talk, ...(dict ?? [])]);
  /** Keys of either combination that are held right now. */
  const held = new Set<number>();
  const allHeld = (codes: number[] | null): boolean => !!codes?.length && codes.every((c) => held.has(c));
  let down = false;
  let dictDown = false;
  let onKeyDown: ((e: UiohookKeyboardEvent) => void) | null = null;
  let onKeyUp: ((e: UiohookKeyboardEvent) => void) | null = null;
  let onMouse: ((e: UiohookMouseEvent) => void) | null = null;
  let onWheel: ((e: UiohookWheelEvent) => void) | null = null;
  let onMove: ((e: UiohookMouseEvent) => void) | null = null;
  return {
    start({ onDown, onUp, onCancel, onDictateDown, onDictateUp, onUserInput }) {
      onKeyDown = (e) => {
        if (!ours.has(e.keycode) && e.keycode !== UiohookKey.Escape) onUserInput?.({ kind: 'key' });
        if (e.keycode === UiohookKey.Escape) {
          onCancel?.();
          return;
        }
        if (!ours.has(e.keycode)) return;
        held.add(e.keycode);
        if (down || dictDown) return; // auto-repeat, or already listening
        // The longer combination wins when one contains the other (Win+Alt over Alt).
        const talkReady = allHeld(talk);
        const dictReady = allHeld(dict);
        if (dictReady && (!talkReady || (dict?.length ?? 0) > talk.length)) {
          dictDown = true;
          onDictateDown?.();
        } else if (talkReady) {
          down = true;
          onDown();
        }
      };
      onKeyUp = (e) => {
        held.delete(e.keycode);
        if (dictDown && dict?.includes(e.keycode)) {
          dictDown = false;
          onDictateUp?.();
          return;
        }
        if (down && talk.includes(e.keycode)) {
          down = false;
          onUp();
        }
      };
      uIOhook.on('keydown', onKeyDown);
      uIOhook.on('keyup', onKeyUp);
      if (onUserInput) {
        onMove = (e) => onUserInput({ kind: 'move', x: e.x, y: e.y });
        // libuiohook numbers buttons 1 (left), 2 (right), 3 (middle).
        onMouse = (e) =>
          onUserInput({
            kind: 'click',
            x: e.x,
            y: e.y,
            button: e.button === 1 ? 'left' : e.button === 2 ? 'right' : 'middle',
          });
        onWheel = (e) => onUserInput({ kind: 'wheel', x: e.x, y: e.y });
        uIOhook.on('mousemove', onMove);
        uIOhook.on('mousedown', onMouse);
        uIOhook.on('wheel', onWheel);
      }
      uIOhook.start();
    },
    stop() {
      if (onKeyDown) uIOhook.off('keydown', onKeyDown);
      if (onKeyUp) uIOhook.off('keyup', onKeyUp);
      if (onMouse) uIOhook.off('mousedown', onMouse);
      if (onWheel) uIOhook.off('wheel', onWheel);
      if (onMove) uIOhook.off('mousemove', onMove);
      onMouse = null;
      onWheel = null;
      onMove = null;
      onKeyDown = onKeyUp = null;
      uIOhook.stop();
    },
  };
}

/** The order modifiers are listed in a recorded combination's label (uiohook key names). */
const MODIFIER_ORDER = ['Ctrl', 'CtrlRight', 'Meta', 'MetaRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight'];

function uiohookName(code: number): string {
  return Object.entries(UiohookKey).find(([, c]) => c === code)?.[0] ?? `Key ${code}`;
}

function recordKeys(
  names: Record<string, string>,
  timeoutMs: number,
): Promise<{ codes: number[]; label: string } | null> {
  return new Promise((resolve) => {
    const pressed: number[] = [];
    const held = new Set<number>();
    const finish = (result: { codes: number[]; label: string } | null): void => {
      clearTimeout(timer);
      uIOhook.off('keydown', down);
      uIOhook.off('keyup', up);
      uIOhook.stop();
      resolve(result);
    };
    const down = (e: UiohookKeyboardEvent): void => {
      if (e.keycode === UiohookKey.Escape) return finish(null);
      held.add(e.keycode);
      if (!pressed.includes(e.keycode) && pressed.length < 4) pressed.push(e.keycode);
    };
    const up = (e: UiohookKeyboardEvent): void => {
      held.delete(e.keycode);
      if (held.size === 0 && pressed.length) {
        const order = (code: number): number => {
          const i = MODIFIER_ORDER.indexOf(uiohookName(code));
          return i === -1 ? 99 : i;
        };
        const label = [...pressed]
          .sort((a, b) => order(a) - order(b))
          .map((c) => names[uiohookName(c)] ?? uiohookName(c))
          .join(' + ');
        finish({ codes: [...pressed], label });
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    uIOhook.on('keydown', down);
    uIOhook.on('keyup', up);
    uIOhook.start();
  });
}

/** The hold-key half of a Platform, for one OS's keycodes and key names. */
export function uiohookKeys(
  keycodes: Record<PresetKey, number>,
  names: Record<string, string>,
): Pick<Platform, 'createHoldKeyHook' | 'recordKeys'> {
  return {
    createHoldKeyHook: (key, dictationKey) => createHoldKeyHook(keycodes, key, dictationKey ?? null),
    recordKeys: (timeoutMs) => recordKeys(names, timeoutMs),
  };
}
