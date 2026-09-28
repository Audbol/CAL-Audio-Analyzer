#!/usr/bin/env node
// Standalone remote-access server (for using CAL Audio Analyzer in a browser without the desktop app).
//
//   npm run build && npm run serve [-- --port 8520 --pin 123456 --no-control]
//
// Then open http://localhost:<port>/host on this computer (the measurement host with the audio interface) and
// the printed network address on phones, tablets or other computers.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createHub } = require('../electron/hub.cjs');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const port = Number(arg('port', process.env.PORT || 8520));
const pin = arg('pin', String(Math.floor(Math.random() * 1e6)).padStart(6, '0'));
const allowControl = !args.includes('--no-control');

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('The app has not been built yet. Run:  npm run build');
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const hub = createHub({ distDir, pin: args.includes('--no-pin') ? '' : pin, allowControl, version, log: (m) => console.log(`  · ${m}`) });

try {
  await hub.start(port);
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Try: npm run serve -- --port ${port + 1}` : e);
  process.exit(1);
}

const info = hub.info();
const line = '─'.repeat(64);
console.log(`\n${line}\n  CAL Audio Analyzer · remote access server\n${line}`);
console.log(`\n  1. On THIS computer (with the audio interface), open:\n       http://localhost:${port}/host\n`);
console.log('  2. On phones, tablets or other computers on the same network, open:');
for (const u of info.urls) console.log(`       ${u.url}   (${u.iface})`);
if (!info.urls.length) console.log('       (no network connection found)');
console.log(`\n  PIN: ${info.pin || 'none (open access)'}${allowControl ? '' : '   · remote control disabled (view only)'}`);
console.log('\n  Press Ctrl+C to stop.\n');

const shutdown = async () => {
  await hub.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
