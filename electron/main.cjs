// Electron main process: runs CAL Audio Analyzer as a standalone desktop application.
'use strict';

const { app, BrowserWindow, Menu, protocol, session, shell, net } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function serveDist() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    // Never serve anything outside the bundled app
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
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
    },
  });
  win.once('ready-to-show', () => win.show());

  // Keep navigation inside the app; open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
  // Allow microphone / audio-interface access for the app itself only
  const trusted = (origin) => origin.startsWith(`${SCHEME}://${HOST}`) || (DEV_URL && origin.startsWith(DEV_URL));
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    callback(trusted(origin) && ['media', 'audioCapture', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => trusted(origin || '') && ['media', 'audioCapture', 'speaker-selection', 'clipboard-sanitized-write'].includes(permission));

  serveDist();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
