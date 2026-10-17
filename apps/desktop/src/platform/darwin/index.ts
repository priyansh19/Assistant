import { UiohookKey } from 'uiohook-napi';
import { systemPreferences } from 'electron';
import type { PresetKey } from '@clicky/core';
import type { Platform } from '../types';
import { uiohookKeys } from '../uiohook-keys';

// macOS: hold-to-talk, capture, answers and pointing. Agent mode (clicking and typing for the
// user) is Windows only for now, so there is no input driver here.

/**
 * Most Mac keyboards have no right Control key, so the "Right Ctrl" preset means right Command
 * here; the other presets are the same keys (Right Alt is right Option).
 */
const KEYCODES: Record<PresetKey, number> = {
  RightCtrl: UiohookKey.MetaRight,
  RightAlt: UiohookKey.AltRight,
  RightShift: UiohookKey.ShiftRight,
  CapsLock: UiohookKey.CapsLock,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
};

const NAMES: Record<string, string> = {
  Meta: 'Cmd',
  MetaRight: 'Right Cmd',
  Ctrl: 'Control',
  CtrlRight: 'Right Control',
  Alt: 'Option',
  AltRight: 'Right Option',
  Shift: 'Shift',
  ShiftRight: 'Right Shift',
  CapsLock: 'Caps Lock',
  Space: 'Space',
};

export const darwinPlatform: Platform = {
  name: 'darwin',
  ...uiohookKeys(KEYCODES, NAMES),
  createInputDriver: () => null,
  prepare() {
    // The key hook only hears keys once Clicky is trusted for Accessibility; `true` opens the
    // system prompt that links to the setting. Screen Recording is asked for on first capture.
    systemPreferences.isTrustedAccessibilityClient(true);
    void systemPreferences.askForMediaAccess('microphone').catch(() => false);
  },
  fitOverlayToDisplay(win, bounds) {
    // Cover full-screen apps and every Space, above the menu bar.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.showInactive();
    win.setBounds(bounds);
  },
  monitorWidthsCm: () => Promise.resolve([]),
};
