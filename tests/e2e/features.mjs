// End-to-end test of target curves, the sub / main alignment assistant, sessions and reports (demo mode).
// Usage: npm run build && node tests/e2e/features.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4183, strictPort: true } });
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

await page.goto('http://localhost:4183/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(5000);

// --- Target curve on the Transfer view, levelled to the measurement
await page.keyboard.press('2');
await page.locator('.view.active select[data-setting="targetCurve"], select[data-setting="targetCurve"]:visible').first().selectOption('flat');
await page.waitForTimeout(1500);
const tf = await page.evaluate(() => {
  const v = window.calApp.views.find((x) => x.id === 'transfer');
  const s = v.mag.series;
  const t = s.find((x) => x.id === 'target');
  const band = s.find((x) => x.id === 'target-band');
  const m = window.calApp.measurements[0];
  const g = window.calApp.grid;
  let sum = 0, n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] >= 250 && g[i] <= 4000) { sum += m.mag[i] - t.y[i]; n++; }
  return { has: !!t, band: band ? band.y[100] - band.band[100] : 0, meanDev: sum / n, label: t?.label };
});
check(tf.has, `target drawn on the transfer function (${tf.label})`);
check(Math.abs(tf.band - 6) < 1e-6, 'tolerance band ±3 dB around the target');
check(Math.abs(tf.meanDev) < 1.5, `target levelled to the measurement (mean deviation ${tf.meanDev.toFixed(2)} dB over 250 Hz–4 kHz)`);
await page.screenshot({ path: `${out}/feat-01-transfer-target.png` });

// Same target on the Spectrum, levelled to the RTA
await page.keyboard.press('1');
await page.waitForTimeout(1500);
const sp = await page.evaluate(() => {
  const v = window.calApp.views.find((x) => x.id === 'spectrum');
  const t = v.rta.series.find((x) => x.id === 'target');
  return { has: !!t, sel: document.querySelectorAll('select[data-setting="targetCurve"]')[0].value };
});
check(sp.has && sp.sel === 'flat', 'target shared with the Spectrum view');
await page.screenshot({ path: `${out}/feat-02-spectrum-target.png` });

// --- Sub / main alignment: synthetic mains (LR4 high-pass) and sub (LR4 low-pass, 3 ms late) traces
await page.evaluate(() => {
  const app = window.calApp;
  const freqs = Array.from(app.grid);
  const lr4 = (f, fc, hp) => {
    // Butterworth² (Linkwitz–Riley 4th order) at s = jω
    const w = f / fc;
    const b = { re: 1 - w * w, im: Math.SQRT2 * w }; // s² + √2 s + 1 at s = jw
    const b2 = { re: b.re * b.re - b.im * b.im, im: 2 * b.re * b.im };
    const num = hp ? { re: w ** 4, im: 0 } : { re: 1, im: 0 };
    const d = b2.re ** 2 + b2.im ** 2;
    return { re: (num.re * b2.re + num.im * b2.im) / d, im: (num.im * b2.re - num.re * b2.im) / d };
  };
  const make = (hp, delayMs) => {
    const mag = [];
    const phase = [];
    for (const f of freqs) {
      const c = lr4(f, 90, hp);
      const ph = Math.atan2(c.im, c.re) - 2 * Math.PI * f * delayMs / 1000;
      mag.push(10 * Math.log10(c.re ** 2 + c.im ** 2));
      phase.push((((ph * 180) / Math.PI + 540) % 360) - 180);
    }
    return { mag, phase };
  };
  const m = make(true, 0);
  const s = make(false, 3);
  app.traces.add({ name: 'Mains test', kind: 'tf', freqs, mag: m.mag, phase: m.phase, delayMs: 0 });
  app.traces.add({ name: 'Sub test', kind: 'tf', freqs, mag: s.mag, phase: s.phase, delayMs: 0 });
});
await page.keyboard.press('7');
await page.waitForTimeout(400);
const ids = await page.evaluate(() => window.calApp.traces.traces.slice(-2).map((t) => t.id));
await page.locator('select[data-align="ref"]').selectOption(`trace:${ids[0]}`);
await page.locator('select[data-align-el]').first().selectOption(`trace:${ids[1]}`);
await page.getByRole('button', { name: 'Calculate alignment' }).click();
await page.waitForTimeout(500);
const al = await page.evaluate(() => {
  const r = window.calApp.views.find((v) => v.id === 'align').result;
  return r && { delay: r.delayMs, pol: r.polarity, before: r.before, after: r.after, xo: r.crossover, text: document.querySelector('.align .info-strip').textContent };
});
check(!!al, 'alignment computed');
check(al && Math.abs(al.delay + 3) < 0.1 && al.pol === 1, `recommends delaying the mains by 3 ms, normal polarity (got ${al?.delay.toFixed(2)} ms, ${al?.pol})`);
check(al && al.after > 0.97 && al.after > al.before, `summation improves (${Math.round(al?.before * 100)}% → ${Math.round(al?.after * 100)}%)`);
check(al && Math.abs(al.xo - 90) < 10, `crossover found near 90 Hz (${al?.xo.toFixed(0)} Hz)`);
check(al?.text.includes('Delay the mains'), 'summary tells which side to delay');
await page.screenshot({ path: `${out}/feat-03-align.png` });

