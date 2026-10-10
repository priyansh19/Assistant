import { contextBridge, ipcRenderer } from 'electron';
import type { InteractionState } from '@clicky/core';
import { IPC, type OverlayCursor } from '../shared/ipc';

const api = {
  onCursor(fn: (cursor: OverlayCursor) => void): void {
    ipcRenderer.on(IPC.overlayCursor, (_e, cursor: OverlayCursor) => fn(cursor));
  },
  onState(fn: (state: InteractionState) => void): void {
    ipcRenderer.on(IPC.overlayState, (_e, state: InteractionState) => fn(state));
  },
};

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('clicky', api);
