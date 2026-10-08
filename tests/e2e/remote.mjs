// End-to-end test of remote access: a host page (demo room) and a remote browser connected through the hub.
// Usage: npm run build && node tests/e2e/remote.mjs [outDir]
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeWav } from './music.mjs';

const require = createRequire(import.meta.url);
const { createHub } = require('../../electron/hub.cjs');
const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const PORT = 8531;
const PIN = '482913';
const hub = createHub({ distDir: path.resolve('dist'), pin: PIN, allowControl: true, version: 'test' });
await hub.start(PORT);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
check(r.coh > 0.6, `remote shows the transfer function (coherence ${r.coh.toFixed(2)})`);

// --- Host processing (default): the remote shows the host's analysis, re-smoothed to its own resolution
const curves = (p) => p.evaluate(() => {
  const a = window.calApp;
  const m = a.measurements[0];
  const pick = (arr) => Array.from(arr).filter((_, i) => a.grid[i] > 200 && a.grid[i] < 5000);
  return { mode: a.processingMode(), rta: pick(m.rtaOut), mag: pick(m.mag), fromHost: !!m.hostFrame };
});
const med = (a, b) => { const d = a.map((v, i) => Math.abs(v - b[i])).sort((x, y) => x - y); return d[d.length >> 1]; };
await rem.keyboard.press('1');
await rem.waitForTimeout(1200);
let [rc, hc] = [await curves(rem), await curves(host)];
check(rc.mode === 'host' && rc.fromHost, 'remote devices use host processing by default');
check(med(rc.rta, hc.rta) < 1, `host-processed RTA matches the host (median difference ${med(rc.rta, hc.rta).toFixed(2)} dB)`);
check(med(rc.mag, hc.mag) < 1, `host-processed transfer function matches the host (median difference ${med(rc.mag, hc.mag).toFixed(2)} dB)`);
// Different smoothing on the remote than on the host
await rem.evaluate(() => { window.calApp.settings.rtaSmoothing = 1; });
await rem.waitForTimeout(400);
rc = await curves(rem);
const smooth = (arr) => arr.slice(1).reduce((s, v, i) => s + Math.abs(v - arr[i]), 0) / arr.length;
check(smooth(rc.rta) < smooth(hc.rta), 'remote applies its own smoothing to host-processed data');
await rem.evaluate(() => { window.calApp.settings.rtaSmoothing = 3; });
// Analysis on the device itself
await rem.evaluate(() => window.calApp.setProcessing('device'));
await rem.keyboard.press('2');
await rem.waitForTimeout(3000);
const dev = await rem.evaluate(() => { const a = window.calApp; const m = a.measurements[0]; let c = 0, n = 0; a.grid.forEach((f, i) => { if (f > 300 && f < 8000) { c += m.result.coh[i]; n++; } }); return { coh: c / n, host: !!m.hostFrame, mode: a.processingMode() }; });
check(dev.mode === 'device' && !dev.host && dev.coh > 0.6, `on-device analysis works too (coherence ${dev.coh.toFixed(2)})`);
await rem.evaluate(() => window.calApp.setProcessing('host'));
// Target curve and average curve set on the host appear on the remote (host processing)
await host.evaluate(() => { const a = window.calApp; a.settings.targetCurve = 'house'; a.settings.rtaAverageCurve = 10; for (const m of a.measurements) m.resetAverage(); a.save(); });
await rem.waitForTimeout(2500);
const tun = await rem.evaluate(() => { const a = window.calApp; return { target: a.settings.targetCurve, avg: a.settings.rtaAverageCurve, curve: !!a.measurements[0].averageDb(), frames: a.measurements[0].averageFrames }; });
check(tun.target === 'house' && tun.avg === 10, 'remote adopts the host target curve and average setting');
check(tun.curve && tun.frames > 5, `remote draws the average curve (${tun.frames} updates)`);
// Spectrum refresh: new host analysis frames several times a second
const rate = await rem.evaluate(() => new Promise((res) => { const m = window.calApp.measurements[0]; let last = m.hostFrame, n = 0; const t0 = performance.now(); const step = () => { if (m.hostFrame !== last) { n++; last = m.hostFrame; } if (performance.now() - t0 < 2000) requestAnimationFrame(step); else res(n / 2); }; step(); }));
check(rate >= 12, `remote spectrum updates ${rate.toFixed(0)} times a second`);
check(Math.abs(r.spl - h.spl) < 1.5, `remote SPL meter matches host (${r.spl.toFixed(1)} vs ${h.spl.toFixed(1)})`);
check(h.clients === 1, 'host sees the connected remote client');
await rem.screenshot({ path: `${out}/remote-01-transfer.png` });