// --- EQ and sweep, so the session and report carry everything
await page.keyboard.press('6');
await page.getByRole('button', { name: 'Calculate EQ' }).click();
await page.keyboard.press('5');
await page.getByRole('button', { name: 'Measure sweep' }).click();
await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 30000 });
await page.waitForTimeout(300);

// --- Session: fill in details, save, clear everything, open it again
await page.keyboard.press('9');
await page.locator('[data-section="session"]').click();
await page.locator('input[data-session="name"]').fill('Main PA tuning');
await page.locator('input[data-session="venue"]').fill('Test Hall');
await page.locator('textarea[data-session="notes"]').fill('Sub delayed, mains EQ.');
const before = await page.evaluate(() => {
  const app = window.calApp;
  const v = (id) => app.views.find((x) => x.id === id);
  return { traces: app.traces.traces.map((t) => t.id), eq: v('eq').filters.length, t20: v('room').result.acoustics.broadband.t20.rt, align: v('align').result.delayMs };
});
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save session' }).click()]);
const file = `${out}/feat-session.calsession.json`;
await download.saveAs(file);
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
check(download.suggestedFilename().startsWith('Main PA tuning - Test Hall') && download.suggestedFilename().endsWith('.calsession.json'), `session file name (${download.suggestedFilename()})`);
check(saved.format === 'cal-session' && saved.traces.length === before.traces.length && !!saved.sweep && !!saved.eq && !!saved.align, `session holds traces, sweep, EQ and alignment (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`);

await page.evaluate(() => {
  const app = window.calApp;
  app.traces.clear();
  app.settings.session = { name: '', venue: '', notes: '' };
  app.settings.targetCurve = 'off';
  app.views.find((v) => v.id === 'room').restoreSweep(null);
  app.views.find((v) => v.id === 'eq').restore(null);
  app.views.find((v) => v.id === 'align').restore(null);
});
await page.locator('input[data-session="file"]').setInputFiles(file);
await page.getByRole('button', { name: 'Open session', exact: true }).click();
await page.waitForTimeout(800);
const after = await page.evaluate(() => {
  const app = window.calApp;
  const v = (id) => app.views.find((x) => x.id === id);
  return {
    traces: app.traces.traces.map((t) => t.id),
    eq: v('eq').filters.length,
    t20: v('room').result?.acoustics.broadband.t20.rt,
    align: v('align').result?.delayMs,
    name: document.querySelector('input[data-session="name"]').value,
    target: app.settings.targetCurve,
  };
});
check(JSON.stringify(after.traces) === JSON.stringify(before.traces), 'traces restored with their ids');
check(after.eq === before.eq && after.eq > 0, `EQ filters restored (${after.eq})`);
check(Math.abs(after.t20 - before.t20) < 0.01, `sweep restored (T20 ${after.t20?.toFixed(2)} s)`);
check(Math.abs(after.align - before.align) < 1e-6, 'alignment restored');
check(after.name === 'Main PA tuning' && after.target === 'flat', 'session details and target restored');

// --- Report
const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Create report' }).click()]);
await popup.waitForLoadState();
const rep = await popup.evaluate(() => ({
  title: document.title,
  sections: [...document.querySelectorAll('h2')].map((x) => x.textContent),
  imgs: [...document.querySelectorAll('figure img')].filter((i) => i.naturalWidth > 1000).length,
  text: document.body.innerText,
}));
check(rep.title.includes('Main PA tuning') && rep.title.includes('Test Hall'), `report title (${rep.title})`);
for (const s of ['Setup', 'Spectrum', 'Transfer function', 'Sweep & room acoustics', 'EQ', 'System alignment', 'Stored traces', 'Notes']) check(rep.sections.includes(s), `report section “${s}”`);
check(rep.imgs >= 7, `report plots rendered (${rep.imgs})`);
check(rep.text.includes('Delay the mains by 3.0') && rep.text.includes('Within ±3 dB'), 'report states the alignment and target deviation');
await popup.setViewportSize({ width: 1100, height: 1400 });
await popup.screenshot({ path: `${out}/feat-04-report.png`, fullPage: true });
// The report draws in the day scheme: the app's own plots must stay in its night scheme
await page.bringToFront();
await page.keyboard.press('1');
await page.waitForTimeout(800);
const bg = await page.evaluate(() => {
  const c = window.calApp.views.find((v) => v.id === 'spectrum').rta.canvas;
  return Array.from(c.getContext('2d').getImageData(3, 3, 1, 1).data.slice(0, 3));
});
check(bg.every((v) => v < 60), `app plots keep the night scheme after the report (rgb ${bg.join(',')})`);

check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
