import { contextBridge, ipcRenderer } from 'electron';
import type { CredentialId, Settings } from '@clicky/core';
import type {
  ActionSaveResult,
  DashboardSnapshot,
  IpcChannel,
  KeySetResult,
  MicDevice,
  TestResult,
} from '../shared/ipc';

// Channel names are inlined (type-checked against IpcChannel): sandboxed preloads can't share
// runtime modules, see electron.vite.config.ts.
const invoke = <T>(channel: IpcChannel, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

const api = {
  get: () => invoke<DashboardSnapshot>('dash:get'),
  update: (partial: Partial<Settings>) => invoke<DashboardSnapshot>('dash:update', partial),
  setKey: (id: CredentialId, key: string) => invoke<KeySetResult>('dash:key-set', id, key),
  clearKey: (id: CredentialId) => invoke<DashboardSnapshot>('dash:key-clear', id),
  testKey: (id: CredentialId) => invoke<TestResult>('dash:key-test', id),
  micDevices: () => invoke<MicDevice[]>('dash:mic-devices'),
  micTest: (on: boolean) => invoke<TestResult>('dash:mic-test', on),
  voiceTest: () => invoke<TestResult>('dash:voice-test'),
  ask: (question: string) => invoke<undefined>('dash:ask', question),
  removeHistory: (id: string) => invoke<DashboardSnapshot>('dash:history-remove', id),
  clearHistory: () => invoke<DashboardSnapshot>('dash:history-clear'),
  saveAction: (a: { id?: string; name: string; question: string }) => invoke<ActionSaveResult>('dash:action-save', a),
  removeAction: (id: string) => invoke<DashboardSnapshot>('dash:action-remove', id),
  runAction: (id: string) => invoke<undefined>('dash:action-run', id),
  openLink: (url: string) => invoke<undefined>('dash:open-link', url),
  holdKeyTest: (on: boolean) => invoke<undefined>('dash:hold-key-test', on),
  tryIt: () => invoke<undefined>('dash:try-it'),
  diagnostics: () => invoke<string>('dash:diagnostics'),
  openLogs: () => invoke<undefined>('dash:open-logs'),
  onHoldKey(fn: (down: boolean) => void): void {
    const ch: IpcChannel = 'dash:hold-key';
    ipcRenderer.on(ch, (_e, down: boolean) => fn(down));
  },
  onChanged(fn: (page?: string) => void): void {
    const ch: IpcChannel = 'dash:changed';
    ipcRenderer.on(ch, (_e, page?: string) => fn(page));
  },
  onMicLevel(fn: (level: number) => void): void {
    const ch: IpcChannel = 'dash:mic-level';
    ipcRenderer.on(ch, (_e, level: number) => fn(level));
  },
};

export type DashboardApi = typeof api;

contextBridge.exposeInMainWorld('clickyApp', api);
