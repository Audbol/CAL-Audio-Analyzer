// Benchmark: frame rate of a remote phone (CPU throttled 6×) on the Spectrum and Transfer tabs.
// Usage: npm run bench:remote  (or node tests/e2e/perf.mjs [host|device] [max pixel ratio])
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createHub } = require('../../electron/hub.cjs');
const PORT = 8541;
const hub = createHub({ distDir: path.resolve('dist'), pin: '', allowControl: true, version: 'perf' });
await hub.start(PORT);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const host = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await host.goto(`http://localhost:${PORT}/host`);
await host.getByText('Explore with the demo room').click();
await host.getByRole('button', { name: 'Start demo' }).click();
await host.waitForTimeout(2500);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const rem = await ctx.newPage();
const cdp = await ctx.newCDPSession(rem);
await rem.goto(`http://127.0.0.1:${PORT}/`);
await rem.waitForFunction(() => window.calApp.engine.running === true, null, { timeout: 15000 });
if (process.argv[2]) await rem.evaluate((m) => window.calApp.setProcessing?.(m), process.argv[2]);
if (process.argv[3]) await rem.evaluate((d) => window.calApp.setGraphQuality(+d), process.argv[3]);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
for (const tab of ['1', '2']) {
  await rem.keyboard.press(tab);
  await rem.waitForTimeout(1500);
  const r = await rem.evaluate(async () => {
    const t0 = performance.now(); let frames = 0; let busy = 0;
    const orig = window.calApp.frameTimes;
    await new Promise((res) => { const f = () => { frames++; if (performance.now() - t0 < 5000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const ft = window.calApp.frameTimes; const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
    return { fps: frames / 5, loopMs: avg.toFixed(1), mode: window.calApp.processingMode?.() };
  });
  console.log(tab === '1' ? 'spectrum' : 'transfer', JSON.stringify(r));
}
await browser.close(); await hub.stop();
