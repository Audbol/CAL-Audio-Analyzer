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
  // The readout scales with the panel: bigger panel, bigger numbers
  const fontAt = (w, hgt) =>
    page.evaluate(([w, hgt]) => {
      const p = document.querySelector('.dpanel[data-panel="meter"]');
      Object.assign(p.style, { width: `${w}px`, height: `${hgt}px` });
      return new Promise((r) => requestAnimationFrame(() => r(parseFloat(getComputedStyle(document.querySelector('.spl-big .val')).fontSize))));
    }, [w, hgt]);
  const small = await fontAt(420, 180);
  const large = await fontAt(1000, 480);
  check(large > small * 1.8, `the level readout grows with its panel (${small.toFixed(0)} px → ${large.toFixed(0)} px)`);
  const fits = await page.evaluate(() => [...document.querySelectorAll('.spl-fit .stat b, .spl-fit .spl-big .val')].every((b) => b.scrollWidth <= b.parentElement.clientWidth + 1));
  check(fits, 'every reading fits its card');
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

// --- 4. Spectrum: the highest peak in the low, mid and high ranges is highlighted
if (want('peaks')) {
  await page.keyboard.press('1');
  await page.waitForTimeout(2500);
  const pk = await page.evaluate(() => {
    const v = window.calApp.views.find((x) => x.id === 'spectrum');
    return { peaks: v.peaks.map((p) => ({ r: p.range.id, f: p.f, l: p.level })), pins: v.rta.pins.map((p) => p.label) };
  });
  check(pk.peaks.map((p) => p.r).join() === 'low,mid,high', `one peak per range (${pk.pins.join(' | ')})`);
  check(pk.peaks[0].f >= 20 && pk.peaks[0].f < 250 && pk.peaks[1].f >= 250 && pk.peaks[1].f < 4000 && pk.peaks[2].f >= 4000, 'each peak lies in its own range');
  // The demo room's strongest low-frequency feature is its 47 Hz mode region (between 40 and 110 Hz)
  check(pk.peaks[0].f > 40 && pk.peaks[0].f < 110, `the low peak is in the room-mode region (${pk.peaks[0].f.toFixed(0)} Hz)`);
  await page.screenshot({ path: `${out}/feat5-05-peaks.png` });
  await page.locator('.toolbar button[data-chip="rtaPeakMarks"]').first().click();
  await page.waitForTimeout(400);
  check(await page.evaluate(() => window.calApp.views.find((x) => x.id === 'spectrum').rta.pins.length === 0), 'the Peaks button turns the highlights off');
  await page.locator('.toolbar button[data-chip="rtaPeakMarks"]').first().click();
  await page.keyboard.press('b');
  await page.waitForTimeout(600);
  check(await page.evaluate(() => window.calApp.views.find((x) => x.id === 'spectrum').rta.pins.length === 3), 'peaks are highlighted on bars too');
  await page.keyboard.press('b');
}

// --- 5. Several mics: each average curve in its own (lightened) colour with its own dash pattern
if (want('avgmulti')) {
  await page.keyboard.press('1');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.waitForTimeout(4000);
  const avgs = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.series.filter((x) => x.id.endsWith('-avg')).map((x) => ({ c: x.color, d: JSON.stringify(x.dash ?? null), l: x.label })));
  check(avgs.length === 2, `two average curves (${avgs.map((a) => a.l).join(', ')})`);
  check(avgs.length === 2 && avgs[0].c !== avgs[1].c && avgs[0].d !== avgs[1].d && avgs.every((a) => a.c !== '#ffffff'), `they differ in colour and dash pattern (${avgs.map((a) => `${a.c} ${a.d}`).join(' | ')})`);
  await page.screenshot({ path: `${out}/feat5-06-avg-multi.png` });
  // Back to one measurement: the single average curve is white again
  await page.evaluate(() => { const a = window.calApp; a.removeMeasurement?.(a.settings.measurements[1].id); });
  await page.waitForTimeout(1500);
  const one = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.series.filter((x) => x.id.endsWith('-avg')).map((x) => x.color));
  if (one.length === 1) check(one[0] === '#ffffff', 'a single average curve is white again');
}

// --- 6. Reference toggle (Tools → Setup), Tools sections and the Room modes tab
if (want('tools')) {
  await page.keyboard.press('9');
  await page.locator('[data-section="setup"]').click();
  const refs = () => page.evaluate(() => window.calApp.settings.measurements.map((m) => m.ref));
  check((await refs()).every((r) => r === 1), 'the demo starts with the loopback reference (In 2)');
  await page.locator('[data-ref="internal"]').click();
  await page.waitForTimeout(3500);
  const internal = await page.evaluate(() => ({ refs: window.calApp.settings.measurements.map((m) => m.ref), pressed: document.querySelector('[data-ref="internal"]').getAttribute('aria-pressed'), coh: (() => { const m = window.calApp.measurements[0]; const g = window.calApp.grid; let c = 0, n = 0; g.forEach((f, i) => { if (f > 300 && f < 8000) { c += m.result.coh[i]; n++; } }); return c / n; })() }));
  check(internal.refs.every((r) => r === -1) && internal.pressed === 'true', 'one switch moves every measurement to the internal reference');
  check(internal.coh > 0.5, `the delay is measured again and coherence recovers (${internal.coh.toFixed(2)})`);
  await page.locator('[data-ref="loopback"]').click();
  await page.waitForTimeout(400);
  check((await refs()).every((r) => r === 1), 'and back to the loopback input');
  // Sections: one at a time
  for (const [id, text] of [['session', 'Create report'], ['remote', 'Remote access'], ['display', 'Battery saver'], ['calc', 'Delay · distance'], ['data', 'Reset all settings']]) {
    await page.locator(`[data-section="${id}"]`).click();
    const body = await page.locator('.tools-body').textContent();
    check(body.includes(text) && (id === 'setup' || !body.includes('Microphones & calibration')), `Tools → ${id} shows only its own section`);
  }
  await page.screenshot({ path: `${out}/feat5-07-tools.png` });
  // Room modes: in Tools → Calculators, dimensions kept, the last sweep compared with the modes
  await page.locator('[data-section="calc"]').click();
  await page.waitForTimeout(600);
  check((await page.locator('.tools-body .modes-card canvas').count()) === 2, 'the room mode calculator is in Tools → Calculators');
  await page.getByLabel('Length (m)').fill('7.3');
  await page.getByLabel('Length (m)').dispatchEvent('change');
  await page.waitForTimeout(400);
  const room = await page.evaluate(() => window.calApp.settings.room);
  check(room.L === 7.3 && room.known, 'room dimensions are kept');
  await page.screenshot({ path: `${out}/feat5-08-modes.png` });
}

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
