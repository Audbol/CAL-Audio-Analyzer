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

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
