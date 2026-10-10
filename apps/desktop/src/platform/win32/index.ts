import type { HoldKey } from '@clicky/core';
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import type { HoldKeyHook, Platform } from '../types';

const KEYCODES: Record<HoldKey, number> = {
  RightCtrl: UiohookKey.CtrlRight,
  RightAlt: UiohookKey.AltRight,
  RightShift: UiohookKey.ShiftRight,
  CapsLock: UiohookKey.CapsLock,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
};

function createHoldKeyHook(key: HoldKey): HoldKeyHook {
  const keycode = KEYCODES[key];
  let down = false;
  let onKeyDown: ((e: UiohookKeyboardEvent) => void) | null = null;
  let onKeyUp: ((e: UiohookKeyboardEvent) => void) | null = null;
  return {
    start({ onDown, onUp }) {
      onKeyDown = (e) => {
        if (e.keycode !== keycode || down) return; // ignore auto-repeat
        down = true;
        onDown();
      };
      onKeyUp = (e) => {
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

export const win32Platform: Platform = {
  name: 'win32',
  createHoldKeyHook,
  fitOverlayToDisplay(win, bounds) {
    // Windows clamps a new window to the work area (above the taskbar) on first show.
    // Setting the bounds again after showing makes it cover the whole display (Phase 0 finding).
    win.showInactive();
    win.setBounds(bounds);
  },
};