// --- Connection drop (Wi-Fi blip / phone sleep): the remote reconnects by itself
await rem.evaluate(() => window.calApp.engine.ws.close(4000, 'network drop'));
await rem.waitForTimeout(300);
check(await rem.evaluate(() => window.calApp.engine.state !== 'connected'), 'remote notices the dropped connection');
await rem.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 10000 }).catch(() => undefined);
check(await rem.evaluate(() => window.calApp.engine.running), 'remote reconnects automatically and resumes live data');

// --- Remote controls the host's setup: its audio source and starting / stopping its audio
const srcs = await rem.evaluate(() => [...document.querySelectorAll('select.source option')].map((o) => o.value));
check(srcs.includes('__demo') && srcs.includes('__default') && !(await rem.locator('select.source').isDisabled()), `remote lists the host's audio sources and may change them (${srcs.length})`);
await rem.evaluate(() => { const s = document.querySelector('select.source'); s.value = '__default'; s.dispatchEvent(new Event('change')); });
await host.waitForFunction(() => window.calApp.settings.simulate === false, null, { timeout: 5000 }).then(() => check(true, 'the host switches to the source chosen on the remote')).catch(() => check(false, 'the host switches to the source chosen on the remote'));
// The host's output menu follows (a browser input: the system default output and the host's other outputs)
await rem.waitForFunction(() => document.querySelector('select[data-output] option')?.textContent === 'Out: system default', null, { timeout: 8000 }).catch(() => undefined);
const remOut = await rem.evaluate(() => { const s = document.querySelector('select[data-output]'); return { shown: getComputedStyle(s).display !== 'none', text: s.selectedOptions[0]?.textContent, disabled: s.disabled }; });
check(remOut.shown && remOut.text === 'Out: system default' && !remOut.disabled, `remote shows the host's output menu (${remOut.text})`);
await rem.evaluate(() => { const s = document.querySelector('select[data-output]'); s.append(new Option('x', 'remote-pick')); s.value = 'remote-pick'; s.dispatchEvent(new Event('change')); });
await host.waitForFunction(() => window.calApp.settings.outputId === 'remote-pick', null, { timeout: 5000 }).then(() => check(true, 'the host uses the output chosen on the remote')).catch(() => check(false, 'the host uses the output chosen on the remote'));
await host.evaluate(() => window.calApp.selectOutput(''));
await rem.evaluate(() => { const s = document.querySelector('select.source'); s.value = '__demo'; s.dispatchEvent(new Event('change')); });
await host.waitForFunction(() => window.calApp.settings.simulate === true && window.calApp.engine.running, null, { timeout: 10000 }).catch(() => undefined);
check(await host.evaluate(() => window.calApp.settings.simulate && window.calApp.engine.running), 'and back to the demo room, running');
await rem.waitForFunction(() => document.querySelector('select.source')?.value === '__demo', null, { timeout: 5000 }).catch(() => undefined);
check((await rem.locator('select.source').inputValue()) === '__demo', 'the remote shows the host’s current source');
await rem.evaluate(() => document.querySelector('[data-host-audio]').click());
await host.waitForFunction(() => !window.calApp.engine.running, null, { timeout: 5000 }).catch(() => undefined);
check(!(await host.evaluate(() => window.calApp.engine.running)), 'Stop host audio stops the host');
await rem.waitForFunction(() => document.querySelector('[data-host-audio]')?.textContent.includes('Start'), null, { timeout: 5000 }).catch(() => undefined);
await rem.evaluate(() => document.querySelector('[data-host-audio]').click());
await host.waitForFunction(() => window.calApp.engine.running, null, { timeout: 10000 }).catch(() => undefined);
check(await host.evaluate(() => window.calApp.engine.running), 'Start host audio starts it again');
await rem.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 15000 }).catch(() => undefined);
await rem.waitForTimeout(2500);

