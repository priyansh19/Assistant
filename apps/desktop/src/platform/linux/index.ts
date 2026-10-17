import { UiohookKey } from 'uiohook-napi';
import type { PresetKey } from '@clicky/core';
import type { Platform } from '../types';
import { uiohookKeys } from '../uiohook-keys';

// Linux (X11): hold-to-talk, capture, answers and pointing. Wayland can't give a global key-up,
// and agent mode (clicking and typing for the user) is Windows only for now.

const KEYCODES: Record<PresetKey, number> = {
  RightCtrl: UiohookKey.CtrlRight,
  RightAlt: UiohookKey.AltRight,
  RightShift: UiohookKey.ShiftRight,
  CapsLock: UiohookKey.CapsLock,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
};

const NAMES: Record<string, string> = {
  Meta: 'Super',
  MetaRight: 'Right Super',
  Ctrl: 'Ctrl',
  CtrlRight: 'Right Ctrl',
  Alt: 'Alt',
  AltRight: 'Right Alt',
  Shift: 'Shift',
  ShiftRight: 'Right Shift',
  CapsLock: 'Caps Lock',
  Space: 'Space',
};

export const linuxPlatform: Platform = {
  name: 'linux',
  ...uiohookKeys(KEYCODES, NAMES),
  createInputDriver: () => null,
  prepare() {},
  fitOverlayToDisplay(win, bounds) {
    win.showInactive();
    win.setBounds(bounds);
  },
  monitorWidthsCm: () => Promise.resolve([]),
};
