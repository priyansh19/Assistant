import type { HoldKey } from '@clicky/core';
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import { execFile } from 'node:child_process';
import type { HoldKeyHook, Platform } from '../types';
import { createWin32InputDriver } from './input';

const KEYCODES: Record<HoldKey, number> = {
  RightCtrl: UiohookKey.CtrlRight,
  RightAlt: UiohookKey.AltRight,
  RightShift: UiohookKey.ShiftRight,
  CapsLock: UiohookKey.CapsLock,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
};

function createHoldKeyHook(key: HoldKey, dictationKey: HoldKey | null = null): HoldKeyHook {
  const keycode = KEYCODES[key];
  const dictCode = dictationKey && dictationKey !== key ? KEYCODES[dictationKey] : null;
  let down = false;
  let dictDown = false;
  let onKeyDown: ((e: UiohookKeyboardEvent) => void) | null = null;
  let onKeyUp: ((e: UiohookKeyboardEvent) => void) | null = null;
  return {
    start({ onDown, onUp, onCancel, onDictateDown, onDictateUp }) {
      onKeyDown = (e) => {
        if (e.keycode === UiohookKey.Escape) {
          onCancel?.();
          return;
        }
        if (e.keycode === dictCode) {
          if (dictDown || down) return; // auto-repeat, or already talking
          dictDown = true;
          onDictateDown?.();
          return;
        }
        if (e.keycode !== keycode || down || dictDown) return; // ignore auto-repeat
        down = true;
        onDown();
      };
      onKeyUp = (e) => {
        if (e.keycode === dictCode && dictDown) {
          dictDown = false;
          onDictateUp?.();
          return;
        }
        if (e.keycode !== keycode || !down) return;
        down = false;
        onUp();
      };
      uIOhook.on('keydown', onKeyDown);
      uIOhook.on('keyup', onKeyUp);
      uIOhook.start();
    },
    stop() {
      if (onKeyDown) uIOhook.off('keydown', onKeyDown);
      if (onKeyUp) uIOhook.off('keyup', onKeyUp);
      onKeyDown = onKeyUp = null;
      uIOhook.stop();
    },
  };
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
  createInputDriver: createWin32InputDriver,
  fitOverlayToDisplay(win, bounds) {
    // Windows clamps a new window to the work area (above the taskbar) on first show.
    // Setting the bounds again after showing makes it cover the whole display (Phase 0 finding).
    win.showInactive();
    win.setBounds(bounds);
  },
};