// --- Remote controls the host's generator (the demo room keeps its signal through Stop and Start)
await rem.keyboard.press(' ');
await host.waitForTimeout(1000);
check((await host.evaluate(() => window.calApp.settings.generator.type)) === 'off', 'remote switched the host generator off');
await rem.keyboard.press(' ');
await host.waitForTimeout(1000);
check((await host.evaluate(() => window.calApp.settings.generator.type)) !== 'off', 'remote switched the host generator on');

// --- Safety: losing and regaining the connection (or reloading the page) never starts the host's audio or sound.
// The host on a real input (a test device), with pink noise playing, then stopped
await host.evaluate(() => window.calApp.selectSource('__default'));
await host.waitForFunction(() => window.calApp.engine.running && !window.calApp.settings.simulate, null, { timeout: 10000 });
await host.evaluate(() => window.calApp.setGenerator({ type: 'pink' }));
await host.evaluate(() => window.calApp.stop());
await host.waitForFunction(() => !window.calApp.engine.running, null, { timeout: 5000 });
check((await host.evaluate(() => window.calApp.settings.generator.type)) === 'off', 'stopping the host audio turns its generator off');
await rem.evaluate(() => window.calApp.engine.ws.close(4000, 'network drop'));
await rem.waitForFunction(() => window.calApp.engine.state === 'connected', null, { timeout: 15000 }).catch(() => undefined);
await rem.waitForTimeout(2500);
check(await rem.evaluate(() => window.calApp.engine.state === 'connected'), 'the remote reconnects');
check(!(await host.evaluate(() => window.calApp.engine.running)), 'a reconnecting remote does not start the host audio');
await rem.reload();
await rem.waitForFunction(() => window.calApp.engine.state === 'connected', null, { timeout: 15000 }).catch(() => undefined);
await rem.waitForTimeout(2500);
check(!(await host.evaluate(() => window.calApp.engine.running)), 'nor does reloading the remote page');
check((await host.evaluate(() => window.calApp.settings.generator.type)) === 'off', 'and the generator stays off');
// Only the explicit button starts it, and it starts silent
await rem.waitForFunction(() => document.querySelector('[data-host-audio]')?.textContent.includes('Start'), null, { timeout: 5000 }).catch(() => undefined);
await rem.evaluate(() => document.querySelector('[data-host-audio]').click());
await host.waitForFunction(() => window.calApp.engine.running, null, { timeout: 10000 }).catch(() => undefined);
check(await host.evaluate(() => window.calApp.engine.running), 'Start host audio on the remote starts it');
check((await host.evaluate(() => window.calApp.settings.generator.type)) === 'off', 'with the generator off');
await rem.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 15000 }).catch(() => undefined);
await rem.keyboard.press(' ');
await host.waitForFunction(() => window.calApp.settings.generator.type !== 'off', null, { timeout: 5000 }).catch(() => undefined);
check((await host.evaluate(() => window.calApp.settings.generator.type)) === 'pink', 'turning it on brings back the last signal (pink noise)');
// Back to the demo room for the rest
await host.evaluate(() => window.calApp.selectSource('__demo'));
await host.waitForFunction(() => window.calApp.settings.simulate && window.calApp.engine.running, null, { timeout: 10000 });
await rem.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 15000 }).catch(() => undefined);
await rem.waitForTimeout(2000);

// --- A second remote (phone) joins: shared session state is kept on the host
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const phone = await phoneCtx.newPage();
phone.on('pageerror', (e) => errors.push(`phone: ${e}`));
await phone.goto(`http://127.0.0.1:${PORT}/?pin=${PIN}`);
await phone.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 15000 });

