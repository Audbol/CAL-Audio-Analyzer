// End-to-end test of per-mic calibration (several mics) and system alignment (sub, fills, delay speakers).
// Usage: npm run build && node tests/e2e/features3.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4185, strictPort: true } });
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

await page.goto('http://localhost:4185/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(3000);

// --- Microphones: two mics, each on its own input with its own calibration
await page.keyboard.press('9');
await page.getByRole('button', { name: 'Add microphone' }).click();
await page.getByRole('button', { name: 'Add microphone' }).click();
const mics = await page.evaluate(() => window.calApp.settings.mics.map((m) => ({ name: m.name, ch: m.channel })));
check(mics.length === 2 && mics[0].ch === 0 && mics[1].ch === 1, `two mics on In 1 and In 2 (${JSON.stringify(mics)})`);
await page.locator('.mic-row').nth(0).locator('input[data-mic="name"]').fill('Front mic');
await page.locator('.mic-row').nth(0).locator('input[data-mic="name"]').dispatchEvent('change');
// Calibrate mic 1 at 94 dB, mic 2 at 100 dB
await page.locator('input[data-mic="ref"]').fill('94');
await page.locator('.mic-row').nth(0).locator('[data-mic="calibrate"]').click();
await page.locator('input[data-mic="ref"]').fill('100');
await page.locator('.mic-row').nth(1).locator('[data-mic="calibrate"]').click();
await page.waitForTimeout(600);
const cal = await page.evaluate(() => {
  const a = window.calApp;
  return { mics: a.settings.mics.map((m) => ({ name: m.name, ok: m.splCalibrated, off: m.splOffset })), meter: a.settings.splOffset, spl: a.splReading?.slow, labels: a.channelOptions(false).map((o) => o.label) };
});
check(cal.mics[0].name === 'Front mic' && cal.mics.every((m) => m.ok), 'both mics calibrated, rename kept');
check(Math.abs(cal.meter - cal.mics[0].off) < 1e-9 && Math.abs(cal.spl - 94) < 1.5, `SPL meter on In 1 uses the front mic's calibration (reads ${cal.spl.toFixed(1)} dB)`);
check(cal.labels[0].includes('Front mic') && cal.labels[1].includes('Mic 2'), `input lists show the mic names (${cal.labels.join(', ')})`);
// SPL meter moved to In 2: it follows that mic's calibration
await page.evaluate(() => { const a = window.calApp; a.settings.splChannel = 1; a.syncCal(); });
await page.waitForTimeout(1600);
const spl2 = await page.evaluate(() => ({ off: window.calApp.settings.splOffset, lvl: window.calApp.splReading?.slow }));
check(Math.abs(spl2.off - cal.mics[1].off) < 1e-9 && Math.abs(spl2.lvl - 100) < 1.5, `SPL meter on In 2 uses the second mic's calibration (reads ${spl2.lvl.toFixed(1)} dB)`);
await page.evaluate(() => { const a = window.calApp; a.settings.splChannel = 0; a.syncCal(); });

// Correction file for the front mic only
const calFile = path.join(os.tmpdir(), 'front-mic.txt');
fs.writeFileSync(calFile, '"Sens Factor =-1.0dB"\n20 0\n1000 0\n10000 6\n20000 6\n');
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.mic-row').nth(0).getByRole('button', { name: 'Load file…' }).click()]);
await chooser.setFiles(calFile);
await page.waitForTimeout(400);
const corr = await page.evaluate(() => {
  const a = window.calApp;
  const g = a.grid;
  const i = g.findIndex((f) => f >= 10000);
  return { in1: a.calFor(0)?.[i], in2: a.calFor(1) };
});
check(corr.in1 !== undefined && Math.abs(Math.abs(corr.in1) - 6) < 0.5 && corr.in2 === null, `correction applies to In 1 only (${corr.in1?.toFixed(1)} dB at 10 kHz)`);
await page.locator('.mics-card').screenshot({ path: `${out}/feat3-01-mics.png` });

// Spectrum: each measurement in dB SPL with its own mic's calibration
await page.evaluate(() => {
  const a = window.calApp;
  a.addMeasurement();
  const m2 = a.settings.measurements[a.settings.measurements.length - 1];
  m2.mic = 1;
  a.rebuildMeasurements();
});
await page.keyboard.press('1');
await page.waitForTimeout(2500);
const sp = await page.evaluate(() => {
  const a = window.calApp;
  const v = a.views.find((x) => x.id === 'spectrum');
  const g = a.grid;
  const i = g.findIndex((f) => f >= 1000);
  const [m1, m2] = a.measurements;
  const s1 = v.rta.series.find((s) => s.id === m1.cfg.id);
  const s2 = v.rta.series.find((s) => s.id === m2.cfg.id);
  return { unit: v.rta.cfg.yUnit, d: s2.y[i] - s1.y[i], raw: m2.rtaOut[i] - m1.rtaOut[i], expect: a.settings.mics[1].splOffset - a.settings.mics[0].splOffset };
});
check(sp.unit === 'dB SPL' && Math.abs(sp.d - sp.raw - sp.expect) < 0.01, `spectrum shifts each measurement by its own mic's calibration (${sp.d.toFixed(1)} dB apart)`);

// --- System alignment: mains, sub, a delay tower and a late front fill
await page.evaluate(() => {
  const app = window.calApp;
  const freqs = Array.from(app.grid);
  // Full-range speaker (2nd-order high-pass at 80 Hz) arriving `arrival` ms after the reference, captured with
  // delay compensation `comp` ms; optional LR4 low-pass sub instead
  const make = (arrival, comp, gainDb = 0, kind = 'full') => {
    const mag = [], phase = [];
    for (const f of freqs) {
      let re, im;
      if (kind === 'full') {
        const w = f / 80, dre = 1 - w * w, dim = Math.SQRT2 * w, d = dre * dre + dim * dim;
        re = (-w * w * dre) / d; im = (w * w * dim) / d;
      } else {
        const w = f / 90, bre = 1 - w * w, bim = Math.SQRT2 * w;
        const b2re = bre * bre - bim * bim, b2im = 2 * bre * bim, d = b2re * b2re + b2im * b2im;
        re = b2re / d; im = -b2im / d;
        if (kind === 'hp') { const nre = w ** 4; re = (nre * b2re) / d; im = -(nre * b2im) / d; }
      }
      const ph = Math.atan2(im, re) - 2 * Math.PI * f * ((arrival - comp) / 1000);
      mag.push(20 * Math.log10(Math.hypot(re, im)) + gainDb);
      phase.push((((ph * 180) / Math.PI + 540) % 360) - 180);
    }
    return { mag, phase };
  };
  const add = (name, d, delayMs) => app.traces.add({ name, kind: 'tf', freqs, mag: d.mag, phase: d.phase, delayMs });
  // At the sub position the mains are LR4 high-passed; at the delay/fill handoffs they are full-range
  add('Mains at sub', make(10, 10, 0, 'hp'), 10);
  add('Sub test', make(13, 10, 0, 'lp'), 10);
  add('Mains at tower', make(80, 80), 80);
  add('Tower test', make(12, 12, -4), 12);
  add('Mains at fill', make(5, 5), 5);
  add('Fill test', make(8, 8), 8);
});
await page.keyboard.press('7');
await page.waitForTimeout(400);
const tid = async (name) => page.evaluate((n) => `trace:${window.calApp.traces.traces.find((t) => t.name === n).id}`, name);
// The sub part exists by default
await page.locator('select[data-align="ref"]').selectOption(await tid('Mains at sub'));
await page.locator('select[data-align-el]').first().selectOption(await tid('Sub test'));
await page.getByRole('button', { name: 'Calculate alignment' }).click();
await page.waitForTimeout(300);
const sub = await page.evaluate(() => { const v = window.calApp.views.find((x) => x.id === 'align'); const e = v.elements[0]; return { d: e.result?.delayMs, pol: e.result?.polarity }; });
check(Math.abs(sub.d + 3) < 0.1 && sub.pol === 1, `sub: delay the mains 3 ms (${sub.d?.toFixed(2)})`);

// A delay tower (default 5 ms precedence) and a front fill, each with the mains measured at its own handoff
for (const [kind, trace, mains] of [['delay', 'Tower test', 'Mains at tower'], ['frontfill', 'Fill test', 'Mains at fill']]) {
  await page.locator('[data-options="align-add"]').click();
  await page.locator(`[data-add="${kind}"]`).click();
  await page.keyboard.press('Escape');
  await page.locator('select[data-align-el]').last().selectOption(await tid(trace));
  await page.locator('select[data-align-ref]').last().selectOption(await tid(mains));
}
await page.getByRole('button', { name: 'Calculate alignment' }).click();
await page.waitForTimeout(400);
const plan = await page.evaluate(() => {
  const v = window.calApp.views.find((x) => x.id === 'align');
  return v.elements.map((e, i) => ({ name: e.name, kind: e.kind, d: e.result?.delayMs, level: e.result?.levelDb, text: document.querySelectorAll('.align-el')[i].querySelector('.align-res').textContent }));
}).then((p) => p.slice(1));
check(plan.length === 2, 'three parts aligned at once');
check(Math.abs(plan[0].d - 68) < 0.05 && /Delay the delay by 73\.0\d ms/.test(plan[0].text), `delay tower: time-aligned +68 ms, set 73 ms with 5 ms precedence (${plan[0].text})`);
check(Math.abs(plan[0].level + 4) < 0.3, `tower level vs mains −4 dB (${plan[0].level?.toFixed(1)})`);
check(Math.abs(plan[1].d + 3) < 0.05 && /Arrives 3\.0\d ms after the mains/.test(plan[1].text), `late front fill flagged: can't be fixed with delay (${plan[1].text})`);
await page.screenshot({ path: `${out}/feat3-02-align.png` });

// Report: alignment plan with every part, and the mics
await page.keyboard.press('9');
const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Create report' }).click()]);
await popup.waitForLoadState();
const rep = await popup.evaluate(() => document.body.innerText);
check(rep.includes('System alignment') && rep.includes('Delay the mains by 3.0') && rep.includes('Delay the delay by 73.0') && rep.includes('Arrives 3.0'), 'report has the alignment plan for every part');
check(rep.includes('Front mic on In 1') && rep.includes('Mic 2 on In 2'), 'report lists the mics and their calibrations');
await popup.close();

// Session keeps the mics and the whole system
const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save session' }).click()]);
const sess = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
check(sess.shared.mics.length === 2 && sess.align.version === 2 && sess.align.elements.length === 3, 'session holds both mics and all three aligned parts');

check(errors.length === 0, `no console errors ${errors.length ? JSON.stringify(errors.slice(0, 5)) : ''}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
