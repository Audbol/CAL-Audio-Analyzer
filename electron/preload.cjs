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
  nativeAudio: {
    /** Whether native audio (ASIO) can be used on this computer. */
    available: () => ipcRenderer.invoke('native-audio:available'),
    /** Ask for a connection to the audio host; the port arrives as a window message 'cal-native-audio-port'. */
    connect: () => ipcRenderer.send('native-audio:connect'),
  },
  window: {
    /** Keep a detached panel window (by its window name) on top of other windows. */
    pin: (name, on) => ipcRenderer.invoke('window:pin', name, on),
  },
  updates: {
    /** { status: 'unsupported' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error', version, error, percent } */
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    /** Restart into the downloaded version. */
    install: () => ipcRenderer.invoke('update:install'),
    onChange: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),
  },
});

// MessagePorts cannot cross the context bridge: hand them to the page with window.postMessage
ipcRenderer.on('native-audio:port', (e) => {
  window.postMessage('cal-native-audio-port', window.location.origin === 'null' ? '*' : window.location.origin, e.ports);
});
ipcRenderer.on('native-audio:exit', () => {
  window.postMessage('cal-native-audio-exit', window.location.origin === 'null' ? '*' : window.location.origin);
});
