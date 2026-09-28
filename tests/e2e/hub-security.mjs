// Security checks for the remote-access server: PIN lockout, malformed URLs, DNS rebinding and cross-site
// WebSocket connections. Usage: node tests/e2e/hub-security.mjs (needs a build in dist/)
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { createHub } = require('../../electron/hub.cjs');
const WebSocket = require('ws');
const PORT = 8599;
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const hub = createHub({ distDir: path.resolve('dist'), pin: '123456', allowControl: true });
await hub.start(PORT);
const connect = (pin, headers = {}) =>
  new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=remote&pin=${pin}`, { headers });
    ws.on('message', () => ws.close());
    ws.on('close', (code) => res(code));
    ws.on('error', () => res('rejected'));
  });
const get = (p, host) =>
  new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: host ? { host } : {} }, (r) => {
      r.resume();
      res(r.statusCode);
    }).on('error', (e) => res(e.message));
  });

const codes = [];
for (let i = 0; i < 9; i++) codes.push(await connect('000000'));
check(codes.slice(0, 8).every((c) => c === 4001) && codes[8] === 4029, `wrong PINs are refused and then locked out (${codes.join(',')})`);
check((await connect('123456')) === 4029, 'the lockout also holds for the right PIN until it expires');
check((await get('/%E0%A4%A')) === 400 && (await get('/api/info')) === 200, 'a malformed URL is rejected without crashing the server');
check((await get('/host', 'evil.example:8599')) === 421, 'unknown host names are rejected (DNS rebinding)');
check((await get('/api/info', '192.168.1.5:8599')) === 200, 'IP-address host names work');
const hostWs = await new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=host&token=${hub.hostToken}`, { headers: { origin: 'http://evil.example' } });
  ws.on('open', () => { ws.close(); res('opened'); });
  ws.on('error', () => res('rejected'));
});
check(hostWs === 'rejected', 'the host connection is refused from another website');
await hub.stop();
// Fresh server: a cross-site page cannot connect as a remote even with the right PIN
const hub2 = createHub({ distDir: path.resolve('dist'), pin: '123456', allowControl: true });
await hub2.start(PORT);
check((await connect('123456', { origin: 'http://evil.example' })) === 'rejected', 'cross-site WebSocket connections are refused');
const welcome = await new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=remote&pin=123456`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
  ws.on('message', (d) => { ws.close(); res(JSON.parse(String(d)).t); });
  ws.on('error', () => res('rejected'));
});
check(welcome === 'welcome', 'same-origin connections with the right PIN work');
await hub2.stop();
process.exit(failed ? 1 : 0);
