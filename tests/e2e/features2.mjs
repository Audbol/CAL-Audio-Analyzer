// End-to-end test of the multi-mic average, noise log, waterfall, trace notes / photos, workspaces and the
// smoothed average curve (demo mode).
// Usage: npm run build && node tests/e2e/features2.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4184, strictPort: true } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) failed = true;
};

await page.goto('http://localhost:4184/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(4000);

// --- Average curve: bell-shaped smoothing makes it smooth (small curvature) compared with unsmoothed
await page.keyboard.press('1');
await page.locator('.view:visible [data-options]').click();
const roughness = async (smooth) => {
  await page.locator('select[data-setting="rtaAverageSmoothing"]').selectOption(String(smooth));
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const s = window.calApp.views.find((v) => v.id === 'spectrum').rta.series.find((x) => x.id.endsWith('-avg'));
    const g = window.calApp.grid;
    let r = 0;
    let n = 0;
    for (let i = 1; i < g.length - 1; i++) if (g[i] > 200 && g[i] < 10000) { r += Math.abs(s.y[i + 1] - 2 * s.y[i] + s.y[i - 1]); n++; }
    return r / n;
  });
};
const rough0 = await roughness(0);
const rough6 = await roughness(6);
check(rough6 < rough0 * 0.5, `smoothed average curve is much smoother (curvature ${rough6.toFixed(3)} vs ${rough0.toFixed(3)} dB)`);
await page.screenshot({ path: `${out}/feat2-01-average-smooth.png` });

// --- Multi-mic average: add a second mic, show average + spread, then average only
await page.evaluate(() => window.calApp.addMeasurement());
await page.waitForTimeout(2500);
await page.locator('select[data-setting="micAverage"]').first().selectOption('spread');
await page.waitForTimeout(1200);
const mic = await page.evaluate(() => {
  const ids = window.calApp.views.find((v) => v.id === 'spectrum').rta.series.map((s) => s.id);
  return { ids, n: window.calApp.measurements.filter((m) => m.cfg.enabled).length };
});
check(mic.n === 2 && mic.ids.includes('mic-avg') && mic.ids.includes('mic-spread'), `spectrum shows the average and spread of ${mic.n} mics`);
await page.keyboard.press('2');
await page.locator('.view:visible [data-options]').click();
await page.locator('select[data-setting="micAverage"]').nth(1).selectOption('only');
await page.waitForTimeout(1500);
const tfIds = await page.evaluate(() => window.calApp.views.find((v) => v.id === 'transfer').mag.series.map((s) => s.id));
check(tfIds.includes('mic-avg') && !tfIds.some((id) => /^m\d/.test(id)), 'transfer function: “average only” hides the individual mics');
await page.screenshot({ path: `${out}/feat2-02-mic-average.png` });
await page.locator('select[data-setting="micAverage"]').nth(1).selectOption('off');
await page.keyboard.press('Escape');

// --- Trace note and photo
await page.keyboard.press('c');
await page.waitForTimeout(300);
const tid = await page.evaluate(() => window.calApp.traces.traces.at(-1).id);
await page.locator(`button[data-trace-note="${tid}"]`).click();
await page.locator('textarea[data-trace-note-text]').fill('Row 12, seat 8, 1.2 m');
await page.locator('input[data-trace-note-file]').setInputFiles('docs/screenshot-room.png');
await page.waitForSelector('.note-photo img');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForSelector('.modal', { state: 'detached' });
const tr = await page.evaluate((id) => {
  const t = window.calApp.traces.traces.find((x) => x.id === id);
  return { note: t.note, photo: t.photo?.slice(0, 23), size: t.photo?.length ?? 0 };
}, tid);
check(tr.note === 'Row 12, seat 8, 1.2 m' && tr.photo === 'data:image/jpeg;base64,', `trace note and photo stored (${(tr.size / 1024).toFixed(0)} kB)`);
check(tr.size < 400_000, 'photo scaled down for storage');

// --- Waterfall from a sweep
await page.keyboard.press('5');
await page.getByRole('button', { name: 'Measure sweep' }).click();
await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 30000 });
await page.locator('.room-tabs-row').getByRole('button', { name: 'Waterfall' }).click();
await page.waitForTimeout(600);
const wf = await page.evaluate(() => {
  const d = window.calApp.views.find((v) => v.id === 'room').waterfallData('bass');
  const at = (s, f) => s[d.freqs.findIndex((x) => x >= f)];
  const last = d.slices.at(-1);
  return { n: d.slices.length, mode: at(last, 47), between: at(last, 70) };
});
check(wf.n === 32, `waterfall has ${wf.n} slices`);
check(wf.mode > wf.between, `47 Hz room mode rings longer than 70 Hz (${wf.mode.toFixed(1)} vs ${wf.between.toFixed(1)} dB at 400 ms)`);
await page.screenshot({ path: `${out}/feat2-03-waterfall.png` });

