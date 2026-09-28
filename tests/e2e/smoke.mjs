// End-to-end smoke test: runs the app in demo mode in headless Chromium and exercises every view.
// Usage: npm run build && node tests/e2e/smoke.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4179, strictPort: true } });
const url = 'http://localhost:4179/';
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failed = true;
};

await page.goto(url);
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(6000);
const state = await page.evaluate(() => {
  const app = window.calApp;
  const m = app.measurements[0];
  const g = app.grid;
  let c = 0, n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] > 300 && g[i] < 8000) { c += m.result.coh[i]; n++; }
  const at = (f) => m.mag[g.findIndex((x) => x >= f)];
  return { running: app.engine.running, fs: app.fs, delay: m.cfg.delay, coh: c / n, mag47: at(47), mag1k: at(1000), spl: app.splReading?.level };
});
console.log(JSON.stringify(state));
check(state.running, 'engine running in demo mode');
check(Math.abs(state.delay - Math.round((4.3 / 343) * state.fs)) < 4, `delay finder found ~12.5 ms (got ${(state.delay / state.fs * 1000).toFixed(2)} ms)`);
check(state.coh > 0.7, `coherence high after delay found (${state.coh.toFixed(2)})`);
check(state.mag47 > state.mag1k + 3, 'room mode at 47 Hz visible in transfer function');
await page.screenshot({ path: `${out}/02-transfer.png` });

await page.keyboard.press('c');
await page.waitForTimeout(300);
check(await page.evaluate(() => window.calApp.traces.traces.length === 1), 'capture trace with C');

for (const [key, name] of [['1', 'spectrum'], ['3', 'spectrogram'], ['4', 'impulse'], ['7', 'spl'], ['8', 'tools']]) {
  await page.keyboard.press(key);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/0${key}-${name}.png` });
}
const peak = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'impulse').lastPeakMs);
check(Math.abs(peak) < 1, `impulse peak at ~0 ms relative to delay (${peak.toFixed(2)})`);

// EQ assistant on live data
await page.keyboard.press('6');
await page.getByRole('button', { name: 'Calculate EQ' }).click();
await page.waitForTimeout(500);
const eq = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'eq').filters.length);
check(eq > 0, `EQ assistant produced ${eq} filters`);
await page.screenshot({ path: `${out}/05-eq.png` });

// Sweep measurement
await page.keyboard.press('5');
await page.getByRole('button', { name: 'Measure sweep' }).click();
await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 30000 });
await page.waitForTimeout(500);
const room = await page.evaluate(() => {
  const r = window.calApp.views.find((v) => v.id === 'room').result;
  const bb = r.acoustics.broadband;
  return { t30: bb.t30.rt, t20: bb.t20.rt, edt: bb.edt.rt, c80: bb.c80, pnr: r.peakDb, bands: r.acoustics.bands.map((b) => [b.label, +b.t20.rt.toFixed(2)]) };
});
console.log(JSON.stringify(room));
check(room.t20 > 0.3 && room.t20 < 1.5, `sweep RT (T20 ${room.t20.toFixed(2)} s) in plausible range for the demo room`);
await page.screenshot({ path: `${out}/04-room-fr.png` });
await page.getByRole('button', { name: 'Reverberation (RT60)' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/04-room-rt.png` });
await page.keyboard.press('?');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/08-help.png` });

// Switch to a (fake) hardware input: exercises getUserMedia and the capture path
await page.keyboard.press('Escape');
await page.selectOption('select.source', '__default');
await page.waitForTimeout(3000);
const hw = await page.evaluate(() => {
  const a = window.calApp;
  return { running: a.engine.running, sim: a.engine.simulate, ch: a.engine.channelCount, ref: a.measurements[0].cfg.ref, peak: a.engine.levels[0].peak };
});
console.log(JSON.stringify(hw));
check(hw.running && !hw.sim && hw.ch >= 1, `hardware input running with ${hw.ch} channel(s)`);
check(hw.peak > 0, 'fake microphone delivers signal');
await page.screenshot({ path: `${out}/09-hardware.png` });

check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
server.httpServer.close();
process.exit(failed ? 1 : 0);
