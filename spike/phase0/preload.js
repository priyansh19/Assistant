const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', {
  on: (ch, fn) => ipcRenderer.on(ch, (_e, v) => fn(v)),
  send: (ch, v) => ipcRenderer.send(ch, v),
});
