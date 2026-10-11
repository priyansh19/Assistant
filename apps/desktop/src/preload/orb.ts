import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel } from '../shared/ipc';

// Channel names are inlined (type-checked against IpcChannel): sandboxed preloads can't share
// runtime modules, see electron.vite.config.ts.
const send = (channel: IpcChannel, ...args: unknown[]): void => ipcRenderer.send(channel, ...args);

const api = {
  hover: (on: boolean) => send('orb:hover', on),
  off: () => send('orb:off'),
};

export type OrbApi = typeof api;

contextBridge.exposeInMainWorld('clickyOrb', api);
