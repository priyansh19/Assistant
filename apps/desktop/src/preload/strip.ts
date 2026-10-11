import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel } from '../shared/ipc';

/** What the task strip shows. */
export interface StripState {
  goal: string;
  step: number;
  max: number;
  say: string;
  /** A risky step waiting for the user's OK. */
  ask: string | null;
  paused: boolean;
  /** The user's cursor colour, as the accent. */
  color: string;
}

// Channel names are inlined (type-checked against IpcChannel): sandboxed preloads can't share
// runtime modules, see electron.vite.config.ts.
const send = (channel: IpcChannel, ...args: unknown[]): void => ipcRenderer.send(channel, ...args);

const api = {
  onState(fn: (s: StripState) => void): void {
    const ch: IpcChannel = 'strip:state';
    ipcRenderer.on(ch, (_e, s: StripState) => fn(s));
  },
  pause: (on: boolean) => send('strip:pause', on),
  stop: () => send('strip:stop'),
  allow: () => send('strip:allow'),
};

export type StripApi = typeof api;

contextBridge.exposeInMainWorld('clickyStrip', api);
