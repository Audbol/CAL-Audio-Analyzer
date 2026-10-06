// Small-screen test: the remote client on a phone (portrait + landscape) and a tablet.
// Usage: npm run build && node tests/e2e/mobile.mjs [outDir]
import { chromium, devices } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createHub } = require('../../electron/hub.cjs');
const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const PORT = 8562;
const hub = createHub({ distDir: path.resolve('dist'), pin: '', allowControl: true });
await hub.start(PORT);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const errors = [];

const host = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await host.goto(`http://localhost:${PORT}/host`);
await host.getByText('Explore with the demo room').click();
await host.getByRole('button', { name: 'Start demo' }).click();
await host.waitForTimeout(3000);

for (const [name, dev] of [
  ['phone', devices['iPhone 13']],
  ['phone-landscape', devices['iPhone 13 landscape']],
  ['tablet', devices['iPad (gen 7)']],
]) {
  const ctx = await browser.newContext({ ...dev });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.waitForFunction(() => window.calApp?.engine.running === true, null, { timeout: 15000 });
  await p.waitForTimeout(2500);
  const m = await p.evaluate(() => {
    const vis = [...document.querySelectorAll('.view:not([style*="none"]) .dock-stack .dpanel')];
    const first = vis[0]?.querySelector('canvas')?.getBoundingClientRect();
    return {
      compact: document.documentElement.classList.contains('compact'),
      overflowX: document.documentElement.scrollWidth - innerWidth,
      topbar: document.querySelector('.topbar').getBoundingClientRect().height,
      plotH: first ? first.height : 0,
      plotTop: first ? first.top : 9999,
      vh: innerHeight,
      floating: document.querySelectorAll('.view:not([style*="none"]) .dpanel.floating').length,
    };
  });
  console.log(name, JSON.stringify(m));
  check(m.compact, `${name}: compact layout`);
  check(m.overflowX <= 1, `${name}: no horizontal page overflow`);
  check(m.topbar < 64, `${name}: one-row top bar (${m.topbar.toFixed(0)} px)`);
  check(m.plotH > 180 && m.plotTop < m.vh * 0.45, `${name}: graph visible without scrolling (${m.plotH.toFixed(0)} px tall at y=${m.plotTop.toFixed(0)})`);
  check(m.floating === 0, `${name}: no floating panels covering the graphs`);
  await p.screenshot({ path: `${out}/mobile-${name}.png` });
  if (name === 'phone') {
    // Tap on a graph shows the value readout
    const c = await p.locator('.view:not([style*="none"]) canvas').first().boundingBox();
    await p.touchscreen.tap(c.x + c.width * 0.5, c.y + c.height * 0.4);
    await p.waitForTimeout(200);
    check(await p.locator('.view:not([style*="none"]) .plot-tip').first().isVisible(), 'phone: tapping a graph shows the value readout');
    // Drawer
    await p.locator('.compact-only[title^="Measurements"]').click();
    await p.waitForTimeout(350);
    const dr = await p.locator('.sidebar').boundingBox();
    check(dr.x >= -1 && dr.width < 400, 'phone: measurements drawer slides in');
    await p.screenshot({ path: `${out}/mobile-phone-drawer.png` });
    await p.locator('.scrim').click({ position: { x: 370, y: 300 } });
    await p.waitForTimeout(350);
    check((await p.locator('.sidebar').boundingBox()).x < -100, 'phone: tapping outside closes the drawer');
    // Settings sheet with generator control
    await p.locator('.compact-only[title^="Source"]').click();
    await p.waitForTimeout(350);
    await p.screenshot({ path: `${out}/mobile-phone-sheet.png` });
    const genBefore = await host.evaluate(() => window.calApp.settings.generator.type);
    await p.locator('.sheet .btn-gen').click();
    await host.waitForTimeout(600);
    const genAfter = await host.evaluate(() => window.calApp.settings.generator.type);
    check(genBefore !== genAfter, 'phone: generator switch in the settings sheet controls the host');
    await p.locator('.sheet .btn-gen').click();
    // The host's audio source and its audio can be changed from the phone too
    check(!(await p.locator('.sheet select.source').isDisabled()) && (await p.locator('.sheet select.source option').count()) >= 2, 'phone: the host’s audio source can be chosen in the settings sheet');
    check(await p.locator('.sheet [data-host-audio]').isVisible(), 'phone: the host’s audio can be started and stopped from the sheet');
    await p.locator('.sheet-head button').click();
    // Align and EQ: graphs keep a readable height (the tab scrolls)
    for (const id of ['align', 'eq']) {
      await p.evaluate((v) => window.calApp.setView(v), id);
      await p.waitForTimeout(400);
      const hs = await p.evaluate((v) => [...document.querySelectorAll(`.view.${v} .plot`)].map((x) => x.getBoundingClientRect().height), id);
      check(hs.length >= 2 && hs.every((x) => x >= 200), `phone: ${id} graphs are readable (${hs.map((x) => x.toFixed(0)).join(', ')} px)`);
    }
    // Every tab renders without horizontal overflow
    for (const id of ['spectrum', 'spectrogram', 'impulse', 'room', 'eq', 'spl', 'tools']) {
      await p.evaluate((v) => window.calApp.setView(v), id);
      await p.waitForTimeout(300);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (ov > 1) check(false, `phone: ${id} tab overflows horizontally by ${ov}px`);
    }
    check(true, 'phone: all tabs fit the screen width');
    await p.evaluate(() => window.calApp.setView('spl'));
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/mobile-phone-spl.png` });
  }
  await ctx.close();
}

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
await hub.stop();
process.exit(failed ? 1 : 0);
