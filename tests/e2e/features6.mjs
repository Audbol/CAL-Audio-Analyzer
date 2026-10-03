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
    t.traces[t.traces.length - 1].created -= 1000;
    t.add({ name: 'After EQ', kind: 'sweep', freqs: grid, mag: grid.map((f) => 4 + peak(f, 2)) });
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

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
