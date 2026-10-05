// End-to-end test of the beta 4 features: group delay, guided multi-position sweeps, before/after compare and
// notes on graphs. Usage: npm run build && node tests/e2e/features6.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4188, strictPort: true } });
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

await page.goto('http://localhost:4188/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(3000);

// --- 1. Group delay on the Transfer tab
if (want('gd')) {
  await page.keyboard.press('2');
  await page.waitForTimeout(4000);
  await page.locator('[data-options="transfer"]').click();
  await page.locator('.opt-wrap.open').getByRole('button', { name: 'Group delay' }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  const gd = await page.evaluate(() => {
    const v = window.calApp.views.find((x) => x.id === 'transfer');
    const s = v.gd.series.find((x) => x.id === 'm1');
    if (!s) return null;
    const at = (f) => { let k = 0; for (let i = 0; i < s.x.length; i++) if (Math.abs(Math.log(s.x[i] / f)) < Math.abs(Math.log(s.x[k] / f))) k = i; return s.y[k]; };
    return { mid: at(2000), low: at(60) };
  });
  check(gd && Number.isFinite(gd.mid) && Math.abs(gd.mid) < 3, `group delay is near 0 ms in the mids with the delay compensated (${gd?.mid?.toFixed(2)} ms at 2 kHz)`);
  check(gd && Number.isFinite(gd.low) && gd.low > gd.mid, `the bass arrives later than the mids (${gd?.low?.toFixed(1)} ms at 60 Hz)`);
  await page.screenshot({ path: `${out}/feat6-01-group-delay.png` });
}

// --- 2. Guided sweeps at several mic positions, averaged into one trace
if (want('positions')) {
  await page.keyboard.press('5');
  await page.waitForTimeout(500);
  await page.locator('select[data-sweep="positions"]').selectOption('3');
  await page.locator('.room .toolbar').getByLabel('Sweep', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Measure 3 positions' }).click();
  const sweepDone = (k) => page.waitForSelector('.series-bar:not([hidden]) [data-series="go"]', { timeout: 40000 }).then(() => k);
  await sweepDone(1);
  check((await page.locator('.series-bar .series-step.done').count()) === 1, 'after the first sweep the user is asked to move the mic');
  check(await page.getByRole('button', { name: 'Measure 3 positions' }).isHidden(), 'the main Measure button steps aside while the prompt is shown');
  await page.screenshot({ path: `${out}/feat6-02-positions.png` });
  await page.locator('[data-series="go"]').click();
  await sweepDone(2);
  check(await page.locator('[data-series="finish"]').isVisible(), 'after two positions the series can be finished early');
  await page.locator('[data-series="go"]').click();
  await page.waitForFunction(() => window.calApp.traces.traces.some((t) => t.name.startsWith('Spatial average (3 positions)')), null, { timeout: 40000 });
  const tr = await page.evaluate(() => window.calApp.traces.traces.map((t) => ({ name: t.name, visible: t.visible, kind: t.kind })));
  check(tr.filter((t) => t.name.startsWith('Position ')).length === 3 && tr.filter((t) => t.name.startsWith('Position ')).every((t) => !t.visible), 'each position is kept as a hidden trace');
  check(tr.some((t) => t.name.startsWith('Spatial average') && t.visible && t.kind === 'sweep'), 'the spatial average is a visible sweep trace');
  check(await page.locator('.series-bar').isHidden(), 'the prompt closes when the series is done');
}

// --- 3. Before / after compare with a score against the target, and in the report
if (want('compare')) {
  await page.evaluate(() => {
    const grid = Array.from(window.calApp.grid);
    const peak = (f, g) => g * Math.exp(-((Math.log2(f / 50) / 0.25) ** 2));
    const t = window.calApp.traces;
    t.add({ name: 'Before EQ', kind: 'sweep', freqs: grid, mag: grid.map((f) => peak(f, 10)) });
    t.add({ name: 'After EQ', kind: 'sweep', freqs: grid, mag: grid.map((f) => 4 + peak(f, 2)) });
    // The newest two, before first (traces made earlier in this test file are older)
    t.traces[t.traces.length - 2].created = Date.now() + 5000;
    t.traces[t.traces.length - 1].created = Date.now() + 6000;
  });
  await page.locator('[data-action="compare"]').click();
  await page.waitForSelector('.cmp-modal .cmp-score.after b');
  await page.locator('.cmp-modal select[data-compare="target"]').selectOption('flat');
  await page.waitForTimeout(300);
  const before = await page.locator('.cmp-modal select[data-compare="before"] option:checked').textContent();
  const after = await page.locator('.cmp-modal select[data-compare="after"] option:checked').textContent();
  check(before.startsWith('Before EQ') && after.startsWith('After EQ'), `the two newest traces are compared, older as before (${before} → ${after})`);
  const sum = await page.locator('.cmp-summary').textContent();
  check(/closer to the target/.test(sum), `the summary scores the improvement (${sum})`);
  const [b, a] = await page.locator('.cmp-score b').allTextContents();
  check(parseFloat(b.replace('±', '')) > 2 * parseFloat(a.replace('±', '')), `RMS deviation before vs after (${b} → ${a})`);
  await page.screenshot({ path: `${out}/feat6-03-compare.png` });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForSelector('.cmp-modal', { state: 'detached' });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('9');
  await page.locator('[data-section="session"]').click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Create report' }).click()]);
  await popup.waitForLoadState();
  const rep = await popup.evaluate(() => document.body.innerText);
  check(rep.includes('Before / after') && rep.includes('closer to the target'), 'the comparison is in the report');
  await popup.close();
}

// --- 4. Notes on graphs: add one by clicking the graph, edit it from its flag, list it in the report
if (want('notes')) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await page.waitForTimeout(600);
  await page.locator('[data-notes="spectrum"]').click();
  const canvas = page.locator('.view:not([hidden]) .plot canvas, .live .plot canvas').first();
  const box = await canvas.boundingBox();
  const at1k = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.xToPx(1000));
  await canvas.click({ position: { x: at1k, y: box.height / 2 } });
  await page.locator('.note-editor input').fill('Desk reflection');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  let notes = await page.evaluate(() => window.calApp.settings.graphNotes);
  check(notes.length === 1 && notes[0].graph === 'spectrum' && Math.abs(Math.log2(notes[0].f / 1000)) < 0.05 && notes[0].text === 'Desk reflection', `a note is added where the graph was clicked (${notes[0]?.f?.toFixed(0)} Hz)`);
  check((await page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').rta.notes.length)) === 1, 'the note is drawn on the Spectrum');
  await page.screenshot({ path: `${out}/feat6-04-notes.png` });
  // Click its flag to edit it
  await canvas.click({ position: { x: at1k + 20, y: 20 } });
  await page.waitForSelector('.note-editor');
  await page.locator('.note-editor input').fill('Desk reflection (moved desk)');
  await page.locator('.note-editor').getByRole('button', { name: 'Save' }).click();
  notes = await page.evaluate(() => window.calApp.settings.graphNotes);
  check(notes.length === 1 && notes[0].text === 'Desk reflection (moved desk)', 'clicking a note edits it');
  // Notes are in the report
  await page.keyboard.press('9');
  await page.locator('[data-section="session"]').click();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Create report' }).click()]);
  await popup.waitForLoadState();
  const rep = await popup.evaluate(() => document.body.innerText);
  check(rep.includes('Notes on graphs') && rep.includes('Desk reflection (moved desk)'), 'notes are listed in the report');
  await popup.close();
  // Delete
  await page.keyboard.press('1');
  await page.waitForTimeout(500);
  await canvas.click({ position: { x: at1k + 20, y: 20 } });
  await page.locator('.note-editor').getByRole('button', { name: 'Delete this note' }).click();
  check((await page.evaluate(() => window.calApp.settings.graphNotes.length)) === 0, 'a note can be deleted');
}

// --- 5. Smooth metering: level bars move every frame, the spectrum glides, 50 spectra per second on request
if (want('smooth')) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('1');
  await page.waitForTimeout(800);
  const rate = (ms) => page.evaluate((ms) => new Promise((resolve) => {
    const a = window.calApp;
    const m = a.measurements[0];
    const s0 = m.rtaShown;
    const ver = () => (a.analysisWorker.active ? m.workerVersions.rta : m.rta.main.version);
    const v0 = ver();
    let frames = 0;
    let readings = 0;
    let last = a.meterReadings;
    const tick = () => {
      frames++;
      if (a.meterReadings !== last) readings++;
      last = a.meterReadings;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve({ shown: ((m.rtaShown - s0) * 1000) / ms, spectra: ((ver() - v0) * 1000) / ms, fps: (frames * 1000) / ms, readings });
    };
    const t0 = performance.now();
    requestAnimationFrame(tick);
  }), ms);
  const smooth = await rate(3000);
  await page.evaluate(() => { window.calApp.settings.rtaMotion = 'stepped'; });
  const stepped = await rate(3000);
  check(smooth.shown > smooth.fps * 0.85 && smooth.shown > stepped.shown, `the spectrum glides: ${smooth.shown.toFixed(0)} display updates per second vs ${stepped.shown.toFixed(0)} stepped (${smooth.spectra.toFixed(0)} new spectra/s, ${smooth.fps.toFixed(0)} fps)`);
  check(smooth.readings > smooth.fps * 3 * 0.85, `the level meters update on every frame (${smooth.readings} of ${(smooth.fps * 3).toFixed(0)} frames)`);
  await page.evaluate(() => { window.calApp.settings.rtaMotion = 'smooth'; });
  await page.locator('[data-options="spectrum"]').click();
  await page.locator('select[data-setting="rtaUpdates"]').selectOption('50');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const fast = await rate(3000);
  check(fast.spectra > smooth.spectra * 1.6, `50 per second computes more spectra (${fast.spectra.toFixed(0)}/s vs ${smooth.spectra.toFixed(0)}/s)`);
  await page.locator('[data-options="spectrum"]').click();
  await page.locator('select[data-setting="rtaUpdates"]').selectOption('25');
  await page.keyboard.press('Escape');
}

// --- 6. The analysis runs in a background thread; the main thread only draws
if (want('worker')) {
  const probe = () => page.evaluate(() => new Promise((res) => {
    const a = window.calApp;
    const m = a.measurements[0];
    const f0 = a.analysisWorker.frames;
    const s0 = m.rtaShown;
    setTimeout(() => res({ active: a.analysisWorker.active, frames: (a.analysisWorker.frames - f0) / 2, shown: (m.rtaShown - s0) / 2, dsp: a.frameTimes.reduce((x, y) => x + y, 0) / a.frameTimes.length, tf: m.tfReady, rta: m.hasRta }), 2000);
  }));
  const bg = await probe();
  check(bg.active && bg.frames > 15 && bg.shown > 15 && bg.tf && bg.rta, `spectrum and transfer function come from the background thread (${bg.frames} frames/s, ${bg.shown} display updates/s)`);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('9');
  await page.locator('[data-section="display"]').click();
  await page.locator('select[data-setting="analysisThread"]').selectOption('main');
  await page.keyboard.press('1');
  await page.waitForTimeout(1500);
  const main = await probe();
  check(!main.active && main.frames === 0 && main.shown > 15, `Main thread: the analysis runs as before (${main.shown} display updates/s)`);
  check(main.dsp > bg.dsp, `the main thread does less with the background analysis (${bg.dsp.toFixed(2)} vs ${main.dsp.toFixed(2)} ms per frame)`);
  await page.keyboard.press('9');
  await page.locator('select[data-setting="analysisThread"]').selectOption('worker');
  await page.keyboard.press('1');
  await page.waitForTimeout(1500);
  check((await probe()).active, 'background analysis can be switched on again');
}

// --- 7. Defaults for a first start: transfer function at 1/12 octave with coherence in its own band, the delay
// found by itself when it was never set
if (want('defaults')) {
  const d = await page.evaluate(() => {
    const a = window.calApp;
    const v = a.views.find((x) => x.id === 'transfer');
    return { tf: a.settings.tfSmoothing, rta: a.settings.rtaSmoothing, band: v.mag.cfg.secondaryBand, hidden: a.settings.transferLayout?.hidden ?? [] };
  });
  check(d.tf === 12 && d.rta === 6 && d.band?.[0] > 0.5 && d.hidden.includes('levels'), `first-start defaults (${JSON.stringify(d)})`);
  await page.evaluate(() => {
    const a = window.calApp;
    const m = a.measurements[0];
    m.cfg.delay = 0;
    m.reset();
  });
  const found = await page.waitForFunction(() => window.calApp.measurements[0].cfg.delay > 0, null, { timeout: 15000 }).then(() => true).catch(() => false);
  const ms = await page.evaluate(() => (window.calApp.measurements[0].cfg.delay / window.calApp.fs) * 1000);
  check(found && Math.abs(ms - 12.54) < 0.2, `the delay is found automatically when it was never set (${ms.toFixed(2)} ms)`);
}

// --- 8. The status bar shows meters only for the inputs in use (and the generator while it plays)
if (want('meters')) {
  const labels = () => page.$$eval('.statusbar .meter span', (els) => els.map((e) => e.textContent));
  check((await labels()).join() === 'In1,In2,Gen', `demo: mic, loopback reference and generator (${(await labels()).join()})`);
  await page.evaluate(() => {
    const a = window.calApp;
    a.settings.measurements[0].ref = -1;
    a.settings.generator = { ...a.settings.generator, type: 'off' };
  });
  await page.waitForTimeout(300);
  check((await labels()).join() === 'In1,Gen', `internal reference: the mic and the generator it compares with (${(await labels()).join()})`);
  await page.evaluate(() => { window.calApp.settings.measurements[0].ref = 1; });
  await page.waitForTimeout(300);
  check((await labels()).join() === 'In1,In2', `loopback reference, generator off: no generator meter (${(await labels()).join()})`);
  await page.evaluate(() => {
    const a = window.calApp;
    a.settings.measurements[0].ref = 1;
    a.settings.generator = { ...a.settings.generator, type: 'pink' };
  });
}

// --- 9. Themes: presets, a custom theme from the editor (live preview, saved, kept after a reload), T back to Night/Day
if (want('themes')) {
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => window.calApp.setView('tools'));
  await page.locator('[data-section="display"]').click();
  await page.locator('[data-theme="preset:stage-red"]').click();
  await page.waitForTimeout(300);
  const red = await page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), id: window.calApp.settings.themeId }));
  check(red.id === 'preset:stage-red' && red.bg === '#ff3b30', `a preset theme applies (${JSON.stringify(red)})`);
  await page.screenshot({ path: `${out}/feat6-05-theme-stage-red.png` });
  await page.locator('[data-theme="preset:colour-blind"]').click();
  await page.evaluate(() => window.calApp.setView('transfer'));
  await page.waitForTimeout(800);
  const trace = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'transfer').mag.series.find((x) => x.id === 'm1')?.color);
  check(trace === '#4d9fff', 'measurement colours are stored unchanged');
  await page.evaluate(() => window.calApp.setView('tools'));
  await page.getByRole('button', { name: 'New theme…' }).click();
  await page.locator('.theme-modal input[aria-label="Theme name"]').fill('Test theme');
  await page.locator('.theme-modal input[data-theme-color="bg"]').evaluate((el) => { el.value = '#102030'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(200);
  check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())) === '#102030', 'the editor previews changes live');
  await page.getByRole('button', { name: 'Save theme' }).click();
  const saved = await page.evaluate(() => ({ n: window.calApp.settings.customThemes.length, name: window.calApp.settings.customThemes[0]?.name, id: window.calApp.settings.themeId }));
  check(saved.n === 1 && saved.name === 'Test theme' && saved.id.startsWith('custom:'), `the theme is saved and in use (${JSON.stringify(saved)})`);
  await page.reload();
  await page.waitForTimeout(1500);
  check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())) === '#102030', 'the theme is kept after a reload');
  await page.locator('.modal-overlay .btn.icon-btn, .modal [title="Close"]').first().click().catch(() => undefined);
  await page.evaluate(() => document.querySelectorAll('.modal-overlay').forEach((m) => m.remove()));
  await page.evaluate(() => window.calApp.toggleTheme());
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ id: window.calApp.settings.themeId, theme: window.calApp.settings.theme, bg: document.documentElement.style.getPropertyValue('--bg') }));
  check(back.id === '' && back.bg === '', `T goes back to the built-in Night / Day (${JSON.stringify(back)})`);
  await page.evaluate(() => { window.calApp.settings.theme = 'night'; window.calApp.setTheme(''); });
}

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
