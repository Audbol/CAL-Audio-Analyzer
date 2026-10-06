// End-to-end test of the 2.0 additions: the 3-D waterfall, FIR export, the crossover designer, the graph
// watermark, updates that wait for the user, and trace rows on narrow screens.
// Usage: npm run build && node tests/e2e/features7.mjs [outDir]   (ONLY=waterfall,fir,… runs some sections)
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4189, strictPort: true } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failed = true;
};
const only = process.env.ONLY ?? '';
const want = (name) => !only || only.split(',').includes(name);
const view = (id) => `window.calApp.views.find((v) => v.id === '${id}')`;

await page.goto('http://localhost:4189/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(3000);

// --- 1. Updates never happen on their own (browser: nothing to update; the setting defaults to off)
if (want('updates')) {
  const s = await page.evaluate(() => window.calApp.settings.autoUpdateCheck);
  check(s === false, 'automatic update checks are off by default');
  await page.evaluate(() => window.calApp.openTools('data'));
  await page.waitForTimeout(200);
  const txt = await page.locator('.about-card').innerText();
  check(txt.includes('browser version') && (await page.locator('[data-update="auto"]').count()) === 0, 'the browser version has no update controls');
  await page.keyboard.press('1');
}

// --- 2. The waterfall turns in 3-D
if (want('waterfall')) {
  await page.keyboard.press('5');
  await page.getByRole('button', { name: 'Measure sweep' }).click();
  await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 30000 });
  await page.locator('.room-tabs-row').getByRole('button', { name: 'Waterfall' }).click();
  await page.waitForTimeout(400);
  const before = await page.evaluate(`({ ...${view('room')}.wf.view })`);
  const box = await page.locator('.waterfall canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 50, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(`({ ...${view('room')}.wf.view })`);
  check(after.yaw > before.yaw + 40 && after.pitch > before.pitch + 10, `dragging turns the waterfall (yaw ${before.yaw} → ${after.yaw.toFixed(0)}, pitch ${before.pitch} → ${after.pitch.toFixed(0)})`);
  const saved = await page.evaluate(() => window.calApp.settings.waterfallView);
  check(Math.abs(saved.yaw - after.yaw) < 1e-6, 'the angle is remembered');
  await page.screenshot({ path: `${out}/feat7-01-waterfall-turned.png` });
  await page.locator('[data-wf-view="side"]').click();
  check((await page.evaluate(`${view('room')}.wf.view.yaw`)) === 72, 'Side view button');
  await page.locator('.waterfall canvas').dblclick();
  const reset = await page.evaluate(`({ ...${view('room')}.wf.view })`);
  check(reset.yaw === 32 && reset.pitch === 24 && reset.zoom === 1, 'double-click goes back to the standard view');
  await page.locator('.waterfall canvas').focus();
  await page.keyboard.press('ArrowRight');
  check((await page.evaluate(`${view('room')}.wf.view.yaw`)) === 37, 'arrow keys turn it');
  await page.keyboard.press('Home');
}

