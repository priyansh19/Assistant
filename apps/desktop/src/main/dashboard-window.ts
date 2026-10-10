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
  type TryResult,
} from '../shared/ipc';
import type { WorkerEvent } from '../shared/worker-protocol';
import type { Controller } from './controller';
import type { CredentialStore } from './credential-store';
import type { HistoryStore } from './history-store';
import { log, redact } from './log';
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

const BILLING_PAGES: Partial<Record<CredentialId, string>> = {
  anthropic: 'console.anthropic.com → Billing',
  openai: 'platform.openai.com → Billing',
  openrouter: 'openrouter.ai → Credits',
  elevenlabs: 'elevenlabs.io → Subscription',
  assemblyai: 'assemblyai.com → Billing',
};

function isCredentialId(v: unknown): v is CredentialId {
  return typeof v === 'string' && (CREDENTIAL_IDS as readonly string[]).includes(v);
}

type KeyFailure = Extract<TestResult, { ok: false }>;
const failure = (kind: NonNullable<KeyFailure['kind']>, message: string): KeyFailure => ({ ok: false, kind, message });

/**
 * Turn a key-check failure into something the user can act on. Only `invalid` means the key itself
 * is wrong; billing, model and network problems are warnings that must not block setup.
 */
export function explainKeyError(id: CredentialId, msg: string): KeyFailure {
  // Billing first: Anthropic labels these invalid_request_error, which would read as "bad key".
  if (/credit|quota|billing|insufficient|payment|balance|\b402\b/i.test(msg)) {
    return failure(
      'billing',
      `The key is valid, but the account has no credit. Add billing at ${BILLING_PAGES[id] ?? 'the provider'}.`,
    );
  }
  if (/\b429\b|rate.?limit/i.test(msg)) {
    return failure('transient', 'The key works but is being rate limited right now. Try again in a minute.');
  }
  if (/\b(401|403)\b|unauthori[sz]ed|authentication|invalid.?(api.?)?key|invalid x-api-key/i.test(msg)) {
    return failure('invalid', 'The key was rejected. Check that you copied all of it, or create a new one.');
  }
  if (/\b404\b|not[_ ]found|model/i.test(msg) && id !== 'assemblyai' && id !== 'elevenlabs') {
    return failure(
      'model',
      "The key works, but the model wasn't found. Clear the Model field in AI and voice to use the default.",
    );
  }
  if (/fetch failed|ENOTFOUND|ECONN|network|socket|timed out/i.test(msg)) {
    return failure('transient', 'Could not reach the service. Check your internet connection.');
  }
  return failure('transient', `The check failed: ${msg.slice(0, 140)}`);
}

/** Wait for the dashboard to get out of the way before a screenshot is taken. */
const HIDE_BEFORE_CAPTURE_MS = 350;