// The host is SPL-calibrated (the RTA switches from dBFS to dB SPL, ~120 dB higher)
await host.evaluate(() => { const a = window.calApp; a.settings.mics = [{ id: 't1', name: 'Test mic', channel: a.settings.splChannel, micCal: null, splOffset: 120, splCalibrated: true }]; a.syncCal(); a.save(); });
// Spectrum on a remote: the data is inside the plot (not an off-scale fill) and the zoom buttons work
await phone.keyboard.press('1');
// The calibration reaches the phone with the host's next settings update
await phone.waitForFunction(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.cfg.yUnit === 'dB SPL', null, { timeout: 10000 }).catch(() => undefined);
await phone.waitForTimeout(1500);
const inView = () => {
  const p = window.calApp.views.find((v) => v.id === 'spectrum').rta;
  const ys = Array.from(p.series.find((s) => !s.id.endsWith('-pk')).y).filter((v, i) => window.calApp.grid[i] > 100 && window.calApp.grid[i] < 10000);
  const med = ys.sort((a, b) => a - b)[ys.length >> 1];
  return { med, lo: p.cfg.yMin, hi: p.cfg.yMax, unit: p.cfg.yUnit };
};
const sp = await phone.evaluate(inView);
console.log(JSON.stringify(sp));
check(sp.med > sp.lo && sp.med < sp.hi, `remote spectrum shows the data in range (${sp.med.toFixed(0)} ${sp.unit} in ${sp.lo}…${sp.hi})`);
const zoomBtn = phone.locator('.view:visible .plot-zoom button[data-act="out"]').first();
check(await zoomBtn.isVisible(), 'zoom buttons are visible on touch screens');
await zoomBtn.tap();
const sp2 = await phone.evaluate(inView);
check(sp2.hi - sp2.lo > sp.hi - sp.lo + 5, `zoom out widens the range (${sp.hi - sp.lo} → ${(sp2.hi - sp2.lo).toFixed(0)} dB)`);
await phone.evaluate(() => { const p = window.calApp.views.find((v) => v.id === 'spectrum').rta; p.setY(300 - 400, 300 - 350); });
await phone.locator('.view:visible .plot-zoom button[data-act="fit"]').first().tap();
const sp3 = await phone.evaluate(inView);
check(sp3.med > sp3.lo && sp3.med < sp3.hi, 'Fit brings the data back into view');
await phone.screenshot({ path: `${out}/remote-05-phone-spectrum.png` });
check(sp.unit === 'dB SPL', 'remote spectrum adopts the host calibration');
// Spectrogram with the calibrated host: the colour range follows the calibration (no solid colour)
await phone.keyboard.press('3');
await phone.waitForTimeout(3000);
const sgr = await phone.evaluate(() => {
  const v = window.calApp.views.find((x) => x.id === 'spectrogram');
  const sorted = [...v.recent].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const c = document.querySelector('.view:not([hidden]) canvas, .spectrogram canvas');
  const cv = v.sg.el.querySelector('canvas');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const colours = new Set();
  for (let i = 0; i < d.length; i += 4 * 211) colours.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
  return { med, lo: v.sg.dbMin, hi: v.sg.dbMax, colours: colours.size, unit: v.unit.textContent };
});
console.log(JSON.stringify(sgr));
check(sgr.unit === 'dB SPL' && sgr.med > sgr.lo && sgr.med < sgr.hi, `spectrogram colour range follows the calibration (${sgr.med.toFixed(0)} dB in ${sgr.lo}…${sgr.hi} ${sgr.unit})`);
check(sgr.colours > 12, `spectrogram shows a range of colours, not a solid fill (${sgr.colours})`);
await phone.screenshot({ path: `${out}/remote-06-phone-spectrogram.png` });
await phone.keyboard.press('1');

// --- Remote runs a sweep: it runs on the host and the result appears on every device
await rem.keyboard.press('5');
await rem.getByRole('button', { name: 'Measure sweep' }).click();
await rem.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 40000 });
const room = await rem.evaluate(() => window.calApp.views.find((v) => v.id === 'room').result.acoustics.broadband.t20.rt);
check(room > 0.3 && room < 1.5, `remote sweep measured through the host (T20 ${room.toFixed(2)} s)`);
const t20 = (p) => p.evaluate(() => window.calApp.views.find((v) => v.id === 'room').result?.acoustics.broadband.t20.rt ?? null);
const [hostT20, phoneT20] = [await t20(host), await t20(phone)];
check(hostT20 !== null && Math.abs(hostT20 - room) < 1e-3, 'the sweep result is on the host');
check(phoneT20 !== null && Math.abs(phoneT20 - room) < 0.01, 'the sweep result is shared to the other remote');
await rem.screenshot({ path: `${out}/remote-02-room.png` });

