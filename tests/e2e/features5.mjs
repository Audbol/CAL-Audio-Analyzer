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

check(errors.length === 0, `no console errors ${errors.join(' | ')}`);
await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
