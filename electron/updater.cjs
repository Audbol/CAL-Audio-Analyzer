// Updates from the GitHub releases (electron-updater). Nothing happens on its own: the app is used in live and
// critical work, so a new version is only looked for when the user asks (or turns on automatic checks), only
// downloaded when they press Download, and only installed when they press Restart to update. Not used in
// development, in the portable Windows .exe or outside an AppImage on Linux (they cannot replace themselves).
// macOS installs only signed updates.
'use strict';

const { app, ipcMain } = require('electron');

/**
 * What the app shows in Tools → About & data and in the "update ready" button. `auto`: checks by themselves
 * (off unless the user turns them on; they only notify, never download).
 */
let state = { status: 'idle', version: null, error: null, percent: 0, auto: false };
let updater = null;
let getWindow = () => null;
let timers = [];

function supported() {
  if (!app.isPackaged || process.env.CAL_NO_UPDATES) return false;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return false;
  if (process.platform === 'linux' && !process.env.APPIMAGE) return false;
  return true;
}

function set(patch) {
  state = { ...state, ...patch };
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
}

async function check() {
  // A found or downloaded version stays as it is: checking again would only repeat it
  if (!updater || ['checking', 'downloading', 'ready'].includes(state.status)) return state;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', error: String((e && e.message) || e).split('\n')[0] });
  }
  return state;
}

async function download() {
  if (!updater || state.status !== 'available') return state;
  set({ status: 'downloading', percent: 0 });
  try {
    await updater.downloadUpdate();
  } catch (e) {
    set({ status: 'error', error: String((e && e.message) || e).split('\n')[0] });
  }
  return state;
}

/** Automatic checks on or off (the app's setting, sent at start and when it changes). */
function setAuto(on) {
  on = !!on;
  for (const t of timers) clearTimeout(t), clearInterval(t);
  timers = [];
  state = { ...state, auto: on };
  if (on && updater) {
    // Shortly after start (not during it), then every six hours
    timers.push(setTimeout(check, 20000), setInterval(check, 6 * 3600 * 1000));
  }
  return state;
}

function setupUpdater(windowGetter) {
  getWindow = windowGetter;
  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:download', () => download());
  ipcMain.handle('update:auto', (_e, on) => setAuto(on));
  ipcMain.handle('update:install', () => {
    if (state.status === 'ready' && updater) setImmediate(() => updater.quitAndInstall(false, true));
    return state.status === 'ready';
  });
  if (!supported()) {
    state = { ...state, status: 'unsupported' };
    return;
  }
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    state = { ...state, status: 'unsupported', error: String(e) };
    return;
  }
  // Never download or install by itself
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // A beta or release candidate also gets newer betas; a stable version only stable releases
  updater.allowPrerelease = app.getVersion().includes('-');
  updater.logger = null;
  updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  updater.on('update-not-available', () => set({ status: 'current' }));
  updater.on('update-available', (info) => set({ status: 'available', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  updater.on('error', (e) => set({ status: 'error', error: String((e && e.message) || e).split('\n')[0] }));
}

module.exports = { setupUpdater };
