import { contextBridge, ipcRenderer } from 'electron';
import type { WorkerEvent, WorkerReply, WorkerRequest } from '../shared/worker-protocol';

// Channel names are inlined: sandboxed preloads can't share runtime modules (see electron.vite.config.ts).
const api = {
  onRequest(fn: (id: number, req: WorkerRequest) => void): void {
    ipcRenderer.on('worker:request', (_e, id: number, req: WorkerRequest) => fn(id, req));
  },
  reply(reply: WorkerReply): void {
    ipcRenderer.send('worker:reply', reply);
  },
  emit(event: WorkerEvent): void {
    ipcRenderer.send('worker:event', event);
  },
};

// A direct port to the engine process (architecture §4). MessagePorts can't cross the context
// bridge, so hand it to the page with window.postMessage, the pattern Electron documents.
ipcRenderer.on('worker:engine-port', (e) => {
  window.postMessage({ type: 'clicky-engine-port' }, '*', e.ports);
});

export type WorkerApi = typeof api;

contextBridge.exposeInMainWorld('clickyWorker', api);
