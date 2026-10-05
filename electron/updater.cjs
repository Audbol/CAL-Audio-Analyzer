// Automatic updates from the GitHub releases (electron-updater). Downloads in the background and tells the app
// window when a new version is ready; it installs on restart. Not used in development, in the portable Windows
// .exe or outside an AppImage on Linux (they cannot replace themselves). macOS installs only signed updates.
'use strict';

const { app, ipcMain } = require('electron');

/** What the app shows in Tools → About & data and in the "update ready" button. */
let state = { status: 'idle', version: null, error: null, percent: 0 };
let updater = null;
let getWindow = () => null;

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
  if (!updater) return state;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', error: String((e && e.message) || e).split('\n')[0] });
  }
  return state;
}

function setupUpdater(windowGetter) {
  getWindow = windowGetter;
  ipcMain.handle('update:state', () => state);
  ipcMain.handle('update:check', () => check());
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
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // A beta or release candidate also gets newer betas; a stable version only stable releases
  updater.allowPrerelease = app.getVersion().includes('-');
  updater.logger = null;
  updater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  updater.on('update-not-available', () => set({ status: 'current' }));
  updater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  updater.on('error', (e) => set({ status: 'error', error: String((e && e.message) || e).split('\n')[0] }));
  // Shortly after start (not during it), then every six hours
  setTimeout(check, 20000);
  setInterval(check, 6 * 3600 * 1000);
}

module.exports = { setupUpdater };
