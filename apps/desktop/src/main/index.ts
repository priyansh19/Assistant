import { applyInstructionPack } from './instruction-pack';
import { app, Notification } from 'electron';
import { holdKeyLabel, type Settings } from '@clicky/core';
import type { OverlayConfig } from '../shared/overlay-protocol';
import { getPlatform } from '../platform';
import { Controller } from './controller';
import { CredentialStore } from './credential-store';
import { DashboardWindow } from './dashboard-window';
import { DEMO } from '../engine/demo';
import { HistoryStore } from './history-store';
import { log } from './log';
import { OverlayManager } from './overlay-manager';
import { SettingsStore } from './settings-store';
import { AppTray } from './tray';
import { WorkerHost } from './worker-host';

// Keep references so they aren't garbage-collected.
let tray: AppTray | null = null;
let overlays: OverlayManager | null = null;
let controller: Controller | null = null;
let worker: WorkerHost | null = null;

function overlayConfig(s: Settings): OverlayConfig {
  return {
    color: s.cursorColor,
    size: s.cursorSize,
    showLabels: s.showPointLabels,
    showCompanion: s.showCompanion,
    paused: s.paused,
  };
}

process.on('uncaughtException', (e) => log.error('uncaught exception', e.stack ?? String(e)));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e instanceof Error ? e.stack : String(e)));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('dev.clicky.desktop');

  app.whenReady().then(() => {
    log.info(`Clicky ${app.getVersion()} starting`);
    const platform = getPlatform();
    const settings = new SettingsStore();
    const credentials = new CredentialStore();
    const history = new HistoryStore();
    worker = new WorkerHost();
    void worker.start().catch((e: unknown) => log.error('worker failed to start', String(e)));
    overlays = new OverlayManager(platform, overlayConfig(settings.get()));
    overlays.start();
    // The shipped instruction pack (agents.md, skills, learned routes) before the stores read them.
    applyInstructionPack();
    controller = new Controller(platform, settings, credentials, history, overlays, worker);
    const dashboard = new DashboardWindow(settings, credentials, history, controller, worker);
    const ctl = controller;
    /** "Meet Clicky": the dashboard steps aside so Clicky sees (and can point at) the user's screen. */
    const hello = async (): Promise<void> => {
      const restore = dashboard.stepAside();
      try {
        await ctl.sayHello();
      } finally {
        setTimeout(restore, 1500);
      }
    };
    // Demo mode only: let the smoke-test harness drive the loop without a real keyboard.
    if (DEMO || process.env['CLICKY_TEST_HOOKS'] === '1')
      (globalThis as { __clicky?: unknown }).__clicky = { controller: ctl, dashboard, settings, history };

    tray = new AppTray({
      openDashboard: (page) => dashboard.open(page),
      holdKeyLabel: () => holdKeyLabel(settings.get().holdKey),
      paused: () => settings.get().paused,
      setPaused: (paused) => settings.update({ paused }),
      actions: () => history.listActions(),
      runAction: (id) => void dashboard.runAction(id),
      needsSetup: () => !settings.get().onboardingDone || ctl.missingKeys().length > 0,
      showDrawing: () => overlays?.sketch(),
      sayHello: () => void hello(),
    });
    controller.onState((s) => tray?.setState(s));
    history.onChange(() => tray?.refresh());
    credentials.onChange(() => tray?.refresh());
    ctl.hooks = {
      beforeListen: () => {
        if (dashboard.minimizeIfFocused())
          overlays?.message('Clicky hid its window to see your screen. It comes back after the answer.', 'info');
      },
      needKeys: () => dashboard.open('keys'),
      needAgentSetup: () => dashboard.open('agent'),
    };

    ctl.startHoldKey();
    ctl.syncMicArm();
    ctl.prewarm();
    ctl.applyLaunchAtLogin(settings.get().launchAtLogin);

    settings.onChange((next, prev) => {
      if (next.holdKey !== prev.holdKey) ctl.startHoldKey();
      if (next.launchAtLogin !== prev.launchAtLogin) ctl.applyLaunchAtLogin(next.launchAtLogin);
      if (next.paused && !prev.paused) ctl.cancel('paused');
      // Setup just finished: say hi, the way the official Clicky's first run does.
      if (next.onboardingDone && !prev.onboardingDone) setTimeout(() => void hello(), 800);
      if (
        next.micAlwaysReady !== prev.micAlwaysReady ||
        next.paused !== prev.paused ||
        next.micDeviceId !== prev.micDeviceId ||
        next.onboardingDone !== prev.onboardingDone
      ) {
        ctl.syncMicArm();
      }
      overlays?.setConfig(overlayConfig(next));
      tray?.refresh();
    });

    // First run, or a key the chosen providers need is missing: open the app on the setup wizard.
    if (!settings.get().onboardingDone || ctl.missingKeys().length > 0) {
      dashboard.open();
    } else if (Notification.isSupported()) {
      new Notification({
        title: 'Clicky is ready',
        body: `Hold ${holdKeyLabel(settings.get().holdKey)} and ask about anything on your screen.`,
        silent: true,
      }).show();
    }

    // Launching Clicky again (e.g. from the Start menu) opens the app instead of a second copy.
    app.on('second-instance', () => dashboard.open());
  });

  // Tray app: closing every window must not quit.
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    controller?.shutdown();
    overlays?.stop();
    worker?.destroy();
    tray?.destroy();
  });
}
