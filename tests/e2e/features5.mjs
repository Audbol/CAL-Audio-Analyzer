// End-to-end test of the 1.11 beta features: spectrum colours, detachable SPL panels, room diagnosis and the
// spectrum peak highlights. Usage: npm run build && node tests/e2e/features5.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4187, strictPort: true } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

await page.goto('http://localhost:4187/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(3000);

const mainSeries = () => page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.series.find((x) => x.id === 'm1') ?? null);

// --- 1. Spectrum trace and fill colours
if (want('colours')) {
  await page.keyboard.press('1');
  await page.waitForTimeout(800);
  const s0 = await mainSeries();
  check(s0 && s0.color === '#4d9fff' && s0.fillColor === undefined, `trace uses the measurement colour by default (${s0?.color})`);
  await page.locator('[data-options="spectrum"]').click();
  await page.getByLabel('Spectrum trace colour', { exact: true }).selectOption('#ffd60a');
  await page.getByLabel('Spectrum fill colour', { exact: true }).selectOption('#ff4d6d');
  await page.locator('select[data-setting="rtaFillOpacity"]').selectOption('50');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const s1 = await mainSeries();
  check(s1.color === '#ffd60a' && s1.fillColor === '#ff4d6d' && s1.fillAlpha === 0.5, `line: yellow trace, red fill at 50 % (${s1.color}, ${s1.fillColor}, ${s1.fillAlpha})`);
  await page.keyboard.press('b');
  await page.waitForTimeout(400);
  const s2 = await mainSeries();
  check(s2.bars && s2.color === '#ffd60a' && s2.fillColor === '#ff4d6d', 'bars use the same colours');
  await page.screenshot({ path: `${out}/feat5-01-colours.png` });
  await page.locator('[data-options="spectrum"]').click();
  await page.getByLabel('Spectrum fill colour', { exact: true }).selectOption('none');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await mainSeries()).fillAlpha === 0, 'fill can be turned off');
  // Back to the defaults for the rest of the test
  await page.evaluate(() => { const s = window.calApp.settings; s.rtaTraceColor = 'auto'; s.rtaFillColor = 'auto'; s.rtaFillOpacity = 0; window.calApp.save(); });
  await page.keyboard.press('b');
}

// --- 2. SPL tab: sound level, history and noise log are panels that float and detach
if (want('spl')) {
  await page.keyboard.press('8');
  await page.waitForTimeout(1200);
  const panels = await page.evaluate(() => [...document.querySelectorAll('.view:not([hidden]) .spl .dpanel, .spl .dpanel')].map((p) => p.dataset.panel));
  check(['meter', 'history', 'log'].every((id) => panels.includes(id)), `SPL tab has three panels (${[...new Set(panels)].join(', ')})`);
  await page.locator('.dpanel[data-panel="meter"] [data-act="float"]').first().click();
  await page.waitForTimeout(400);
  check(await page.locator('.dpanel[data-panel="meter"].floating').count() === 1, 'the sound level panel floats');
  await page.locator('.dpanel[data-panel="meter"] [data-act="float"]').first().click();
  await page.waitForTimeout(300);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('.dpanel[data-panel="meter"] [data-act="popout"]').first().click()]);
  await popup.waitForTimeout(1500);
  const a = await popup.evaluate(() => document.querySelector('.spl-big .val')?.textContent ?? '');
  await popup.waitForTimeout(1200);
  const b = await popup.evaluate(() => document.querySelector('.spl-big .val')?.textContent ?? '');
  check(/^-?\d+\.\d$/.test(a) && /^-?\d+\.\d$/.test(b), `the level readout runs in its own window (${a} → ${b})`);
  // It keeps updating while another tab is open in the main window
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  const before = await popup.evaluate(() => document.querySelector('.spl-stats')?.textContent ?? '');
  await popup.waitForTimeout(1500);
  const after = await popup.evaluate(() => document.querySelector('.spl-stats')?.textContent ?? '');
  check(before !== after, 'the detached readout keeps updating while another tab is shown');
  await popup.screenshot({ path: `${out}/feat5-02-spl-detached.png` });
  await popup.close();
  await page.waitForTimeout(500);
  check(await page.evaluate(() => !!document.querySelector('.spl .dpanel[data-panel="meter"]:not(.popped)')), 'closing the window docks the panel again');
}

// --- 3. Room diagnosis from a sweep in the demo room (modes at 47 and 94 Hz, early reflections from 2.3 ms)
if (want('diagnosis')) {
  await page.keyboard.press('5');
  await page.getByRole('button', { name: 'Measure sweep' }).click();
  await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 40000 });
  await page.locator('.room-tabs-row').getByRole('button', { name: 'Diagnosis' }).click();
  await page.waitForTimeout(500);
  const dx = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'room').diagnosis);
  const mode47 = dx.findings.find((f) => f.kind === 'mode' && Math.abs(f.f - 47) < 4);
  check(!!mode47 && mode47.confidence === 'likely', `the 47 Hz room mode is found (${mode47 ? mode47.f.toFixed(1) + ' Hz' : 'none'})`);
  check(dx.reflections.some((r) => Math.abs(r.delayMs - 2.3) < 0.15), `the 2.3 ms floor reflection is found (${dx.reflections.map((r) => r.delayMs.toFixed(1)).join(', ')} ms)`);
  const kinds = new Set(dx.findings.map((f) => f.kind));
  check(kinds.has('mode') && (kinds.has('reflection') || kinds.has('sbir')), `modes and reflections are told apart (${[...kinds].join(', ')})`);
  check((await page.locator('.dx-card').count()) === dx.findings.length && (await page.locator('.dx-card .dx-badge').first().textContent()).length > 0, 'each finding is listed with a text label');
  await page.screenshot({ path: `${out}/feat5-03-diagnosis.png` });
  await page.locator('.room-tabs-row').getByRole('button', { name: 'Frequency response' }).click();
  await page.waitForTimeout(400);
  check(await page.evaluate(() => window.calApp.views.find((v) => v.id === 'room').fr.markers.length > 0), 'findings are marked on the frequency response');
  await page.screenshot({ path: `${out}/feat5-04-diagnosis-markers.png` });
}

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
