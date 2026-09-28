// CAL Audio Analyzer remote-access hub.
//
// Serves the web app over HTTP to other devices on the network and relays a WebSocket link between the
// measurement host (the app instance with the audio interface) and any number of remote browsers:
//   host  → remotes : live audio blocks (binary), status (JSON), per-client events
//   remote → host   : commands (JSON: generator, start, stop playback) and sweep playback buffers (binary)
// Remote clients run the full analyzer on the streamed audio, so every view and meter works remotely.
//
// Used by the Electron main process (electron/main.cjs) and by the standalone CLI (server/cli.mjs).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

/** Slow clients get audio dropped rather than growing unbounded buffers (they re-sync automatically). */
const MAX_BUFFERED = 4 * 1024 * 1024;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ address: a.address, iface: name });
    }
  }
  // Prefer typical private LAN ranges first
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Host names the server answers to: localhost, IP addresses and this computer's own names (blocks DNS rebinding). */
function allowedHostHeader(hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 clients
  let name = String(hostHeader).toLowerCase();
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']'));
  else name = name.replace(/:\d+$/, '');
  if (name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true;
  const own = os.hostname().toLowerCase();
  return name === own || name === `${own}.local` || name === own.split('.')[0] || name === `${own.split('.')[0]}.local`;
}

/** The host page is this app itself: the desktop app (app://cal) or the loopback /host page. */
function allowedHostOrigin(origin) {
  if (!origin) return true; // not a browser
  // The desktop app, or a page on this computer (the /host page, or the development server)
  return origin === 'app://cal' || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{ distDir: string, port?: number, pin?: string, allowControl?: boolean, version?: string,
 *           log?: (msg: string) => void }} options
 */
