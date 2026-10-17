import { UiohookKey } from 'uiohook-napi';
import { execFile } from 'node:child_process';
import type { PresetKey } from '@clicky/core';
import type { Platform } from '../types';
import { uiohookKeys } from '../uiohook-keys';
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
  exeSuffix: '.exe',
  monitorWidthsCm,
  ...uiohookKeys(KEYCODES, NAMES),
  createInputDriver: createWin32InputDriver,
  prepare() {},
  fitOverlayToDisplay(win, bounds) {
    // Windows clamps a new window to the work area (above the taskbar) on first show.
    // Setting the bounds again after showing makes it cover the whole display (Phase 0 finding).
    win.showInactive();
    win.setBounds(bounds);
  },
};
