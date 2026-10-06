// End-to-end test of the 2.0.2 tuning additions: custom target curves, the high-pass in the EQ assistant,
// checking the EQ against its prediction, weighted averages, and system presets.
// Usage: npm run build && node tests/e2e/features8.mjs [outDir]   (ONLY=targets,hpf,… runs some sections)
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4192, strictPort: true } });
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

await page.goto('http://localhost:4192/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(4000);

// --- 1. Custom target curves: made in the editor from the EQ tab, used everywhere targets are
if (want('targets')) {
  await page.evaluate(() => window.calApp.setView('eq'));
  await page.locator('select[data-eq-target]').selectOption('__edit-targets');
  await page.locator('[data-target-edit="start"]').selectOption('live-rock');
  await page.locator('[data-target-edit="name"]').fill('FOH rock +2');
  // Raise the 63 Hz point by 2 dB
  const row = page.locator('.tgt-row').filter({ has: page.locator('input[value="63"]') });
  const lvl = row.locator('input').nth(1);
  const v63 = +(await lvl.inputValue());
  await lvl.fill(String(v63 + 2));
  await lvl.press('Tab');
  await page.screenshot({ path: `${out}/feat8-01-target-editor.png` });
  await page.locator('[data-target-edit="save"]').click();
  const t = await page.evaluate(() => {
    const s = window.calApp.settings;
    const c = s.customTargets[0];
    return { n: s.customTargets.length, name: c?.name, p63: c?.points.find((p) => p[0] === 63)?.[1], eq: document.querySelector('select[data-eq-target]').value };
  });
  check(t.n === 1 && t.name === 'FOH rock +2', `a custom target is saved (${JSON.stringify(t)})`);
  check(Math.abs(t.p63 - (v63 + 2)) < 0.01, 'the edited point is kept');
  check(t.eq.startsWith('custom:'), 'the EQ tab uses it straight away');
  // On the Spectrum and Transfer target lists too, and drawn
  await page.evaluate(() => window.calApp.setView('transfer'));
  await page.waitForTimeout(300);
  const opts = await page.$$eval('select.target-select:visible option', (os) => os.map((o) => o.textContent));
  check(opts.includes('FOH rock +2') && opts.includes('Custom targets…'), 'the Transfer target list has it and the editor');
  await page.locator('select.target-select:visible').first().selectOption({ label: 'FOH rock +2' });
  await page.waitForTimeout(800);
  check(await page.evaluate(() => window.calApp.views.find((v) => v.id === 'transfer').el.textContent.length > 0 && window.calApp.settings.targetCurve.startsWith('custom:')), 'the Transfer view draws the custom target');
  // Import a text file
  await page.evaluate(() => window.calApp.setView('eq'));
  await page.locator('select[data-eq-target]').selectOption('__edit-targets');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import…' }).click()]);
  await chooser.setFiles({ name: 'speech-room.txt', mimeType: 'text/plain', buffer: Buffer.from('# my speech target\n20 -12\n100 -2\n1000 0\n3000 2\n10000 -3\n') });
  await page.waitForTimeout(300);
  check((await page.locator('[data-target-edit="name"]').inputValue()) === 'speech-room', 'a text file imports as a new target');
  await page.locator('[data-target-edit="save"]').click();
  check(await page.evaluate(() => window.calApp.settings.customTargets.length === 2), 'and saves');
}

// --- 2. High-pass: suggested where the target rolls off in the bass, without spending a band
if (want('hpf')) {
  await page.evaluate(() => window.calApp.setView('eq'));
  await page.locator('select[data-eq-console]').selectOption('yamaha-cl');
  await page.locator('select[data-eq-target]').selectOption('speech');
  await page.getByRole('button', { name: 'Calculate EQ' }).click();
  await page.waitForTimeout(800);
  const r = await page.evaluate((v) => {
    const eq = eval(v);
    return { types: eq.filters.map((f) => f.type), hp: eq.filters.find((f) => f.type === 'highpass') };
  }, view('eq'));
  check(r.types[0] === 'highpass' && [12, 24].includes(r.hp?.slope), `a high-pass first, with a slope the console has (${JSON.stringify(r)})`);
  check(r.types.filter((t) => t !== 'highpass').length <= 4, 'the four bands are still there for the rest');
  check(await page.locator('.peq-hp').count() === 1, 'the list shows the high-pass with its frequency and slope');
  await page.screenshot({ path: `${out}/feat8-02-hpf.png` });
  check(/^HP$/.test((await page.locator('.peq-hp .idx').textContent()) ?? ''), 'labelled HP, the bands keep their console names');
  // Never: no high-pass
  await page.locator('[data-options="eq"]').click();
  await page.locator('select[data-eq-hpf]').selectOption('off');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Calculate EQ' }).click();
  await page.waitForTimeout(600);
  check(!(await page.evaluate((v) => eval(v).filters.some((f) => f.type === 'highpass'), view('eq'))), 'with High-pass: Never there is none');
  await page.locator('[data-options="eq"]').click();
  await page.locator('select[data-eq-hpf]').selectOption('auto');
  await page.keyboard.press('Escape');
  await page.locator('select[data-eq-console]').selectOption('generic');
}

// --- 3. Check the result: a new measurement against the prediction
if (want('verify')) {
  await page.evaluate(() => window.calApp.setView('eq'));
  await page.locator('select[data-eq-target]').selectOption('flat');
  await page.getByRole('button', { name: 'Calculate EQ' }).click();
  await page.waitForTimeout(800);
  check(await page.locator('.eq-verify').isVisible(), 'after Calculate EQ the check appears');
  await page.locator('[data-eq-verify="compare"]').click();
  await page.waitForTimeout(500);
  const v = await page.evaluate((x) => {
    const eq = eval(x);
    return { has: !!eq.verify, series: eq.plot.series.map((s) => s.id), text: document.querySelector('.eq-verify-out').textContent };
  }, view('eq'));
  // The demo has no EQ in the chain, so the measurement differs from the prediction by the EQ itself
  check(v.has && v.series.includes('verify'), `the measured result is drawn with the prediction (${v.series.join(', ')})`);
  check(/RMS from the target/.test(v.text) && /prediction/.test(v.text), `and summarised (${v.text.slice(0, 140)}…)`);
  await page.screenshot({ path: `${out}/feat8-03-verify.png` });
  await page.locator('[data-eq-verify="clear"]').click();
  check(!(await page.evaluate((x) => eval(x).verify, view('eq'))), 'Clear removes it');
}

// --- 4. Weighted averages: live several-mic average and the trace average
if (want('weights')) {
  await page.evaluate(() => window.calApp.setView('transfer'));
  await page.evaluate(() => window.calApp.addMeasurement({ name: 'Row 12', mic: 0, ref: 1 }));
  await page.waitForTimeout(2500);
  const sel = page.locator('select[data-meas-weight]').first();
  check(await sel.isVisible(), 'with two measurements each card has a weight');
  await sel.selectOption('2');
  check(await page.evaluate(() => window.calApp.settings.measurements[0].weight === 2), 'the weight is kept with the measurement');
  await page.evaluate(() => { window.calApp.settings.micAverage = 'avg'; window.calApp.syncSettingControls(); });
  await page.waitForTimeout(800);
  const lbl = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'transfer').mag.series.find((s) => s.id === 'mic-avg')?.label);
  check(/weighted/.test(lbl ?? ''), `the live average says it is weighted (${lbl})`);
  // Trace average with weights
  await page.evaluate(() => {
    const app = window.calApp;
    for (const m of app.measurements) app.captureTrace(m, 'tf');
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const app = window.calApp;
    for (const t of app.traces.traces) app.selectedTraces.add(t.id);
  });
  await page.getByRole('button', { name: 'Avg', exact: true }).click();
  await page.locator('[data-avg="name"]').fill('FOH-weighted');
  await page.locator('select[data-avg-weight]').first().selectOption('3');
  await page.screenshot({ path: `${out}/feat8-04-avg.png` });
  await page.locator('[data-avg="make"]').click();
  const avg = await page.evaluate(() => window.calApp.traces.traces.find((t) => t.name === 'FOH-weighted'));
  check(!!avg && /Weighted power average/.test(avg.note), `a weighted average trace (${avg?.note})`);
  await page.evaluate(() => {
    const app = window.calApp;
    app.settings.micAverage = 'off';
    app.removeMeasurement(app.settings.measurements[1].id);
  });
}

