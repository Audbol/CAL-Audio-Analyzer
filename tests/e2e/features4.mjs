// End-to-end test of the average curve style, battery saver, target on Sweep & Room and resetting to defaults.
// Usage: npm run build && node tests/e2e/features4.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4186, strictPort: true } });
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

await page.goto('http://localhost:4186/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(3000);

// --- Average curve: hide, colour, thickness
await page.keyboard.press('1');
await page.waitForTimeout(1500);
const avgSeries = () => page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.series.find((x) => x.id.endsWith('-avg')) ?? null);
const a0 = await avgSeries();
check(!!a0 && a0.color === '#ffffff' && a0.width === 2, `average curve drawn white, 2 px (${a0?.color}, ${a0?.width})`);
await page.locator('.toolbar button[data-chip="avgCurveShow"]').first().click();
await page.waitForTimeout(300);
check((await avgSeries()) === null && (await page.evaluate(() => window.calApp.measurements[0].averageFrames > 0)), 'eye button hides the average curve; it keeps averaging');
await page.locator('.toolbar button[data-chip="avgCurveShow"]').first().click();
await page.locator('[data-options="spectrum"]').click();
await page.locator('select[data-setting="avgCurveColor"]').selectOption('#ffd60a');
await page.locator('select[data-setting="avgCurveWidth"]').selectOption('4');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const a1 = await avgSeries();
check(!!a1 && a1.color === '#ffd60a' && a1.width === 4, `average curve yellow, 4 px (${a1?.color}, ${a1?.width})`);
check(await page.locator('.opt-panel [data-chip="avgCurveShow"].on').count() === 1, 'options panel chip follows the eye button');
await page.screenshot({ path: `${out}/feat4-01-average-style.png` });

// --- Battery saver
const rate = () =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const m = window.calApp.measurements[0];
        const v0 = m.rtaShown;
        const d0 = window.calApp.views.find((v) => v.id === 'spectrum').rta;
        let draws = 0;
        const orig = d0.draw.bind(d0);
        d0.draw = () => { draws++; orig(); };
        setTimeout(() => { d0.draw = orig; res({ spectra: (m.rtaShown - v0) / 2, draws: draws / 2, hop: m.rta.main.hop, saving: window.calApp.powerSaving }); }, 2000);
      }),
  );
const normal = await rate();
await page.keyboard.press('9');
await page.locator('[data-section="display"]').click();
await page.locator('select[data-setting="powerMode"]').selectOption('saver');
await page.keyboard.press('1');
await page.waitForTimeout(1000);
const saver = await rate();
check(normal.draws >= 18 && normal.hop < 2000, `normal: ${normal.draws} spectrum redraws/s, hop ${normal.hop}`);
check(saver.saving && saver.draws <= 17 && saver.draws >= 8 && saver.hop >= 4000, `battery saver: ${saver.draws} redraws/s, hop ${saver.hop}`);
check(/battery saver/.test(await page.locator('.statusbar, .status').first().textContent().catch(() => '')) || (await page.evaluate(() => document.body.textContent.includes('battery saver'))), 'status bar shows the battery saver');
const splOk = await page.evaluate(() => { const r = window.calApp.splReading; return Number.isFinite(r.level) && r.level > -60; });
check(splOk, 'SPL meter keeps measuring in battery saver');
await page.keyboard.press('9');
await page.locator('[data-section="display"]').click();
await page.locator('select[data-setting="powerMode"]').selectOption('normal');
check(!(await page.evaluate(() => window.calApp.powerSaving)) && (await page.evaluate(() => window.calApp.measurements[0].rta.main.hop)) < 2000, 'battery saver off restores the full rate');

// --- Target curve on Sweep & Room
await page.keyboard.press('5');
await page.getByRole('button', { name: 'Measure sweep' }).click();
await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 30000 });
await page.locator('select[data-setting="roomTargetCurve"]').selectOption('house');
await page.waitForTimeout(400);
const rt = await page.evaluate(() => {
  const a = window.calApp;
  const fr = a.views.find((v) => v.id === 'room').fr.series;
  return { ids: fr.map((x) => x.id), live: a.settings.targetCurve, room: a.settings.roomTargetCurve };
});
check(rt.ids.includes('target') && rt.ids.includes('target-band') && rt.ids.includes('fr'), `target and tolerance band on the sweep response (${rt.ids.join(', ')})`);
check(rt.room === 'house' && rt.live === 'off', 'Sweep & Room has its own target choice');
await page.locator('select[data-setting="roomTargetCurve"]').selectOption('off');
await page.waitForTimeout(300);
check(!(await page.evaluate(() => window.calApp.views.find((v) => v.id === 'room').fr.series.some((x) => x.id === 'target'))), 'target off removes it');
await page.locator('select[data-setting="roomTargetCurve"]').selectOption('house');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/feat4-02-room-target.png` });

// --- Reset analysis & display to a profile: setup stays
await page.keyboard.press('9');
await page.locator('[data-section="setup"]').click();
await page.getByRole('button', { name: 'Add microphone' }).click();
await page.locator('[data-section="data"]').click();
await page.evaluate(() => { const s = window.calApp.settings; s.tfSmoothing = 3; s.rtaStyle = 'bars'; window.calApp.save(); });
const before = await page.evaluate(() => ({ mics: window.calApp.settings.mics.length, pin: window.calApp.settings.remoteServer.pin, meas: window.calApp.settings.measurements.length }));
await page.locator('select[data-reset="profile"]').selectOption('dual-fft');
page.once('dialog', (d) => d.accept());
await Promise.all([page.waitForEvent('load'), page.locator('button[data-reset="go"]').click()]);
await page.waitForFunction(() => !!window.calApp);
const after = await page.evaluate(() => { const s = window.calApp.settings; return { tf: s.tfSmoothing, avg: s.tfAveraging, mag: s.magRange, style: s.rtaStyle, curve: s.rtaAverageCurve, room: s.roomTargetCurve, width: s.avgCurveWidth, mics: s.mics.length, pin: s.remoteServer.pin, meas: s.measurements.length, wizard: s.wizardDone }; });
check(after.tf === 12 && after.avg === 16 && after.mag.join() === '-18,18' && after.style === 'line' && after.curve === 0 && after.room === 'off' && after.width === 2, `classic dual-FFT profile applied (${JSON.stringify(after)})`);
check(after.mics === before.mics && after.pin === before.pin && after.meas === before.meas && after.wizard, 'microphones, remote PIN and measurements kept');

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
