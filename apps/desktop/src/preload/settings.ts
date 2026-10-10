import { contextBridge, ipcRenderer } from 'electron';
import type { CredentialId, Settings } from '@clicky/core';
import type { IpcChannel, KeySetResult, SettingsSnapshot } from '../shared/ipc';

const GET: IpcChannel = 'settings:get';
const UPDATE: IpcChannel = 'settings:update';
const KEY_SET: IpcChannel = 'settings:key-set';
const KEY_CLEAR: IpcChannel = 'settings:key-clear';

const api = {
  get: (): Promise<SettingsSnapshot> => ipcRenderer.invoke(GET),
  update: (partial: Partial<Settings>): Promise<SettingsSnapshot> => ipcRenderer.invoke(UPDATE, partial),
  setKey: (id: CredentialId, key: string): Promise<KeySetResult> => ipcRenderer.invoke(KEY_SET, id, key),
  clearKey: (id: CredentialId): Promise<SettingsSnapshot> => ipcRenderer.invoke(KEY_CLEAR, id),
};

export type SettingsApi = typeof api;

contextBridge.exposeInMainWorld('clickySettings', api);