// --- 3. FIR export from the EQ
if (want('fir')) {
  await page.keyboard.press('6');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Calculate EQ' }).click();
  await page.waitForTimeout(300);
  const n = await page.evaluate(`${view('eq')}.filters.length`);
  check(n > 0, `EQ has ${n} filters`);
  await page.locator('[data-fir-export]').click();
  await page.waitForSelector('.fir-modal');
  await page.waitForTimeout(300);
  const info1 = await page.locator('.fir-info').innerText();
  check(/No latency/.test(info1), `minimum phase by default (${info1.slice(0, 80)}…)`);
  await page.locator('select[data-fir="phase"]').selectOption('linear');
  await page.locator('select[data-fir="taps"]').selectOption('16384');
  await page.waitForTimeout(200);
  const info2 = await page.locator('.fir-info').innerText();
  check(/Latency 170\.7 ms/.test(info2), `linear phase reports its latency (${info2.match(/Latency [\d.]+ ms/)?.[0]})`);
  const fir = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.fir-modal .plot')].length;
    return p;
  });
  check(fir === 1, 'the dialog shows the EQ and FIR response');
  await page.screenshot({ path: `${out}/feat7-02-fir-export.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-fir="save"]').click()]);
  const file = `${out}/${dl.suggestedFilename()}`;
  await dl.saveAs(file);
  const buf = fs.readFileSync(file);
  check(dl.suggestedFilename().endsWith('_FIR_linear_48k_16384.wav'), `file name ${dl.suggestedFilename()}`);
  check(buf.toString('ascii', 0, 4) === 'RIFF' && buf.readUInt16LE(20) === 3 && buf.readUInt32LE(24) === 48000 && buf.length === 44 + 16384 * 4, 'a 32-bit float WAV of 16384 taps at 48 kHz');
  // Linear phase: the peak sits in the middle
  let peak = 0;
  let at = 0;
  for (let i = 0; i < 16384; i++) {
    const v = Math.abs(buf.readFloatLE(44 + i * 4));
    if (v > peak) [peak, at] = [v, i];
  }
  check(Math.abs(at - 8192) <= 1 && peak > 0.2 && peak <= 1, `the impulse peaks in the middle (${at}, ${peak.toFixed(2)})`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fir-modal', { state: 'detached' });
}

// --- 4. Crossover designer: two flat full-range parts, a virtual LR24 at 90 Hz, the sub 2.5 ms late
if (want('xover')) {
  await page.evaluate(() => {
    const app = window.calApp;
    const freqs = Array.from(app.grid);
    const make = (delayMs) => ({ mag: freqs.map(() => 0), phase: freqs.map((f) => ((((-360 * f * delayMs) / 1000) % 360) + 540) % 360 - 180) });
    const m = make(0);
    const s = make(2.5);
    app.traces.add({ name: 'Mains full-range', kind: 'tf', freqs, mag: m.mag, phase: m.phase, delayMs: 0 });
    app.traces.add({ name: 'Sub full-range', kind: 'tf', freqs, mag: s.mag, phase: s.phase, delayMs: 0 });
  });
  await page.evaluate(() => window.calApp.setView('align'));
  await page.waitForTimeout(300);
  // Off: the filters alone, as designed
  await page.locator('[data-xover="toggle"]').click();
  check(await page.locator('.xover-panel').isVisible(), 'the Crossover button opens the designer');
  const ids = await page.evaluate(() => window.calApp.traces.traces.slice(-2).map((t) => t.id));
  await page.locator('select[data-align="ref"]').selectOption(`trace:${ids[0]}`);
  await page.locator('select[data-align-el]').first().selectOption(`trace:${ids[1]}`);
  await page.locator('select[data-xover-shape="low"]').selectOption('lr24');
  await page.locator('select[data-xover-shape="high"]').selectOption('lr24');
  await page.locator('input[data-xover-fc="low"]').fill('90');
  await page.locator('input[data-xover-fc="low"]').dispatchEvent('change');
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.calApp.settings.crossover.high.fc)) === 90, 'linked frequencies move together');
  await page.getByRole('button', { name: 'Calculate alignment' }).click();
  await page.waitForTimeout(500);
  const r = await page.evaluate(`(() => { const r = ${view('align')}.result; const i = r.freqs.findIndex((f) => f >= 90); return { delay: r.delayMs, pol: r.polarity, after: r.after, sub90: r.subDb[i], sum90: r.sumAfterDb[i], text: document.querySelector('.align .info-strip').textContent }; })()`);
  check(Math.abs(r.delay + 2.5) < 0.1 && r.pol === 1, `alignment through the virtual crossover: mains +2.5 ms (${r.delay.toFixed(2)} ms, polarity ${r.pol})`);
  check(Math.abs(r.sub90 + 6) < 0.6 && Math.abs(r.sum90) < 0.6, `sub −6 dB at 90 Hz, flat sum (${r.sub90.toFixed(1)} / ${r.sum90.toFixed(1)} dB)`);
  check(r.text.includes('Crossover: sub LR 24 @ 90 Hz'), 'the summary names the crossover');
  await page.screenshot({ path: `${out}/feat7-03-crossover.png` });
  // Changing the slope re-aligns by itself; LR12 at the same delay needs the sub inverted
  await page.locator('select[data-xover-shape="low"]').selectOption('lr12');
  await page.locator('select[data-xover-shape="high"]').selectOption('lr12');
  await page.waitForTimeout(500);
  const r2 = await page.evaluate(`${view('align')}.result.polarity`);
  check(r2 === -1, 'LR12 re-aligns with the sub inverted');
  await page.locator('[data-xover="toggle"]').click();
  check(!(await page.evaluate(() => window.calApp.settings.crossover.on)), 'the designer turns off');
}

// --- 5. Watermark on the graphs
if (want('watermark')) {
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 100;
    const g = c.getContext('2d');
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 200, 100);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.evaluate(() => window.calApp.setView('spectrum'));
  await page.waitForTimeout(300);
  const pixel = () => page.evaluate(() => {
    const p = window.calApp.views.find((v) => v.id === 'spectrum').rta;
    const c = p.canvas;
    // Middle of the plot, above the spectrum: background, not a curve
    const d = c.getContext('2d').getImageData(Math.round(c.width / 2), Math.round(c.height * 0.3), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  await page.evaluate(() => { window.calApp.engine.running && window.calApp.stop?.(); });
  const before = await pixel();
  await page.evaluate(() => window.calApp.openTools('display'));
  await page.locator('[data-watermark="file"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => window.calApp.settings.watermark.on && window.calApp.settings.watermark.image.startsWith('data:image/png'));
  check(true, 'an uploaded image becomes the watermark');
  await page.locator('.wm-row input[aria-label="Size"]').fill('80');
  await page.locator('.wm-row input[aria-label="Opacity"]').fill('60');
  await page.screenshot({ path: `${out}/feat7-04-watermark-card.png` });
  await page.evaluate(() => window.calApp.setView('spectrum'));
  await page.waitForTimeout(500);
  const after = await pixel();
  check(after[0] > before[0] + 60 && after[0] > after[1] + 40, `the graphs show it (pixel ${before} → ${after})`);
  await page.screenshot({ path: `${out}/feat7-05-watermark.png` });
  await page.evaluate(() => window.calApp.openTools('display'));
  await page.locator('[data-watermark="remove"]').click();
  await page.evaluate(() => window.calApp.setView('spectrum'));
  await page.waitForTimeout(500);
  const gone = await pixel();
  check(Math.abs(gone[0] - before[0]) < 30, 'removing it clears the graphs');
}

// --- 7. Gradient fills on the Spectrum (line and bars)
if (want('gradient')) {
  await page.evaluate(() => window.calApp.setView('spectrum'));
  await page.evaluate(async () => { if (!window.calApp.engine.running) await window.calApp.start(); });
  await page.waitForTimeout(1500);
  check((await page.evaluate(() => window.calApp.settings.rtaFillGradient)) === 'fade', 'the spectrum fill fades by default');
  await page.locator('.view:visible [data-options]').click();
  check(await page.locator('select[data-setting="rtaFillGradient"]').isVisible(), 'Options → Display has the fill style');
  for (const style of ['line', 'bars']) {
    await page.evaluate((st) => (window.calApp.settings.rtaStyle = st), style);
    await page.locator('select[data-setting="rtaFillGradient"]').selectOption('frequency');
    await page.waitForTimeout(600);
    // Bars have gaps: look for the reddest and the bluest pixel along a row low in the plot
    const row = await page.evaluate(() => {
      const c = window.calApp.views.find((v) => v.id === 'spectrum').rta.canvas;
      const d = c.getContext('2d').getImageData(0, Math.round(c.height * 0.85), c.width, 1).data;
      const third = Math.floor(c.width / 3);
      let red = 0;
      let blue = 0;
      for (let x = 0; x < c.width; x++) {
        const [r, g, b] = [d[x * 4], d[x * 4 + 1], d[x * 4 + 2]];
        if (x < third) red = Math.max(red, r - b);
        else if (x > 2 * third) blue = Math.max(blue, b - r);
      }
      return { red, blue };
    });
    check(row.red > 40 && row.blue > 40, `${style}: by frequency, the bass is red and the treble blue/violet (${row.red}, ${row.blue})`);
    await page.locator('select[data-setting="rtaFillGradient"]').selectOption('solid');
    await page.waitForTimeout(400);
  }
  await page.locator('select[data-setting="rtaFillGradient"]').selectOption('fade');
  await page.evaluate(() => (window.calApp.settings.rtaStyle = 'line'));
  await page.keyboard.press('Escape');
}

// --- 8. Console EQ profiles on the EQ tab
if (want('console')) {
  await page.evaluate(() => window.calApp.setView('eq'));
  await page.evaluate(async () => { if (!window.calApp.engine.running) await window.calApp.start(); });
  await page.waitForTimeout(1500);
  await page.locator('select[data-eq-console]').selectOption('ah-dlive');
  await page.getByRole('button', { name: 'Calculate EQ' }).click();
  await page.waitForTimeout(300);
  const eq = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'eq').filters.map((f) => ({ ...f })));
  check(eq.length > 0 && eq.length <= 4, `dLive: at most 4 bands (${eq.length})`);
  check(eq.every((f) => f.gain >= -15 && f.gain <= 15 && f.q >= 0.92 && f.q <= 13), 'within ±15 dB and 1.5 to 1/9 octave');
  const label = await page.locator('.peq label').nth(2).innerText();
  check(label.startsWith('Width') && /oct|1\//.test(label), `width shown in octaves, as on the console (${label.replace(/\s+/g, ' ')})`);
  check((await page.locator('.peq-profile').innerText()).includes('Allen & Heath dLive'), 'the profile and its ranges are shown');
  await page.screenshot({ path: `${out}/feat7-07-console-eq.png` });
  // Typing a width in octaves keeps it (what you enter is what the console gets)
  await page.locator('.peq').first().locator('input').nth(2).fill('0.33');
  await page.locator('.peq').first().locator('input').nth(2).dispatchEvent('change');
  const typed = await page.evaluate(() => { const v = window.calApp.views.find((x) => x.id === 'eq'); const q = v.filters[0].q; return (2 / Math.LN2) * Math.asinh(1 / (2 * q)); });
  check(Math.abs(typed - 0.33) < 0.005 && (await page.locator('.peq').first().locator('.unit').innerText()) === '1/3', `a width typed in octaves stays as typed (${typed.toFixed(3)} oct, shown as 1/3)`);
  await page.locator('select[data-eq-console]').selectOption('midas-pro');
  check((await page.locator('.peq label').nth(2).innerText()).startsWith('Width'), 'Midas PRO: width in octaves too');
  await page.locator('select[data-eq-console]').selectOption('x32-bus');
  check((await page.locator('.peq label').nth(2).innerText()).startsWith('Q'), 'X32: Q');
  await page.locator('select[data-eq-console]').selectOption('yamaha-cl');
  const after = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'eq').filters.every((f) => f.q >= 0.1 && f.q <= 16));
  check(after && (await page.evaluate(() => window.calApp.settings.eqConsole)) === 'yamaha-cl', 'switching console refits the filters and is remembered');
  await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  await page.locator('select[data-eq-console]').selectOption('generic');
}

// --- 6. Trace rows stay inside the sidebar on narrow screens and with larger text
if (want('traces')) {
  await page.evaluate(() => {
    const app = window.calApp;
    const freqs = Array.from(app.grid);
    app.traces.add({ name: 'Sweep In1 17:51:40', kind: 'sweep', freqs, mag: freqs.map(() => -20) });
  });
  for (const [w, zoom] of [[1440, 1], [1024, 1], [1280, 1.25], [900, 1]]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.evaluate((z) => (document.documentElement.style.fontSize = z === 1 ? '' : `${z * 100}%`), zoom);
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => {
      const list = document.querySelector('.trace-list');
      if (!list || !list.getClientRects().length) return null;
      const edge = list.getBoundingClientRect().right;
      let worst = -Infinity;
      for (const b of list.querySelectorAll('.trace button, .trace input')) worst = Math.max(worst, b.getBoundingClientRect().right - edge);
      // The measurement cards too (the delay row's Find button)
      for (const card of document.querySelectorAll('.meas-card')) {
        const cardEdge = card.getBoundingClientRect().right;
        for (const b of card.querySelectorAll('button, input, select')) worst = Math.max(worst, b.getBoundingClientRect().right - cardEdge);
      }
      return worst;
    });
    if (res === null) check(true, `${w} px: the sidebar is a drawer here`);
    else check(res <= 0.5, `${w} px${zoom !== 1 ? ` at ${zoom * 100} % text` : ''}: trace and measurement buttons stay inside the panel (${res.toFixed(1)} px)`);
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${out}/feat7-06-traces.png`, clip: { x: 0, y: 0, width: 300, height: 600 } });
}

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
