import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron';
import { CREDENTIAL_IDS, type CredentialId } from '@clicky/core';
import { checkKey, defaultChatModel } from '@clicky/providers';
import {
  IPC,
  type ActionSaveResult,
  type DashboardSnapshot,
  type KeySetResult,
  type MicDevice,
  type TestResult,
} from '../shared/ipc';
import type { WorkerEvent } from '../shared/worker-protocol';
import type { Controller } from './controller';
import type { CredentialStore } from './credential-store';
import type { HistoryStore } from './history-store';
import { log } from './log';
import type { SettingsStore } from './settings-store';
import type { WorkerHost } from './worker-host';

/** Sites the dashboard may open in the browser (API key pages). */
const LINK_HOSTS = new Set([
  'console.anthropic.com',
  'openrouter.ai',
  'platform.openai.com',
  'www.assemblyai.com',
  'elevenlabs.io',
  'github.com',
]);

function isCredentialId(v: unknown): v is CredentialId {
  return typeof v === 'string' && (CREDENTIAL_IDS as readonly string[]).includes(v);
}

/** Wait for the dashboard to get out of the way before a screenshot is taken. */
const HIDE_BEFORE_CAPTURE_MS = 350;

/** The Clicky app window: setup wizard, home, history, actions and settings. */
export class DashboardWindow {
  private win: BrowserWindow | null = null;
  private micTestOff: (() => void) | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialStore,
    private readonly history: HistoryStore,
    private readonly controller: Controller,
    private readonly worker: WorkerHost,
  ) {
    const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
      ipcMain.handle(channel, (e, ...args) => this.guard(e, () => fn(...args)));
    };
    handle(IPC.dashGet, () => this.snapshot());
    handle(IPC.dashUpdate, (partial) => {
      this.settings.update(partial);
      return this.snapshot();
    });
    handle(IPC.dashKeySet, (id, key): KeySetResult => {
      if (!isCredentialId(id) || typeof key !== 'string') return { ok: false, reason: 'Invalid request.' };
      const r = this.credentials.set(id, key);
      return r.ok ? { ok: true, snapshot: this.snapshot() } : r;
    });
    handle(IPC.dashKeyClear, (id) => {
      if (isCredentialId(id)) this.credentials.clear(id);
      return this.snapshot();
    });
    handle(IPC.dashKeyTest, async (id): Promise<TestResult> => {
      if (!isCredentialId(id)) return { ok: false, message: 'Unknown provider.' };
      const key = this.credentials.get(id);
      if (!key) return { ok: false, message: 'No key saved yet.' };
      try {
        await checkKey(id, key, this.settings.get());
        return { ok: true, message: 'Key works.' };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`key test failed for ${id}`, msg);
        if (/\b(401|403)\b|invalid|unauthori[sz]ed|authentication/i.test(msg)) {
          return { ok: false, message: 'The key was rejected. Check that you copied all of it.' };
        }
        if (/\b404\b|not[_ ]found/i.test(msg))
          return { ok: false, message: `Key works, but the model wasn't found: ${msg.slice(0, 120)}` };
        if (/fetch failed|ENOTFOUND|ECONN|network/i.test(msg))
          return { ok: false, message: 'Could not reach the service. Check your internet connection.' };
        return { ok: false, message: msg.slice(0, 160) };
      }
    });
    handle(IPC.dashMicDevices, () => this.worker.request<MicDevice[]>({ op: 'mic.devices' }));
    handle(IPC.dashMicTest, async (on): Promise<TestResult> => {
      this.micTestOff?.();
      this.micTestOff = null;
      if (!on) {
        this.worker.send({ op: 'mic.stop' });
        return { ok: true, message: '' };
      }
      this.micTestOff = this.worker.on((e: WorkerEvent) => {
        if (e.type === 'mic.level' && this.win && !this.win.isDestroyed())
          this.win.webContents.send(IPC.dashMicLevel, e.level);
      });
      try {
        await this.worker.request({ op: 'mic.start', deviceId: this.settings.get().micDeviceId }, 8000);
        return { ok: true, message: 'Listening…' };
      } catch (e) {
        this.micTestOff?.();
        this.micTestOff = null;
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          message: /NotAllowed|Permission/i.test(msg)
            ? 'Windows is blocking the microphone. Open Settings > Privacy & security > Microphone and allow desktop apps.'
            : /NotFound|Overconstrained/i.test(msg)
              ? 'No microphone found. Plug one in or pick another device.'
              : msg,
        };
      }
    });
    handle(IPC.dashVoiceTest, async (): Promise<TestResult> => {
      try {
        await this.controller.speakSample();
        return { ok: true, message: 'Played a sample.' };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    });
    handle(IPC.dashAsk, async (question) => {
      if (typeof question !== 'string' || !question.trim()) return;
      await this.getOutOfTheWay();
      void this.controller.ask(question, 'typed');
    });
    handle(IPC.dashHistoryRemove, (id) => {
      if (typeof id === 'string') this.history.remove(id);
      return this.snapshot();
    });
    handle(IPC.dashHistoryClear, () => {
      this.history.clear();
      return this.snapshot();
    });
    handle(IPC.dashActionSave, (input): ActionSaveResult => {
      const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
      const r = this.history.saveAction({
        ...(typeof o['id'] === 'string' ? { id: o['id'] } : {}),
        name: typeof o['name'] === 'string' ? o['name'] : '',
        question: typeof o['question'] === 'string' ? o['question'] : '',
      });
      return 'error' in r ? { ok: false, reason: r.error } : { ok: true, action: r };
    });
    handle(IPC.dashActionRemove, (id) => {
      if (typeof id === 'string') this.history.removeAction(id);
      return this.snapshot();
    });
    handle(IPC.dashActionRun, async (id) => {
      if (typeof id !== 'string') return;
      await this.getOutOfTheWay();
      await this.runAction(id);
    });
    handle(IPC.dashOpenLink, (url) => {
      if (typeof url !== 'string') return;
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && LINK_HOSTS.has(u.hostname)) void shell.openExternal(u.toString());
      } catch {
        // not a URL
      }
    });

    const push = (): void => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IPC.dashChanged);
    };
    this.history.onChange(push);
    this.settings.onChange(push);
    this.controller.onState(push);
  }

  /** Run a saved action against whatever is on screen now. */
  async runAction(id: string): Promise<void> {
    const action = this.history.getAction(id);
    if (!action) return;
    this.history.markActionRun(id);
    await this.controller.ask(action.question, 'action');
  }

  open(page?: string): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      if (page) this.win.webContents.send(IPC.dashChanged, page);
      return;
    }
    const win = new BrowserWindow({
      width: 980,
      height: 700,
      minWidth: 720,
      minHeight: 520,
      title: 'Clicky',
      show: false,
      autoHideMenuBar: true,
      icon: join(app.getAppPath(), 'resources/icon.png'),
      // Matches the page background so there's no white flash in dark mode.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
      webPreferences: {
        preload: join(__dirname, '../preload/dashboard.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      this.micTestOff?.();
      this.micTestOff = null;
      this.win = null;
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    const query = page ? `?page=${encodeURIComponent(page)}` : '';
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/dashboard/index.html${query}`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/dashboard/index.html'), page ? { query: { page } } : {});
    }
    this.win = win;
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  /** Minimise the dashboard so the screenshot shows what the user is actually working on. */
  private async getOutOfTheWay(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible() && !this.win.isMinimized()) {
      this.win.minimize();
      await new Promise((r) => setTimeout(r, HIDE_BEFORE_CAPTURE_MS));
    }
  }

  private snapshot(): DashboardSnapshot {
    const s = this.settings.get();
    return {
      settings: s,
      keys: this.credentials.status(),
      encryptionAvailable: this.credentials.encryptionAvailable,
      appVersion: app.getVersion(),
      defaultModel: defaultChatModel(s.chatProvider),
      state: this.controller.orchestrator.state,
      missing: this.controller.missingKeys(s),
      stats: this.history.stats(),
      history: this.history.list().slice(0, 200),
      actions: this.history.listActions(),
    };
  }

  /** Only the dashboard window may call these handlers. */
  private guard<T>(e: IpcMainInvokeEvent, fn: () => T): T {
    if (!this.win || e.sender !== this.win.webContents) throw new Error('dashboard IPC from an unexpected sender');
    return fn();
  }
}
