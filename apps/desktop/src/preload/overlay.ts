import { contextBridge, ipcRenderer } from 'electron';
import type { InteractionState } from '@clicky/core';
import type { IpcChannel, OverlayCursor } from '../shared/ipc';

const CURSOR: IpcChannel = 'overlay:cursor';
const STATE: IpcChannel = 'overlay:state';

const api = {
  onCursor(fn: (cursor: OverlayCursor) => void): void {
    ipcRenderer.on(CURSOR, (_e, cursor: OverlayCursor) => fn(cursor));
  },
  onState(fn: (state: InteractionState) => void): void {
    ipcRenderer.on(STATE, (_e, state: InteractionState) => fn(state));
  },
};

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('clicky', api);
