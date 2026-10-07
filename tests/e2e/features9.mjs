// End-to-end test of the 2.0.2 measurement additions: distortion from sweeps, the loudness meter (LUFS), air
// absorption compensation and the EQ board.
// Usage: npm run build && node tests/e2e/features9.mjs [outDir]   (ONLY=thd,lufs,… runs some sections)
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4196, strictPort: true } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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

await page.goto('http://localhost:4196/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(4000);


// --- 1. Distortion from the sweep: its own tab, THD and harmonics in %, the figures and the measurement floor
if (want('thd')) {
  await page.evaluate(() => window.calApp.setView('room'));
  await page.getByRole('button', { name: 'Measure sweep' }).click();
  await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Distortion', exact: true }).click();
  await page.waitForTimeout(500);
  const d = await page.evaluate((v) => {
    const room = eval(v);
    const ids = room.thdPlot.series.map((s) => s.id);
    const thd = room.thdPlot.series.find((s) => s.id === 'thd').y;
    const floor = room.thdPlot.series.find((s) => s.id === 'floor').y;
    const finite = [...thd].filter(Number.isFinite);
    return { ids, n: finite.length, max: Math.max(...finite), floorFinite: [...floor].some(Number.isFinite), figs: document.querySelector('.thd-info').innerText, fr: room.fr.series.map((s) => s.id) };
  }, view('room'));
  check(['floor', 'thd', 'h2', 'h3', 'h4', 'h5'].every((id) => d.ids.includes(id)), `THD, harmonics 2–5 and the floor are drawn (${d.ids.join(', ')})`);
  check(d.n > 50 && d.max < 100 && d.floorFinite, `THD in percent over the sweep's range (${d.n} points, max ${d.max.toFixed(1)} %)`);
  check(/THD 1 kHz/.test(d.figs) && /Sweep at -?\d+ dBFS/.test(d.figs), 'the figures and the sweep level are shown');
  check(!d.fr.includes('h2') && !d.fr.includes('thd'), 'the frequency response graph shows only the response now');
  await page.screenshot({ path: `${out}/feat9-01-distortion.png` });
}

// --- 2. Loudness (LUFS): hidden until shown, measures the chosen input, resets
if (want('lufs')) {
  await page.evaluate(() => window.calApp.setView('spl'));
  check(await page.evaluate(() => !window.calApp.settings.splLayout?.order.includes('loudness') || window.calApp.settings.splLayout.hidden.includes('loudness')), 'the loudness panel starts hidden');
  await page.locator('[data-loudness-panel]').click();
  check(await page.locator('[data-loudness="toggle"]').isVisible(), 'the Loudness chip shows it');
  check(await page.evaluate(() => window.calApp.loudness.reading().duration === 0), 'it measures nothing until switched on');
  await page.locator('[data-loudness="toggle"]').click();
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => window.calApp.loudness.reading());
  check(r.duration > 3 && Number.isFinite(r.shortTerm) && Number.isFinite(r.integrated) && Number.isFinite(r.truePeak), `short-term, integrated and true peak (${r.shortTerm.toFixed(1)} LUFS, ${r.integrated.toFixed(1)} LUFS, ${r.truePeak.toFixed(1)} dBTP over ${r.duration.toFixed(1)} s)`);
  const shown = await page.evaluate(() => document.querySelector('.ld-panel').innerText);
  check(/Integrated/.test(shown) && /(below|above|on) target/.test(shown) && /True peak/.test(shown), 'the panel shows integrated against the target, momentary, range and true peak');
  await page.locator('[data-loudness="reset"]').click();
  check(await page.evaluate(() => window.calApp.loudness.reading().duration < 0.5), 'Reset starts it again');
  await page.locator('[data-loudness="toggle"]').click();
  check(await page.evaluate(() => !window.calApp.settings.loudness.on), 'Pause stops measuring');
  await page.screenshot({ path: `${out}/feat9-02-lufs.png` });
}