// --- Noise log: 1 s rows, a limit below the level → alarm
await page.keyboard.press('8');
await page.locator('select[data-log="interval"]').selectOption('1');
await page.locator('select[data-log="window"]').selectOption('1');
await page.locator('input[data-log="limit"]').fill('-80');
await page.locator('input[data-log="limit"]').dispatchEvent('change');
await page.locator('button[data-log="toggle"]').click();
await page.waitForTimeout(4500);
const lg = await page.evaluate(() => {
  const l = window.calApp.logger;
  return { rows: l.rows.length, state: l.state, bands: l.rows[0]?.bands?.length ?? 0, leq: l.rows[0]?.leq, over: document.querySelector('.spl-mini').classList.contains('log-over') };
});
check(lg.rows >= 3, `noise log records a row per second (${lg.rows})`);
check(lg.bands === 29, 'each row carries the third-octave spectrum');
check(lg.state === 'over' && lg.over, 'limit exceeded: alarm state and red level readout');
// Switching workspaces mid-log (C-weighted voice → A kept) never breaks the rows: exact 1 s each, one weighting
const w0 = await page.evaluate(() => window.calApp.settings.splWeighting);
for (const id of ['voice', 'live-mix', 'noise', 'system-tuning']) {
  await page.evaluate((id) => { const sel = window.calApp.workspaceHost.querySelector('select'); sel.value = id; sel.dispatchEvent(new Event('change')); }, id);
  await page.waitForTimeout(400);
}
await page.keyboard.press('8');
await page.waitForTimeout(1500);
const lg2 = await page.evaluate(() => { const l = window.calApp.logger; return { running: l.running, durs: l.rows.map((r) => r.dur), ws: [...new Set(l.rows.map((r) => r.w))], w: window.calApp.settings.splWeighting }; });
check(lg2.running && lg2.durs.every((d) => d === 1) && lg2.ws.length === 1 && lg2.w === w0, `rows stay exact through workspace changes (${lg2.durs.length} rows, ${lg2.ws.join('/')})`);
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export log CSV' }).click()]);
const csv = fs.readFileSync(await dl.path(), 'utf8').split('\n');
check(csv[0].startsWith('time,seconds,weighting,Leq') && csv.length >= lg.rows + 1, `CSV export (${csv.length - 1} rows)`);
await page.locator('button[data-log="toggle"]').click();
await page.mouse.move(700, 300);
await page.waitForTimeout(300);
const btnCls = await page.locator('button[data-log="toggle"]').getAttribute('class');
check(!btnCls.includes('rec') && btnCls.includes('accent') && !(await page.evaluate(() => window.calApp.logger.running)), `logging stopped, button back to Start (${btnCls})`);
await page.screenshot({ path: `${out}/feat2-04-noise-log.png` });

// --- Report: noise log, waterfall and the position photo
await page.keyboard.press('9');
await page.locator('[data-section="session"]').click();
const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Create report' }).click()]);
await popup.waitForLoadState();
  await popup.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 15000 }); // the report code loads on first use
const rep = await popup.evaluate(() => ({ h2: [...document.querySelectorAll('h2')].map((x) => x.textContent), text: document.body.innerText, photos: document.querySelectorAll('figure.photo img').length }));
check(rep.h2.includes('Noise log') && rep.text.includes('Overall'), 'report has the noise log');
check(rep.text.includes('Waterfall'), 'report has the waterfall');
check(rep.photos === 1 && rep.text.includes('Row 12, seat 8'), 'report shows the position photo and note');
await popup.setViewportSize({ width: 1100, height: 1400 });
await popup.screenshot({ path: `${out}/feat2-05-report.png`, fullPage: true });
await popup.close();

// --- Workspaces: a ready-made one, then save the current setup
await page.locator('select[data-workspace]').selectOption('sub-align');
await page.waitForTimeout(400);
const ws = await page.evaluate(() => ({ view: window.calApp.settings.view, lf: window.calApp.settings.lfResolution, ws: window.calApp.settings.workspace }));
check(ws.view === 'align' && ws.lf === 'max' && ws.ws === 'sub-align', 'ready-made workspace switches tab and settings');
await page.locator('select[data-workspace]').selectOption('live-mix');
await page.waitForTimeout(400);
const live = await page.evaluate(() => ({ view: window.calApp.settings.view, target: window.calApp.settings.targetCurve, sel: document.querySelector('select[data-setting="targetCurve"]').value }));
check(live.view === 'spectrum' && live.target === 'house' && live.sel === 'house', 'workspace updates the toolbar controls');
page.once('dialog', (d) => d.accept('My tuning'));
await page.locator('select[data-workspace]').selectOption('__save');
await page.waitForTimeout(300);
const saved = await page.evaluate(() => window.calApp.settings.workspaces.map((w) => w.name));
check(saved.length === 1 && saved[0] === 'My tuning', 'current setup saved as a workspace');
await page.screenshot({ path: `${out}/feat2-06-workspaces.png` });

check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