// A sweep started on the host shows on the remotes too, with progress
const hostWhen = await host.evaluate(() => window.calApp.views.find((v) => v.id === 'room').result.when.getTime());
await host.keyboard.press('5');
await host.getByRole('button', { name: 'Measure sweep' }).click();
await phone.waitForFunction(() => /Sweep|Playing/.test(document.querySelector('.view:not([hidden]) .sweep-status, .room-status')?.textContent ?? '') || window.calApp.views.find((v) => v.id === 'room').running !== null, null, { timeout: 8000 }).then(() => check(true, 'remotes show the host sweep progress')).catch(() => check(false, 'remotes show the host sweep progress'));
await phone.waitForFunction((w) => (window.calApp.views.find((v) => v.id === 'room').result?.when.getTime() ?? 0) > w, hostWhen, { timeout: 40000 });
check(true, 'a sweep run on the host appears on the remotes');

// A remote device joining later gets the latest result
const lateCtx = await browser.newContext();
const late = await lateCtx.newPage();
await late.goto(`http://127.0.0.1:${PORT}/?pin=${PIN}`);
await late.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 15000 }).catch(() => undefined);
check((await t20(late)) !== null, 'a device joining later receives the latest sweep');

// --- A guided series of sweeps at two positions, run from a remote: the averaged trace reaches the host
await rem.locator('select[data-sweep="positions"]').selectOption('3');
await rem.getByRole('button', { name: 'Measure 3 positions' }).click();
await rem.waitForSelector('.series-bar:not([hidden]) [data-series="go"]', { timeout: 40000 });
await rem.locator('[data-series="go"]').click();
await rem.waitForSelector('.series-bar:not([hidden]) [data-series="finish"]', { timeout: 40000 });
await rem.locator('[data-series="finish"]').click();
await host.waitForFunction(() => window.calApp.traces.traces.some((t) => t.name.startsWith('Spatial average (2 positions)')), null, { timeout: 10000 })
  .then(() => check(true, 'a multi-position series run from a remote ends in a spatial average on the host'))
  .catch(() => check(false, 'a multi-position series run from a remote ends in a spatial average on the host'));
await rem.locator('select[data-sweep="positions"]').selectOption('1');

// --- Notes on graphs are shared: added on a remote, they show on the host and the other devices
await rem.evaluate(() => {
  const a = window.calApp;
  a.settings.graphNotes = [...a.settings.graphNotes, { id: 'nr1', graph: 'spectrum', f: 250, text: 'Remote note', created: Date.now() }];
  a.save();
});
await host.waitForFunction(() => window.calApp.settings.graphNotes.some((n) => n.text === 'Remote note'), null, { timeout: 8000 })
  .then(() => check(true, 'a note added on a remote reaches the host'))
  .catch(() => check(false, 'a note added on a remote reaches the host'));
await phone.waitForFunction(() => window.calApp.settings.graphNotes.some((n) => n.text === 'Remote note'), null, { timeout: 8000 })
  .then(() => check(true, 'and the other remote'))
  .catch(() => check(false, 'and the other remote'));
await host.evaluate(() => {
  const a = window.calApp;
  a.settings.graphNotes = a.settings.graphNotes.filter((n) => n.id !== 'nr1');
  a.save();
});
await rem.waitForFunction(() => !window.calApp.settings.graphNotes.length, null, { timeout: 8000 })
  .then(() => check(true, 'a note deleted on the host goes from the remotes'))
  .catch(() => check(false, 'a note deleted on the host goes from the remotes'));

