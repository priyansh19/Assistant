import { app, type Tray } from 'electron';
import { HOLD_KEY_LABELS, requiredCredentials, type Settings } from '@clicky/core';
import { getPlatform, type HoldKeyHook, type Platform } from '../platform';
import { CredentialStore } from './credential-store';
import { OverlayManager } from './overlay-manager';
import { SettingsStore } from './settings-store';
import { SettingsWindow } from './settings-window';
import { createTray } from './tray';

// Keep references so they aren't garbage-collected.
let tray: Tray | null = null;
let overlays: OverlayManager | null = null;
let holdKey: HoldKeyHook | null = null;

function startHoldKey(platform: Platform, settings: Settings): void {
  holdKey?.stop();
  // Skeleton wiring: the hold key only toggles the listening indicator.
  // The interaction orchestrator (mic, STT, capture, LLM, TTS) replaces this in Phase 2.
  holdKey = platform.createHoldKeyHook(settings.holdKey);
  holdKey.start({
    onDown: () => overlays?.setState('listening'),
    onUp: () => overlays?.setState('idle'),
  });
}

function applyLaunchAtLogin(enabled: boolean): void {
  // Only meaningful for the installed app; in dev it would register electron.exe.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const platform = getPlatform();
    const settings = new SettingsStore();
    const credentials = new CredentialStore();
    const settingsWindow = new SettingsWindow(settings, credentials);

    tray = createTray({
      openSettings: () => settingsWindow.open(),
      holdKeyLabel: () => HOLD_KEY_LABELS[settings.get().holdKey],
    });
    overlays = new OverlayManager(platform);
    overlays.start();
    startHoldKey(platform, settings.get());
    applyLaunchAtLogin(settings.get().launchAtLogin);

    settings.onChange((next, prev) => {
      if (next.holdKey !== prev.holdKey) startHoldKey(platform, next);
      if (next.launchAtLogin !== prev.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin);
    });

    // First run, or a key the chosen providers need is missing: open settings so the user can add it.
    const keys = credentials.status();
    if (requiredCredentials(settings.get()).some((id) => !keys[id])) settingsWindow.open();

    // Launching Clicky again (e.g. from the Start menu) opens settings instead of a second copy.
    app.on('second-instance', () => settingsWindow.open());
  });

  // Tray app: closing every window must not quit.
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    holdKey?.stop();
    overlays?.stop();
    tray?.destroy();
  });
}
