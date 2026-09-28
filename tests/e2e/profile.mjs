// CPU profile of the app per tab (host, demo room). Prints the top functions by self time and the
// main-thread time per second. Usage: npm run build && node tests/e2e/profile.mjs [throttle] [tabs]
import { chromium } from 'playwright';
import { preview } from 'vite';
const throttle = Number(process.argv[2] ?? 4);
const tabs = (process.argv[3] ?? '1,2,3,4').split(',');
const server = await preview({ preview: { port: 4193, strictPort: true }, build: { outDir: process.env.DIST || 'dist' } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
const cdp = await page.context().newCDPSession(page);
await page.goto('http://localhost:4193/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(3000);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
const summary = [];
for (const tab of tabs) {
  await page.keyboard.press(tab);
  await page.waitForTimeout(2000);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await page.waitForTimeout(5000);
  const { profile } = await cdp.send('Profiler.stop');
  const wall = Date.now() - t0;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const dt = profile.timeDeltas[i] ?? 0;
    const name = n.callFrame.functionName || '(anonymous)';
    if (name === '(idle)') return;
    total += dt;
    const key = `${name} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  const busy = (total / 1000 / wall) * 100;
  summary.push(`tab ${tab}: main thread busy ${busy.toFixed(0)}% (${throttle}× throttled)`);
  console.log(`\n== tab ${tab}: busy ${busy.toFixed(0)}% ==`);
  console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n'));
}
console.log('\n' + summary.join('\n'));
await browser.close();
server.httpServer.close();
