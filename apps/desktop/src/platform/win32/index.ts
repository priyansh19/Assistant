import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import type { HoldKeyHook, Platform } from '../types';

// Right Ctrl has no meaning on its own in Windows, so holding it doesn't fight other shortcuts.
const DEFAULT_HOLD_KEY = UiohookKey.CtrlRight;

function createHoldKeyHook(keycode: number = DEFAULT_HOLD_KEY): HoldKeyHook {
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
      uIOhook.stop();
    },
  };
}

export const win32Platform: Platform = {
  name: 'win32',
  createHoldKeyHook: () => createHoldKeyHook(),
  fitOverlayToDisplay(win, bounds) {
    // Windows clamps a new window to the work area (above the taskbar) on first show.
    // Setting the bounds again after showing makes it cover the whole display (Phase 0 finding).
    win.showInactive();
    win.setBounds(bounds);
  },
};