// --- 3. Air absorption: the Tools card, the table, and the compensation on the measurement's magnitude
if (want('air')) {
  await page.evaluate(() => window.calApp.openTools('setup'));
  await page.waitForTimeout(300);
  check(await page.locator('.air-card').isVisible(), 'Tools → Setup has the Air card');
  // A long throw, so the effect is clear: 40 m set as the distance
  await page.locator('[data-air="distance"]').fill('40');
  await page.locator('[data-air="distance"]').press('Tab');
  const table = await page.locator('.air-table').innerText();
  check(/40\.0 m/.test(table) && /16 kHz/.test(table), `the table shows the loss at 40 m (${table.replace(/\s+/g, ' ').slice(0, 90)}…)`);
  await page.evaluate(() => window.calApp.setView('transfer'));
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => { const a = window.calApp; const m = a.measurements[0]; const i = a.grid.findIndex((f) => f >= 10000); return m.mag[i]; });
  await page.evaluate(() => window.calApp.openTools('setup'));
  await page.locator('[data-air="compensate"]').check();
  await page.evaluate(() => window.calApp.setView('transfer'));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => { const a = window.calApp; const m = a.measurements[0]; const i = a.grid.findIndex((f) => f >= 10000); return m.mag[i]; });
  const expected = await page.evaluate(() => window.calApp.correctionFor(window.calApp.settings.measurements[0])[window.calApp.grid.findIndex((f) => f >= 10000)]);
  check(after - before > 3 && Math.abs(after - before - expected) < 1.5, `compensation adds the air loss at 10 kHz (+${(after - before).toFixed(1)} dB, expected ${expected.toFixed(1)})`);
  check(await page.evaluate(() => document.querySelector('input[data-air-quick]')?.checked === true), 'the Transfer options switch shows it');
  await page.evaluate(() => { const a = window.calApp; a.settings.air.compensate = false; a.settings.air.distance = 0; a.airChanged(); });
}

// --- 4. The EQ board: every band in large type in its own window, live, tap to mark as entered
if (want('board')) {
  await page.evaluate(() => window.calApp.setView('eq'));
  await page.locator('select[data-eq-console]').selectOption('yamaha-cl');
  await page.locator('select[data-eq-target]').selectOption('flat');
  await page.getByRole('button', { name: 'Calculate EQ' }).click();
  await page.waitForTimeout(600);
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.locator('[data-eq-board]').click()]);
  await pop.setViewportSize({ width: 1200, height: 700 });
  await pop.waitForTimeout(600);
  const bands = await pop.$$eval('.eq-board-band', (bs) => bs.map((b) => b.dataset.band));
  check(bands.join() === 'LOW,LOW-MID,HIGH-MID,HIGH', `one row per band, named as on the console (${bands.join(', ')})`);
  const size = await pop.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.eq-board-value')).fontSize));
  check(size >= 40, `the numbers are large (${size.toFixed(0)} px)`);
  await pop.locator('.eq-board-band').first().click();
  check(await pop.evaluate(() => document.querySelector('.eq-board-band').classList.contains('entered')), 'tapping a band marks it as entered');
  // Editing a band in the EQ tab updates the board, and its mark goes
  await page.evaluate(() => { const eq = window.calApp.views.find((v) => v.id === 'eq'); eq.filters[0].gain = -1.5; eq.invalidate(); });
  await page.waitForTimeout(500);
  const first = await pop.evaluate(() => ({ text: document.querySelector('.eq-board-band').innerText, entered: document.querySelector('.eq-board-band').classList.contains('entered') }));
  check(/-1\.5 dB/.test(first.text) && !first.entered, `the board follows the EQ tab live (${first.text.replace(/\s+/g, ' ')})`);
  await pop.screenshot({ path: `${out}/feat9-04-board.png` });
  await pop.close();
}

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
