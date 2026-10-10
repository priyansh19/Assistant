import { app, type Tray } from 'electron';
import { getPlatform, type HoldKeyHook } from '../platform';
import { OverlayManager } from './overlay-manager';
import { createTray } from './tray';

// Keep references so they aren't garbage-collected.
let tray: Tray | null = null;
let overlays: OverlayManager | null = null;
let holdKey: HoldKeyHook | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const platform = getPlatform();
    tray = createTray();
    overlays = new OverlayManager(platform);
    overlays.start();

    // Skeleton wiring: the hold key only toggles the listening indicator.
    // The interaction orchestrator (mic, STT, capture, LLM, TTS) replaces this in Phase 2.
    holdKey = platform.createHoldKeyHook();
    holdKey.start({
      onDown: () => overlays?.setState('listening'),
      onUp: () => overlays?.setState('idle'),
    });
  });

  // Tray app: closing every window must not quit.
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    holdKey?.stop();
    overlays?.stop();
    tray?.destroy();
  });
}
