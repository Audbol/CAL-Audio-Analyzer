// Electron main process: runs CAL Audio Analyzer as a standalone desktop application.
'use strict';

const { app, BrowserWindow, Menu, protocol, session, shell, net, ipcMain, utilityProcess, MessageChannelMain } = require('electron');
const { setupUpdater } = require('./updater.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHub } = require('./hub.cjs');

const SCHEME = 'app';
const HOST = 'cal';
const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.CAL_DEV_URL; // e.g. http://localhost:5173 while developing

// A privileged custom scheme gives the app a stable, secure origin: required for microphone access
// (getUserMedia), AudioWorklet modules and persistent localStorage (settings and traces).
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Measurement audio must never be throttled or processed by the OS voice pipeline
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Keep drawing when a window is covered by another (e.g. a detached meter full screen over the main window)
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// A second launch only brings the running app to the front (see 'second-instance'); it sets nothing up itself
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

let win = null;
/** Detached panel windows by frame name (cal-panel-<id>). */
const panelWindows = new Map();
/** Remote-access server (created on demand from the app's Tools → Remote access). */
let hub = null;

function registerServerIpc() {
  // Only the main app window may control the server
  const fromApp = (e) => win && e.sender === win.webContents;
  ipcMain.handle('server:start', async (e, opts = {}) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    if (hub) await hub.stop();
    hub = createHub({
      distDir: DIST,
      pin: typeof opts.pin === 'string' ? opts.pin : '',
      allowControl: opts.allowControl !== false,
      version: app.getVersion(),
      log: (m) => console.log(`[remote] ${m}`),
    });
    try {
      return await hub.start(Number(opts.port) || 8520);
    } catch (err) {
      hub = null;
      throw new Error(err && err.code === 'EADDRINUSE' ? `Port ${opts.port} is already in use. Choose another port.` : String(err && err.message ? err.message : err));
    }
  });
  ipcMain.handle('server:stop', async (e) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    if (hub) await hub.stop();
    hub = null;
    return true;
  });
  // Detached panel windows: keep on top of other windows ("pin")
  ipcMain.handle('window:pin', (e, name, on) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    const child = panelWindows.get(String(name));
    if (!child || child.isDestroyed()) return false;
    child.setAlwaysOnTop(!!on, 'floating');
    return true;
  });
  ipcMain.handle('server:info', (e) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    return hub ? hub.info() : { running: false };
  });
}

// Native audio (ASIO on Windows): a utility process runs the native module and the signal generator, and talks
// to the app page directly over a MessagePort. CAL_NATIVE_TEST=1 enables a virtual test device on any system.
let audioHost = null;

function nativeAddonPath() {
  const rel = path.join('native', 'build', 'Release', 'cal_audio.node');
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'app.asar.unpacked', rel), path.join(process.resourcesPath, rel)]
    : [path.join(__dirname, '..', rel)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function nativeAudioAvailable() {
  return (process.platform === 'win32' || process.env.CAL_NATIVE_TEST === '1') && !!nativeAddonPath();
}

function startAudioHost() {
  if (audioHost) return audioHost;
  const addon = nativeAddonPath();
  // Run the host from outside the app archive when packaged (see asarUnpack in package.json)
  const script = path.join(__dirname, '..', 'dist-electron', 'native-host.cjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  audioHost = utilityProcess.fork(script, [], {
    serviceName: 'CAL audio host',
    env: { ...process.env, CAL_NATIVE_ADDON: addon || '' },
    stdio: 'inherit',
  });
  audioHost.on('exit', (code) => {
    console.log(`[audio] host exited (${code})`);
    audioHost = null;
    // Tell the page, which falls back to its own audio and can reconnect
    if (win && !win.isDestroyed()) win.webContents.send('native-audio:exit', code);
  });
  return audioHost;
}

function registerNativeAudioIpc() {
  const fromApp = (e) => win && e.sender === win.webContents;
  ipcMain.handle('native-audio:available', (e) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    return nativeAudioAvailable();
  });
  // Connect the page to the audio host: each side gets one end of a new channel
  ipcMain.on('native-audio:connect', (e) => {
    if (!fromApp(e) || !nativeAudioAvailable()) return;
    const host = startAudioHost();
    const { port1, port2 } = new MessageChannelMain();
    host.postMessage({ type: 'connect' }, [port2]);
    e.sender.postMessage('native-audio:port', null, [port1]);
  });
}

function serveDist() {
  protocol.handle(SCHEME, (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    // Never serve anything outside the bundled app
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#000000',
    title: 'CAL Audio Analyzer',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  win.once('ready-to-show', () => win.show());

  // Keep navigation inside the app; open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Detached measurement panels: blank same-origin windows that the app fills itself
    if (url === 'about:blank' || url === '') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          minWidth: 320,
          minHeight: 200,
          icon: path.join(__dirname, '..', 'build', 'icon.png'),
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
        },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    const name = details.frameName || '';
    if (!name.startsWith('cal-panel-')) return;
    panelWindows.set(name, child);
    child.on('closed', () => {
      if (panelWindows.get(name) === child) panelWindows.delete(name);
    });
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://`) && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault();
  });

  win.loadURL(DEV_URL || `${SCHEME}://${HOST}/index.html`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/Audbol/CAL-Audio-Analyzer') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  // Allow microphone / audio-interface access for the app itself only
  const trusted = (origin) => origin.startsWith(`${SCHEME}://${HOST}`) || (DEV_URL && origin.startsWith(DEV_URL));
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    callback(trusted(origin) && ['media', 'audioCapture', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => trusted(origin || '') && ['media', 'audioCapture', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));

  serveDist();
  registerServerIpc();
  registerNativeAudioIpc();
  setupUpdater(() => win);
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (hub) hub.stop();
  if (audioHost) audioHost.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
