// End-to-end test of remote access: a host page (demo room) and a remote browser connected through the hub.
// Usage: npm run build && node tests/e2e/remote.mjs [outDir]
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createHub } = require('../../electron/hub.cjs');
const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const PORT = 8531;
const PIN = '482913';
const hub = createHub({ distDir: path.resolve('dist'), pin: PIN, allowControl: true, version: 'test' });
await hub.start(PORT);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const errors = [];

// --- Host: the measurement computer (served on the loopback-only /host page)
const hostCtx = await browser.newContext({ viewport: { width: 1500, height: 920 } });
const host = await hostCtx.newPage();
host.on('pageerror', (e) => errors.push(`host: ${e}`));
await host.goto(`http://localhost:${PORT}/host`);
await host.getByText('Explore with the demo room').click();
await host.getByRole('button', { name: 'Start demo' }).click();
await host.waitForTimeout(4000);
check(await host.evaluate(() => window.calApp.hostLink?.connected === true), 'host page links to the hub');

// --- Wrong PIN is rejected with a clear message
const badCtx = await browser.newContext();
const bad = await badCtx.newPage();
await bad.goto(`http://127.0.0.1:${PORT}/?pin=000000`);
await bad.waitForSelector('.remote-connect', { timeout: 8000 });
check((await bad.locator('.remote-connect .warn-text').textContent()).includes('Wrong PIN'), 'wrong PIN shows an error and asks again');
await bad.locator('.pin-input').fill(PIN);
await bad.locator('.remote-connect').getByRole('button', { name: 'Connect' }).click();
await bad.waitForFunction(() => window.calApp.engine.state === 'connected', null, { timeout: 8000 });
check(true, 'entering the correct PIN connects');
await badCtx.close();

// --- Remote: a tablet on the network, joining via the QR-code link (PIN included)
const remCtx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const rem = await remCtx.newPage();
rem.on('pageerror', (e) => errors.push(`remote: ${e}`));
await rem.goto(`http://127.0.0.1:${PORT}/?pin=${PIN}`);
await rem.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 15000 });
check(true, 'remote connects and receives live audio');
check(!(await rem.locator('.modal').count()), 'no setup wizard on remote clients');
await rem.waitForTimeout(5000);
const r = await rem.evaluate(() => {
  const a = window.calApp;
  const m = a.measurements[0];
  let c = 0, n = 0;
  a.grid.forEach((f, i) => { if (f > 300 && f < 8000) { c += m.result.coh[i]; n++; } });
  return { remote: a.remote, fs: a.fs, ch: a.engine.channelCount, delay: m.cfg.delay, coh: c / n, spl: a.splReading?.level, gen: a.settings.generator.type };
});
const h = await host.evaluate(() => ({ delay: window.calApp.measurements[0].cfg.delay, spl: window.calApp.splReading?.level, clients: window.calApp.hostLink.clients.length }));
console.log(JSON.stringify({ r, h }));
check(r.remote && r.ch === 2 && r.fs > 0, 'remote mirrors the host audio format');
check(r.delay === h.delay && r.delay > 0, 'remote adopts the host measurement setup (delay compensation)');
check(r.coh > 0.6, `remote computes the transfer function locally (coherence ${r.coh.toFixed(2)})`);
check(Math.abs(r.spl - h.spl) < 1.5, `remote SPL meter matches host (${r.spl.toFixed(1)} vs ${h.spl.toFixed(1)})`);
check(h.clients === 1, 'host sees the connected remote client');
await rem.screenshot({ path: `${out}/remote-01-transfer.png` });

// --- Remote controls the host's generator
await rem.keyboard.press(' ');
await host.waitForTimeout(700);
check((await host.evaluate(() => window.calApp.settings.generator.type)) === 'off', 'remote switched the host generator off');
await rem.keyboard.press(' ');
await host.waitForTimeout(700);
check((await host.evaluate(() => window.calApp.settings.generator.type)) !== 'off', 'remote switched the host generator on');

// --- Remote runs a sweep measurement that plays on the host
await rem.keyboard.press('5');
await rem.getByRole('button', { name: 'Measure sweep' }).click();
await rem.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 40000 });
const room = await rem.evaluate(() => window.calApp.views.find((v) => v.id === 'room').result.acoustics.broadband.t20.rt);
check(room > 0.3 && room < 1.5, `remote sweep measured through the host (T20 ${room.toFixed(2)} s)`);
await rem.screenshot({ path: `${out}/remote-02-room.png` });

// --- Host: Tools → Remote access shows addresses, PIN, QR and clients
await host.keyboard.press('8');
await host.waitForTimeout(800);
const card = await host.locator('.remote-card').textContent();
check(card.includes('Remote access is on') && card.includes('482 913'), 'host shows server status and PIN');
check((await host.locator('.remote-qr img').getAttribute('src'))?.startsWith('data:image/png'), 'host shows a QR code for quick connection');
check((await host.locator('.remote-client').count()) === 1, 'host lists the connected device');
await host.locator('.remote-card').screenshot({ path: `${out}/remote-03-host-card.png` });

// --- View-only mode: the host revokes control
await host.evaluate(() => window.calApp.hostLink.configure({ allowControl: false }));
await rem.waitForTimeout(500);
const before = await host.evaluate(() => window.calApp.settings.generator.type);
await rem.keyboard.press(' ');
await host.waitForTimeout(600);
check((await host.evaluate(() => window.calApp.settings.generator.type)) === before, 'view-only: remote cannot change the generator');

// --- Host audio stop/start: remote follows
await rem.keyboard.press('8');
await rem.waitForTimeout(500);
check((await rem.locator('.remote-card').textContent()).includes('Connected to the measurement host'), 'remote Tools shows its connection');
await rem.screenshot({ path: `${out}/remote-04-client-tools.png` });

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
await hub.stop();
process.exit(failed ? 1 : 0);