// --- Traces are shared: captured on one device, visible (and deletable) everywhere
const nTraces = await host.evaluate(() => window.calApp.traces.traces.length);
// Capturing needs a transfer function on the remote (from the host's analysis): wait for it, then for the sync
await rem.waitForFunction(() => window.calApp.measurements[0]?.tfReady, null, { timeout: 15000 }).catch(() => undefined);
await rem.evaluate(() => window.calApp.captureTrace(window.calApp.measurements[0], 'tf'));
await host.waitForFunction((n) => window.calApp.traces.traces.length === n + 1, nTraces, { timeout: 8000 }).catch(() => undefined);
await phone.waitForFunction((n) => window.calApp.traces.traces.length === n + 1, nTraces, { timeout: 8000 }).catch(() => undefined);
await late.waitForFunction((n) => window.calApp.traces.traces.length === n + 1, nTraces, { timeout: 8000 }).catch(() => undefined);
const names = (p) => p.evaluate(() => window.calApp.traces.traces.map((t) => t.name));
const hostNames = await names(host);
check(hostNames.length === nTraces + 1, 'a trace captured on a remote is stored on the host');
check(JSON.stringify(await names(phone)) === JSON.stringify(hostNames) && JSON.stringify(await names(late)) === JSON.stringify(hostNames), 'the trace list is identical on every device');
const id = await phone.evaluate(() => window.calApp.traces.traces.at(-1).id);
await phone.evaluate((i) => window.calApp.traces.update(i, { name: 'Renamed on phone' }), id);
await rem.waitForFunction(() => window.calApp.traces.traces.some((t) => t.name === 'Renamed on phone'), null, { timeout: 8000 }).catch(() => undefined);
check((await names(rem)).includes('Renamed on phone'), 'trace edits on one remote reach the others');
await phone.evaluate((i) => window.calApp.traces.remove(i), id);
for (const p of [host, rem]) await p.waitForFunction((n) => window.calApp.traces.traces.length === n, nTraces, { timeout: 8000 }).catch(() => undefined);
check((await names(host)).length === nTraces && (await names(rem)).length === nTraces, 'deleting a trace on a remote deletes it everywhere');

// --- Measurement setup changed on a remote is applied on the host and the other remotes
await phone.evaluate(() => { window.calApp.settings.tempC = 27; window.calApp.save(); });
await host.waitForTimeout(1200);
check((await host.evaluate(() => window.calApp.settings.tempC)) === 27 && (await rem.evaluate(() => window.calApp.settings.tempC)) === 27, 'shared settings changed on a remote sync to the host and other remotes');
// --- Music: a song added on a remote device is stored and played on the host
{
  const song = makeWav(path.join(out, 'Remote song.wav'), 3, 262);
  await phone.keyboard.press('Escape');
  await phone.evaluate(async (bytes) => {
    const f = new File([new Uint8Array(bytes)], 'Remote song.wav', { type: 'audio/wav' });
    await window.calApp.playlist.addFiles([f]);
  }, [...fs.readFileSync(song)]);
  await host.waitForFunction(() => window.calApp.playlist.state().tracks.some((t) => t.name === 'Remote song'), null, { timeout: 8000 }).catch(() => undefined);
  check(await host.evaluate(() => window.calApp.playlist.state().tracks.some((t) => t.name === 'Remote song')), 'a song uploaded from a phone is added to the host playlist');
  await rem.evaluate(() => { window.calApp.setGenerator({ type: 'music' }); });
  await host.waitForFunction(() => window.calApp.settings.generator.type === 'music' && (window.calApp.engine.musicPos?.pos ?? 0) > 0, null, { timeout: 8000 }).catch(() => undefined);
  check(await host.evaluate(() => window.calApp.settings.generator.type === 'music' && window.calApp.engine.genLevel.rms > 0.01), 'a remote starts the music on the host');
  await rem.waitForTimeout(900);
  const rs = await rem.evaluate(() => { const s = window.calApp.playlist.state(); return { name: s.tracks.find((t) => t.id === s.current)?.name, pos: s.pos }; });
  check(rs.name === 'Remote song' && rs.pos > 0, `remotes show the playing song and its position (${rs.name} ${rs.pos.toFixed(1)} s)`);
  // The host's status changes several times a second while music plays: controls on the remote must not be rebuilt
  await rem.evaluate(() => { window.__genSel = document.querySelector('.gen-controls select'); });
  await rem.waitForTimeout(1600);
  check(await rem.evaluate(() => document.querySelector('.gen-controls select') === window.__genSel), 'remote generator controls stay put while the host status updates');
  await rem.evaluate(() => { window.calApp.setGenerator({ type: 'pink' }); });
}
await lateCtx.close();
await phoneCtx.close();

// --- Host: Tools → Remote access shows addresses, PIN, QR and clients
await host.keyboard.press('9');
await host.locator('[data-section="remote"]').click();
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
await rem.keyboard.press('9');
await rem.locator('[data-section="remote"]').click();
await rem.waitForTimeout(500);
check((await rem.locator('.remote-card').textContent()).includes('Connected to the measurement host'), 'remote Tools shows its connection');
await rem.screenshot({ path: `${out}/remote-04-client-tools.png` });

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
await hub.stop();
process.exit(failed ? 1 : 0);
