// Desktop app with native audio (the ASIO path) on the built-in virtual loopback interface: the native module,
// the audio host process, device selection, the generator, sample-aligned internal reference, sweeps and the
// Tools card. The virtual interface returns the output 480 samples later (input 1 at half level, input 2 as a
// hardware loopback).
// Usage: npm run build:native && npm run build && xvfb-run -a node tests/e2e/electron-native.mjs [path-to-app-executable]
import { _electron as electron } from 'playwright';

const exe = process.argv[2];
const env = { ...process.env, CAL_NATIVE_TEST: '1' };
const app = await electron.launch(exe ? { executablePath: exe, args: ['--no-sandbox'], env } : { args: ['.', '--no-sandbox'], env });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
await page.waitForSelector('.topbar');
await page.evaluate(() => {
  localStorage.clear();
  window.addEventListener('pagehide', () => localStorage.clear());
});
await page.reload();
await page.waitForSelector('.topbar');
// Skip the wizard: demo first, then switch to the native device
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(1500);

const value = 'native:test:Virtual loopback interface';
await page.waitForFunction((v) => [...document.querySelectorAll('select.source option')].some((o) => o.value === v), value, { timeout: 10000 });
check(true, 'native device listed as an input source');
await page.selectOption('select.source', value);
await page.waitForFunction(() => window.calApp.engine.nativeInfo, null, { timeout: 10000 });
const info = await page.evaluate(() => ({ info: window.calApp.engine.nativeInfo, ch: window.calApp.engine.channelCount, fs: window.calApp.fs, label: window.calApp.engine.deviceLabel, running: window.calApp.engine.running }));
check(info.running && info.ch === 2 && info.fs === 48000, `native stream running (${info.label}, ${info.fs} Hz, ${info.ch} inputs, buffer ${info.info.bufferFrames})`);

// Pink noise on output 1; internal reference
await page.evaluate(() => {
  const a = window.calApp;
  a.settings.measurements[0].mic = 0;
  a.settings.measurements[0].ref = -1;
  a.rebuildMeasurements();
  a.setGenerator({ type: 'pink', level: -12, outputs: [0] });
});
await page.waitForTimeout(2500);
const lv = await page.evaluate(() => ({ in1: window.calApp.engine.levels[0].rms, gen: window.calApp.engine.genLevel.rms, written: window.calApp.engine.gen.written }));
check(lv.gen > 0.05 && lv.in1 > 0.02, `generator plays and returns on input 1 (gen ${lv.gen.toFixed(3)}, in ${lv.in1.toFixed(3)})`);

// Delay against the internal reference: exactly the interface's 480 samples, every time
await page.keyboard.press('2');
await page.evaluate(() => window.calApp.findDelay(window.calApp.measurements[0]));
await page.waitForTimeout(3500);
const tf = await page.evaluate(() => {
  const a = window.calApp;
  const m = a.measurements[0];
  let c = 0, n = 0, mag = 0;
  a.grid.forEach((f, i) => { if (f > 100 && f < 10000) { c += m.result.coh[i]; mag += m.mag[i]; n++; } });
  return { delay: m.cfg.delay, coh: c / n, mag: mag / n };
});
check(tf.delay === 480, `delay found against the internal reference: ${tf.delay} samples (expected 480)`);
check(tf.coh > 0.97, `coherence ${tf.coh.toFixed(3)}`);
check(Math.abs(tf.mag + 6.02) < 0.3, `transfer function level −6 dB as simulated (${tf.mag.toFixed(2)} dB)`);
await page.screenshot({ path: 'test-results/native-01-transfer.png' });

// A measurement sweep through the native path (playback frames mapped to the capture timeline)
await page.keyboard.press('5');
await page.getByRole('button', { name: 'Measure sweep' }).click();
await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 40000 });
const sw = await page.evaluate(() => {
  const r = window.calApp.views.find((v) => v.id === 'room').result;
  return { peakDb: r.peakDb, t0: r.t0, fs: r.d.fs, peakAt: r.d.ir.reduce((b, v, i, a) => (Math.abs(v) > Math.abs(a[b]) ? i : b), 0) };
});
check(sw.peakDb > 50, `sweep impulse response is clean (peak-to-noise ${sw.peakDb.toFixed(0)} dB)`);
await page.screenshot({ path: 'test-results/native-02-sweep.png' });

// Tools card shows the stream and no dropouts
await page.keyboard.press('9');
await page.waitForTimeout(1200);
const card = await page.evaluate(() => ({ visible: getComputedStyle(document.querySelector('.native-card')).display !== 'none', text: document.querySelector('.native-status').textContent, st: window.calApp.engine.nativeLink.status }));
check(card.visible && card.text.includes('Virtual loopback interface') && card.text.includes('48 kHz'), `Tools card shows the stream (${card.text})`);
check(card.st && card.st.underruns === 0 && card.st.overruns === 0, `no dropouts (${JSON.stringify(card.st)})`);
await page.locator('.native-card').screenshot({ path: 'test-results/native-03-card.png' });

// Change the buffer size: the stream reopens with it
await page.locator('select[data-native="buffer"]').selectOption('128');
await page.waitForFunction(() => window.calApp.engine.nativeInfo?.bufferFrames === 128, null, { timeout: 10000 });
check(true, 'buffer size change reopens the stream');

// Stop and back to the browser audio path
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check(!(await page.evaluate(() => window.calApp.engine.running)), 'stops');
await page.selectOption('select.source', '__demo');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
check(await page.evaluate(() => window.calApp.engine.running && !window.calApp.engine.nativeInfo && window.calApp.engine.simulate), 'back to the demo (browser audio path)');

check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await app.close();
process.exit(failed ? 1 : 0);
