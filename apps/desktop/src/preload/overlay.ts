import { contextBridge, ipcRenderer } from 'electron';
import type { InteractionState } from '@clicky/core';
import type { IpcChannel } from '../shared/ipc';
import type {
  OverlayAnchor,
  OverlayConfig,
  OverlayCursor,
  OverlayDrawing,
  OverlayGuide,
  OverlayMessage,
  OverlayPoint,
} from '../shared/overlay-protocol';

// Channel names are inlined (type-checked against IpcChannel): sandboxed preloads can't share
// runtime modules, see electron.vite.config.ts.
const on = <T>(channel: IpcChannel, fn: (v: T) => void): void => {
  ipcRenderer.on(channel, (_e, v: T) => fn(v));
};

const api = {
  onCursor: (fn: (c: OverlayCursor) => void) => on('overlay:cursor', fn),
  onState: (fn: (s: InteractionState) => void) => on('overlay:state', fn),
  onPoint: (fn: (p: OverlayPoint) => void) => on('overlay:point', fn),
  onDraw: (fn: (d: OverlayDrawing) => void) => on('overlay:draw', fn),
  onAnchor: (fn: (a: OverlayAnchor) => void) => on('overlay:anchor', fn),
  /** A walkthrough step's ring (null clears it). */
  onGuide: (fn: (g: OverlayGuide) => void) => on('overlay:guide', fn),
  /** The display whose overlay shows the companion right now; null means wherever the pointer is. */
  onOwner: (fn: (displayId: number | null) => void) => on('overlay:owner', fn),
  onMessage: (fn: (m: OverlayMessage) => void) => on('overlay:message', fn),
  onLevel: (fn: (level: number) => void) => on('overlay:level', fn),
  onConfig: (fn: (c: OverlayConfig) => void) => on('overlay:config', fn),
};

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('clicky', api);
