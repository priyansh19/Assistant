import { comboKeycodes, isComboKey, type HoldKey, type PresetKey } from '@clicky/core';
import {
  uIOhook,
  UiohookKey,
  type UiohookKeyboardEvent,
  type UiohookMouseEvent,
  type UiohookWheelEvent,
} from 'uiohook-napi';
import { execFile } from 'node:child_process';
import type { HoldKeyHook, Platform } from '../types';
import { createWin32InputDriver } from './input';

const KEYCODES: Record<PresetKey, number> = {
  RightCtrl: UiohookKey.CtrlRight,
  RightAlt: UiohookKey.AltRight,
  RightShift: UiohookKey.ShiftRight,
  CapsLock: UiohookKey.CapsLock,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
};

/** The keycodes that make up a hold key: one for a preset, up to four for a recorded combination. */
function codesOf(key: HoldKey): number[] {
  return isComboKey(key) ? comboKeycodes(key) : [KEYCODES[key]];
}

const sameKeys = (a: number[], b: number[]): boolean => a.length === b.length && a.every((c) => b.includes(c));

function createHoldKeyHook(key: HoldKey, dictationKey: HoldKey | null = null): HoldKeyHook {
  const talk = codesOf(key);
  const dict = dictationKey && dictationKey !== key ? codesOf(dictationKey) : null;
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

/** Friendly names for the keys people put in a combination. */
const NAMES: Record<string, string> = {
  Meta: 'Win',
  MetaRight: 'Right Win',
  Ctrl: 'Ctrl',
  CtrlRight: 'Right Ctrl',
  Alt: 'Alt',
  AltRight: 'Right Alt',
  Shift: 'Shift',
  ShiftRight: 'Right Shift',
  CapsLock: 'Caps Lock',
  Space: 'Space',
};
const MODIFIER_ORDER = ['Ctrl', 'Right Ctrl', 'Win', 'Right Win', 'Alt', 'Right Alt', 'Shift', 'Right Shift'];

function keyName(code: number): string {
  const name = Object.entries(UiohookKey).find(([, c]) => c === code)?.[0] ?? `Key ${code}`;
  return NAMES[name] ?? name;
}

function recordKeys(timeoutMs: number): Promise<{ codes: number[]; label: string } | null> {
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
        const names = pressed.map(keyName);
        names.sort((a, b) => {
          const ia = MODIFIER_ORDER.indexOf(a);
          const ib = MODIFIER_ORDER.indexOf(b);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        finish({ codes: [...pressed], label: names.join(' + ') });
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    uIOhook.on('keydown', down);
    uIOhook.on('keyup', up);
    uIOhook.start();
  });
}

/** EDID image size from WMI (whole centimetres), active monitors only. */
function monitorWidthsCm(): Promise<number[]> {
  const ps =
    'Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBasicDisplayParams | ' +
    'Where-Object Active | ForEach-Object { $_.MaxHorizontalImageSize }';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split(/\r?\n/)
            .map((l) => Number(l.trim()))
            .filter((n) => Number.isFinite(n) && n > 5 && n < 300),
        );
      },
    );
  });
}

export const win32Platform: Platform = {
  name: 'win32',
  monitorWidthsCm,
  createHoldKeyHook,
  recordKeys,
  createInputDriver: createWin32InputDriver,
  fitOverlayToDisplay(win, bounds) {
    // Windows clamps a new window to the work area (above the taskbar) on first show.
    // Setting the bounds again after showing makes it cover the whole display (Phase 0 finding).
    win.showInactive();
    win.setBounds(bounds);
  },
};
