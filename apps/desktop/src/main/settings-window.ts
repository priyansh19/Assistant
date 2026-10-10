import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron';
import { CREDENTIAL_IDS, type CredentialId } from '@clicky/core';
import { IPC, type KeySetResult, type SettingsSnapshot } from '../shared/ipc';
import type { CredentialStore } from './credential-store';
import type { SettingsStore } from './settings-store';

/** The settings window: one instance, opened from the tray or on first run. */
export class SettingsWindow {
  private win: BrowserWindow | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
  ) {
    ipcMain.handle(IPC.settingsGet, (e) => this.guard(e, () => this.snapshot()));
    ipcMain.handle(IPC.settingsUpdate, (e, partial: unknown) =>
      this.guard(e, () => {
        this.settings.update(partial);
        return this.snapshot();
      }),
    );
    ipcMain.handle(IPC.keySet, (e, id: unknown, key: unknown) =>
      this.guard(e, (): KeySetResult => {
        if (!isCredentialId(id) || typeof key !== 'string') return { ok: false, reason: 'Invalid request.' };
        const r = this.credentials.set(id, key);
        return r.ok ? { ok: true, snapshot: this.snapshot() } : r;
      }),
    );
    ipcMain.handle(IPC.keyClear, (e, id: unknown) =>
      this.guard(e, () => {
        if (isCredentialId(id)) this.credentials.clear(id);
        return this.snapshot();
      }),
    );
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 820,
      height: 640,
      minWidth: 640,
      minHeight: 480,
      title: 'Clicky Settings',
      show: false,
      autoHideMenuBar: true,
      icon: join(app.getAppPath(), 'resources/icon.png'),
      // Matches the page background so there's no white flash in dark mode.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
      webPreferences: {
        preload: join(__dirname, '../preload/settings.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => (this.win = null));
    // Links open in the default browser, never inside the app.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/settings/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/settings/index.html'));
    }
    this.win = win;
  }

  private snapshot(): SettingsSnapshot {
    return {
      settings: this.settings.get(),
      keys: this.credentials.status(),
      encryptionAvailable: this.credentials.encryptionAvailable,
      appVersion: app.getVersion(),
    };
  }

  /** Only the settings window may call these handlers. */
  private guard<T>(e: IpcMainInvokeEvent, fn: () => T): T {
    if (!this.win || e.sender !== this.win.webContents) throw new Error('settings IPC from an unexpected sender');
    return fn();
  }
}

function isCredentialId(v: unknown): v is CredentialId {
  return typeof v === 'string' && (CREDENTIAL_IDS as readonly string[]).includes(v);
}