// --- 5. System presets: save the setup, change it, load it back; export and import
if (want('presets')) {
  await page.evaluate(() => window.calApp.openTools('session'));
  await page.waitForTimeout(300);
  await page.locator('[data-preset="name"]').fill('Arena rig');
  await page.locator('[data-preset="save"]').click();
  const saved = await page.evaluate(() => window.calApp.settings.presets.map((p) => ({ name: p.name, n: p.measurements.length, first: p.measurements[0].name })));
  check(saved.length === 1 && saved[0].name === 'Arena rig', `a preset is saved (${JSON.stringify(saved)})`);
  // Change the setup, then load the preset back
  await page.evaluate(() => {
    const app = window.calApp;
    app.settings.measurements[0].name = 'Changed';
    app.settings.targetCurve = 'flat';
    app.save();
    app.renderMeasurements();
  });
  await page.locator('[data-preset="load"]').click();
  await page.screenshot({ path: `${out}/feat8-05-preset-load.png` });
  await page.locator('[data-preset="confirm"]').click();
  await page.waitForTimeout(500);
  const back = await page.evaluate(() => ({ name: window.calApp.settings.measurements[0].name, target: window.calApp.settings.targetCurve }));
  check(back.name === saved[0].first, `loading it brings the measurements back (${JSON.stringify(back)})`);
  // Rename in place
  await page.locator('[data-preset="rename"]').click();
  await page.locator('[data-preset="rename-input"]').fill('Arena rig 2026');
  await page.locator('[data-preset="rename-input"]').press('Enter');
  check(await page.evaluate(() => window.calApp.settings.presets[0].name === 'Arena rig 2026'), 'rename in place');
  // Export and import
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-preset="export"]').click()]);
  const file = await dl.path();
  const text = fs.readFileSync(file, 'utf8');
  check(/"format": ?"cal-preset"/.test(text) && dl.suggestedFilename().endsWith('.calpreset.json'), `exports a preset file (${dl.suggestedFilename()})`);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.presets-card').getByRole('button', { name: 'Import…' }).click()]);
  await chooser.setFiles({ name: 'rig.calpreset.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.calApp.settings.presets.length === 2), 'and imports it');
  await page.screenshot({ path: `${out}/feat8-05-presets.png` });
  // From the menu
  await page.evaluate(() => window.calApp.setView('transfer'));
  await page.locator('[data-options="app"]').click();
  await page.locator('.app-menu [data-menu="presets"]').click();
  check(await page.locator('.presets-card').isVisible(), 'the menu opens System presets');
}

// --- 6. Safety: starting audio never starts the generator by itself (a real input, not the demo room)
if (want('safety')) {
  await page.evaluate(() => window.calApp.selectSource('__default'));
  await page.waitForFunction(() => window.calApp.engine.running && !window.calApp.settings.simulate, null, { timeout: 10000 });
  await page.evaluate(() => window.calApp.setGenerator({ type: 'pink' }));
  check(await page.evaluate(() => window.calApp.settings.generator.type === 'pink'), 'pink noise on (by the user)');
  // A restart for a new input while it plays keeps it
  await page.evaluate(() => window.calApp.selectSource('__default'));
  await page.waitForFunction(() => window.calApp.engine.running, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  check(await page.evaluate(() => window.calApp.settings.generator.type === 'pink'), 'switching the input while it plays keeps the signal');
  await page.evaluate(() => window.calApp.stop());
  check(await page.evaluate(() => window.calApp.settings.generator.type === 'off'), 'stopping audio turns the generator off');
  // Even with a signal left in the settings (an older version, another device), Start is silent
  await page.evaluate(() => { window.calApp.settings.generator.type = 'pink'; window.calApp.save(); });
  await page.evaluate(() => { const e = window.calApp.engine; window.__posted = []; const orig = e.setGenerator.bind(e); e.setGenerator = (c) => { window.__posted.push(c.type); return orig(c); }; });
  await page.evaluate(() => window.calApp.start());
  await page.waitForFunction(() => window.calApp.engine.running, null, { timeout: 10000 });
  check(await page.evaluate(() => window.calApp.settings.generator.type === 'off'), 'starting audio starts with the generator off');
  // What the audio engine was told to play when audio started
  await page.waitForTimeout(800);
  const posted = await page.evaluate(() => window.__posted);
  check(posted.length > 0 && posted.every((t) => t === 'off'), `the engine is only ever told “off” (${posted.join(', ')})`);
  await page.evaluate(() => window.calApp.toggleGenerator());
  check(await page.evaluate(() => window.calApp.settings.generator.type === 'pink'), 'On brings back the last signal');
  await page.evaluate(() => { window.calApp.toggleGenerator(); window.calApp.selectSource('__demo'); });
  await page.waitForTimeout(1500);
}

// --- 7. The app is pinned to the screen: the page can't be left scrolled (touches would land off target)
if (want('viewport')) {
  const pin = await page.evaluate(() => {
    window.scrollTo(0, 300);
    document.scrollingElement.scrollTop = 300;
    const r = document.getElementById('app').getBoundingClientRect();
    return { y: window.scrollY, top: r.top, h: Math.round(r.height), vh: window.innerHeight };
  });
  check(pin.y === 0 && pin.top === 0 && pin.h === pin.vh, `the page never scrolls and the app fills the screen (${JSON.stringify(pin)})`);
  // In fullscreen a tap at a tab's drawn position opens that tab
  await page.evaluate(() => document.documentElement.requestFullscreen());
  await page.waitForTimeout(900);
  const box = await page.locator('.tabs .tab[data-view="spl"]').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  check((await page.evaluate(() => window.calApp.settings.view)) === 'spl', 'in fullscreen, tapping where a tab is drawn opens it');
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForTimeout(500);
}

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