/** The Clicky app window: setup wizard, home, history, actions and settings. */
export class DashboardWindow {
  private win: BrowserWindow | null = null;
  private micTestOff: (() => void) | null = null;
  private micTesting = false;

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
        return explainKeyError(id, msg);
      }
    });
    handle(IPC.dashMicDevices, () => this.worker.request<MicDevice[]>({ op: 'mic.devices' }));
    handle(IPC.dashMicTest, async (on): Promise<TestResult> => {
      this.micTestOff?.();
      this.micTestOff = null;
      if (!on) {
        this.stopMicTest();
        return { ok: true, message: '' };
      }
      this.micTestOff = this.worker.on((e: WorkerEvent) => {
        if (e.type === 'mic.level' && this.win && !this.win.isDestroyed()) {
          this.win.webContents.send(IPC.dashMicLevel, e.level);
        }
      });
      try {
        this.micTesting = true;
        await this.worker.request({ op: 'mic.start', deviceId: this.settings.get().micDeviceId, owner: 'test' }, 8000);
        return { ok: true, message: 'Listening…' };
      } catch (e) {
        this.stopMicTest();
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          message: /NotAllowed|Permission/i.test(msg)
            ? 'Windows is blocking the microphone. Open Settings > Privacy & security > Microphone and turn on "Let desktop apps access your microphone".'
            : /NotFound|Overconstrained/i.test(msg)
              ? 'No microphone found. Plug one in or pick another device.'
              : /NotReadable|in use/i.test(msg)
                ? 'Another app is using the microphone exclusively. Close it and try again.'
                : 'The microphone could not start. Try another device, or restart Clicky.',
        };
      }
    });
    handle(IPC.dashVoiceTest, async (): Promise<TestResult> => {
      try {
        await this.controller.speakSample();
        return { ok: true, message: 'Played a sample.' };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn('voice test failed', msg);
        const tts = this.settings.get().ttsProvider;
        if (/\b(401|403)\b/.test(msg))
          return { ok: false, message: 'The voice key was rejected. Check it in API keys.' };
        if (/credit|quota|\b402\b|\b429\b/i.test(msg))
          return { ok: false, message: 'The voice account is out of credit or rate limited.' };
        if (/Add your .* key/i.test(msg)) return { ok: false, message: msg };
        if (tts === 'system') return { ok: false, message: 'The Windows voice did not play. Check that sound is on.' };
        return { ok: false, message: `The voice did not play: ${msg.slice(0, 120)}` };
      }
    });
    handle(IPC.dashAsk, async (question) => {
      if (typeof question !== 'string' || !question.trim()) return;
      void this.whileHidden(() => this.controller.ask(question, 'typed'));
    });
    handle(IPC.dashTryIt, (): Promise<TryResult | null> =>
      this.whileHidden(() => this.controller.ask('What am I looking at?', 'typed')),
    );
    handle(IPC.dashHoldKeyTest, (on) => {
      this.controller.setKeyTest(
        on
          ? (down) => {
              if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IPC.dashHoldKey, down);
            }
          : null,
      );
    });
    handle(IPC.dashDiagnostics, () => this.diagnostics());
    handle(IPC.dashOpenLogs, () => void shell.openPath(join(app.getPath('userData'), 'logs')));
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
    handle(IPC.dashActionRun, (id) => {
      if (typeof id !== 'string') return;
      void this.runAction(id);
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
    this.credentials.onChange(push);
    this.controller.onState(push);
  }

  /** Run a saved action against whatever is on screen now (from the dashboard or the tray). */
  async runAction(id: string): Promise<void> {
    const action = this.history.getAction(id);
    if (!action) return;
    this.history.markActionRun(id);
    await this.whileHidden(() => this.controller.ask(action.question, 'action'));
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
      height: 720,
      minWidth: 720,
      minHeight: 540,
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
      this.stopMicTest();
      this.controller.setKeyTest(null);
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

  /** On a voice question: if the Clicky window is in front, minimise it so the screenshot shows the user's work. */
  minimizeIfFocused(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isFocused() && !this.win.isMinimized()) this.win.minimize();
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  private stopMicTest(): void {
    this.micTestOff?.();
    this.micTestOff = null;
    if (this.micTesting) {
      this.micTesting = false;
      this.worker.send({ op: 'mic.stop', owner: 'test' });
    }
  }

  /**
   * Minimise the dashboard so the screenshot shows what the user is working on, run the question,
   * then bring the window back so the answer shows up in History and the stats.
   */
  private async whileHidden<T>(fn: () => Promise<T>): Promise<T> {
    const win = this.win;
    const hid = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    if (hid) {
      win.minimize();
      await new Promise((r) => setTimeout(r, HIDE_BEFORE_CAPTURE_MS));
    }
    try {
      return await fn();
    } finally {
      if (hid) {
        setTimeout(() => {
          // Only if nothing newer started meanwhile (a newer question owns the screen).
          if (!win.isDestroyed() && win.isMinimized() && this.controller.orchestrator.state === 'idle') win.restore();
        }, 1200);
      }
    }
  }

  private diagnostics(): string {
    const s = this.settings.get();
    const keys = this.credentials.status();
    const stats = this.history.stats();
    const recent = this.history
      .list()
      .slice(0, 10)
      .map(
        (e) =>
          `  ${new Date(e.at).toISOString()} ${e.source} ${e.outcome}${e.detail ? ` (${e.detail})` : ''}${
            typeof e.keyUpToFirstAudioMs === 'number' ? ` first audio ${e.keyUpToFirstAudioMs} ms` : ''
          }`,
      );
    const lines = [
      `Clicky ${app.getVersion()} (Electron ${process.versions.electron}, Windows ${process.getSystemVersion()})`,
      `Answer: ${s.chatProvider} ${s.chatModel || `(default ${defaultChatModel(s.chatProvider)})`}`,
      `Speech to text: ${s.sttProvider}; voice: ${s.ttsProvider}`,
      `Keys saved: ${CREDENTIAL_IDS.filter((id) => keys[id]).join(', ') || 'none'}`,
      `Hold key: ${s.holdKey}; mic: ${s.micDeviceId ? 'custom' : 'default'}, keep ready ${s.micAlwaysReady}; paused ${s.paused}`,
      `Screenshots: ${s.captureMaxEdge} px, all displays ${s.captureAllDisplays}`,
      `Response time (key up → first audio): last ${stats.lastMs ?? '–'} ms, typical ${stats.p50Ms ?? '–'} ms, p95 ${stats.p95Ms ?? '–'} ms`,
      'Recent questions (no text):',
      ...recent,
    ];
    return redact(lines.join('\n'));
  }

  private snapshot(): DashboardSnapshot {
    const s = this.settings.get();
    return {
      settings: s,
      keys: this.credentials.status(),
      keyHints: this.credentials.hints(),
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
