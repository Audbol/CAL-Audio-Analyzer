// Preload: exposes a minimal, typed bridge for the remote-access server to the app page.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('calDesktop', {
  platform: process.platform,
  server: {
    /** Start the remote-access server. Resolves { port, token } for the host link. */
    start: (opts) => ipcRenderer.invoke('server:start', opts),
    stop: () => ipcRenderer.invoke('server:stop'),
    info: () => ipcRenderer.invoke('server:info'),
  },
});