function createHub(options) {
  const distDir = path.resolve(options.distDir);
  const hostToken = crypto.randomBytes(24).toString('hex');
  const state = {
    port: options.port || 8520,
    pin: options.pin == null ? '' : String(options.pin),
    allowControl: options.allowControl !== false,
    version: options.version || '',
  };
  const log = options.log || (() => undefined);
  let server = null;
  let wss = null;
  let host = null;
  let lastStatus = null;
  /** Latest shared session state, replayed to devices that connect later. */
  let lastTraces = null;
  let lastSweep = null;
  let nextId = 1;
  const remotes = new Map(); // id -> { ws, name, address, dropped }
  const failures = new Map(); // ip -> { count, until }

  // ---------------------------------------------------------------------------------------------------
  // HTTP: the app itself (with the client role injected) and a small info endpoint

  function sendIndex(res, role) {
    fs.readFile(path.join(distDir, 'index.html'), 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('CAL Audio Analyzer: app files not found. Build the app first (npm run build).');
        return;
      }
      const hub = role === 'host' ? { role: 'host', port: state.port, token: hostToken } : { role: 'remote' };
      const inject = `<script>window.CAL_HUB=${JSON.stringify(hub)}</script>`;
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(html.replace('<head>', `<head>${inject}`));
    });
  }

  function onRequest(req, res) {
    if (!allowedHostHeader(req.headers.host)) {
      res.writeHead(421, { 'content-type': 'text/plain' });
      res.end('Unknown host name. Open the app by its IP address.');
      return;
    }
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://x');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/info') {
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ app: 'CAL Audio Analyzer', version: state.version, hostConnected: !!host, clients: remotes.size, pinRequired: !!state.pin }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return sendIndex(res, 'remote');
    // The measurement host page is only served to this computer itself
    if (url.pathname === '/host') {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('The host page is only available on the computer running the server.');
        return;
      }
      return sendIndex(res, 'host');
    }
    const file = path.normalize(path.join(distDir, pathname));
    if (!file.startsWith(distDir + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        // Unknown paths fall back to the app (e.g. links with query strings)
        if (!path.extname(file)) return sendIndex(res, 'remote');
        res.writeHead(404).end();
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(data);
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // WebSocket relay

  function send(ws, data) {
    if (ws && ws.readyState === 1) ws.send(data);
  }

  function clientList() {
    return [...remotes.entries()].map(([id, c]) => ({ id, name: c.name, address: c.address, since: c.since, analysis: c.analysis }));
  }

  function hubInfo() {
    return {
      t: 'hub',
      port: state.port,
      pin: state.pin,
      allowControl: state.allowControl,
      urls: lanAddresses().map((a) => ({ url: `http://${a.address}:${state.port}/`, iface: a.iface })),
      hostname: os.hostname(),
      clients: clientList(),
    };
  }

  function notifyHost() {
    send(host, JSON.stringify(hubInfo()));
  }

  function acceptHost(ws) {
    if (host) host.close(4000, 'Replaced by a new host connection');
    host = ws;
    log('host connected');
    notifyHost();
    for (const c of remotes.values()) send(c.ws, JSON.stringify({ t: 'host', connected: true }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Byte 12 is the message type: 1 = sweep result (never dropped, cached for late joiners)
        if (data.length > 12 && data[12] === 1) {
          lastSweep = data;
          for (const c of remotes.values()) send(c.ws, data);
          return;
        }
        // Analysis frames (host-processing mode): only to the devices that asked; a newer one replaces a late one
        if (data.length > 12 && data[12] === 2) {
          for (const c of remotes.values()) {
            if (!c.analysis || c.ws.readyState !== 1 || c.ws.bufferedAmount > MAX_BUFFERED / 8) continue;
            c.ws.send(data, { binary: true });
          }
          return;
        }
        // Live audio: fan out to every remote, dropping blocks for clients that can't keep up
        for (const c of remotes.values()) {
          if (c.ws.readyState !== 1) continue;
          if (c.ws.bufferedAmount > MAX_BUFFERED) {
            c.dropped++;
            continue;
          }
          c.ws.send(data, { binary: true });
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === 'status') {
        lastStatus = JSON.stringify(msg);
        for (const c of remotes.values()) send(c.ws, lastStatus);
      } else if (msg.t === 'traces') {
        lastTraces = JSON.stringify(msg);
        for (const c of remotes.values()) send(c.ws, lastTraces);
      } else if (msg.t === 'sweepProgress') {
        const text = JSON.stringify(msg);
        for (const c of remotes.values()) send(c.ws, text);
      } else if (msg.t === 'event' && remotes.has(msg.to)) {
        send(remotes.get(msg.to).ws, JSON.stringify(msg));
      } else if (msg.t === 'config') {
        if (typeof msg.pin === 'string') state.pin = msg.pin;
        if (typeof msg.allowControl === 'boolean') state.allowControl = msg.allowControl;
        for (const c of remotes.values()) send(c.ws, JSON.stringify({ t: 'control', allowControl: state.allowControl }));
        notifyHost();
      }
    });
    ws.on('close', () => {
      if (host !== ws) return;
      host = null;
      lastStatus = null;
      log('host disconnected');
      // Traces and the last sweep stay available until the host reconnects and republishes them
      for (const c of remotes.values()) send(c.ws, JSON.stringify({ t: 'host', connected: false }));
    });
  }

  function acceptRemote(ws, req, name) {
    const id = nextId++;
    const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const client = { ws, name: String(name || 'Remote').slice(0, 40), address, since: Date.now(), dropped: 0, analysis: false };
    remotes.set(id, client);
    log(`remote ${id} connected from ${address}`);
    send(ws, JSON.stringify({ t: 'welcome', id, allowControl: state.allowControl, hostConnected: !!host }));
    if (lastStatus) send(ws, lastStatus);
    if (lastTraces) send(ws, lastTraces);
    if (lastSweep) send(ws, lastSweep);
    notifyHost();
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.length < 200) {
        // Stream preferences are handled by the hub itself (they also work while the host is away)
        let p = null;
        try {
          p = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (p && p.t === 'prefs') {
          client.analysis = !!p.analysis;
          notifyHost();
          return;
        }
      }
      if (!host) return send(ws, JSON.stringify({ t: 'error', message: 'The measurement host is not connected.' }));
      if (isBinary) {
        // Sweep playback buffer: prefix the sender id so the host can reply to the right client
        if (!state.allowControl) return send(ws, JSON.stringify({ t: 'error', message: 'Remote control is disabled on the host.' }));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(id, 0);
        send(host, Buffer.concat([prefix, Buffer.from(data)]));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t !== 'cmd') return;
      if (!state.allowControl && msg.cmd !== 'hello') {
        return send(ws, JSON.stringify({ t: 'error', message: 'Remote control is disabled on the host.' }));
      }
      msg.from = id;
      send(host, JSON.stringify(msg));
    });
    // Report dropped audio so the remote can warn about a slow network
    const timer = setInterval(() => {
      if (client.dropped) {
        send(ws, JSON.stringify({ t: 'dropped', blocks: client.dropped }));
        client.dropped = 0;
      }
    }, 2000);
    ws.on('close', () => {
      clearInterval(timer);
      remotes.delete(id);
      log(`remote ${id} disconnected`);
      notifyHost();
    });
  }

  function onUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return socket.destroy();
    }
    if (url.pathname !== '/ws' || !allowedHostHeader(req.headers.host)) return socket.destroy();
    const ip = String(req.socket.remoteAddress);
    const role = url.searchParams.get('role');
    const origin = req.headers.origin;
    // Browsers send an Origin: a web page from another site must not open a connection (cross-site WebSocket)
    if (role === 'host' && !allowedHostOrigin(origin)) return socket.destroy();
    if (role !== 'host' && origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        sameHost = false;
      }
      if (!sameHost) return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === 'host') {
        if (!safeEqual(url.searchParams.get('token') || '', hostToken)) return ws.close(4003, 'Invalid host token');
        return acceptHost(ws);
      }
      const now = Date.now();
      const f = failures.get(ip);
      if (f && f.until > now) return ws.close(4029, 'Too many wrong PIN attempts. Wait a minute and try again.');
      if (state.pin && !safeEqual(url.searchParams.get('pin') || '', state.pin)) {
        // Count wrong PINs per address over a one-minute window; 8 of them lock the address out for a minute
        const rec = f && now - f.first < 60000 ? f : { count: 0, first: now, until: 0 };
        rec.count++;
        if (rec.count >= 8) rec.until = now + 60000;
        failures.set(ip, rec);
        if (failures.size > 10000) failures.clear(); // bound memory under a flood of addresses
        return ws.close(4001, 'Wrong PIN');
      }
      failures.delete(ip);
      acceptRemote(ws, req, url.searchParams.get('name'));
    });
  }

  // ---------------------------------------------------------------------------------------------------

  return {
    hostToken,
    /** Start listening on all interfaces. Resolves with the port actually used. */
    start(port) {
      if (port) state.port = port;
      return new Promise((resolve, reject) => {
        server = http.createServer(onRequest);
        wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
        server.on('upgrade', onUpgrade);
        server.once('error', reject);
        server.listen(state.port, '0.0.0.0', () => {
          server.off('error', reject);
          log(`listening on port ${state.port}`);
          resolve({ port: state.port, token: hostToken });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const c of remotes.values()) c.ws.close(1001, 'Server stopped');
        if (host) host.close(1001, 'Server stopped');
        remotes.clear();
        host = null;
        if (wss) wss.close();
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
        server = null;
      });
    },
    setOptions(o) {
      if (typeof o.pin === 'string') state.pin = o.pin;
      if (typeof o.allowControl === 'boolean') state.allowControl = o.allowControl;
      notifyHost();
    },
    info() {
      const i = hubInfo();
      return { ...i, running: !!server, hostConnected: !!host };
    },
    lanAddresses,
  };
}

module.exports = { createHub, lanAddresses };
