// Stress / soak test: exercises every feature repeatedly and checks for page errors and resource leaks
// (event listeners, DOM nodes, JS heap). Usage: npm run build && node tests/e2e/stress.mjs [outDir]
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { makeWav } from './music.mjs';

const require = createRequire(import.meta.url);
const { createHub } = require('../../electron/hub.cjs');
const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const PORT = 8571;
const hub = createHub({ distDir: path.resolve('dist'), pin: '', allowControl: true, version: 'stress' });
await hub.start(PORT);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`host: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && errors.push(`host console: ${m.text()}`));
const cdp = await ctx.newCDPSession(page);
await page.goto(`http://localhost:${PORT}/host`);
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(2500);

const song = makeWav(path.join(out, 'Stress song.wav'), 2, 200);
const stats = async () => {
  await page.evaluate(() => window.gc?.());
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' });
  const w = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  const { result: d } = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const dl = await cdp.send('DOMDebugger.getEventListeners', { objectId: d.objectId });
  return page.evaluate(([wl, dl]) => ({ win: wl, doc: dl, nodes: document.getElementsByTagName('*').length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0 }), [w.listeners.length, dl.listeners.length]);
};

async function round(i) {
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(250);
  }
  await page.keyboard.press('1');
  await page.keyboard.press('b');
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  await page.keyboard.press('b');
  await page.keyboard.press('p');
  await page.keyboard.press('t');
  await page.waitForTimeout(200);
  await page.keyboard.press('t');
  // Generator types, music with a song
  for (const g of ['white', 'sine', 'sweep', 'music', 'pink']) {
    await page.evaluate((t) => { window.calApp.setGenerator({ type: t }); window.calApp.renderGenControls(); }, g);
    await page.waitForTimeout(150);
    if (g === 'music' && i === 0) {
      await page.locator('.music-title').click();
      const chooser = page.waitForEvent('filechooser');
      await page.locator('.pl-modal').getByRole('button', { name: 'Add songs…' }).click();
      await (await chooser).setFiles([song]);
      await page.waitForTimeout(800);
    }
    await page.keyboard.press('Escape');
  }
  // Playlist and help dialogs opened and closed repeatedly
  for (let j = 0; j < 5; j++) {
    await page.evaluate(() => { window.calApp.setGenerator({ type: 'music' }); window.calApp.renderGenControls(); document.querySelector('.music-title')?.click(); });
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => { window.calApp.setGenerator({ type: 'pink' }); window.calApp.renderGenControls(); });
  // Analysis settings
  for (const lf of ['standard', 'max', 'high']) await page.evaluate((v) => { window.calApp.settings.lfResolution = v; window.calApp.applyAnalysisSettings(); }, lf);
  for (const n of [4096, 65536, 16384]) await page.evaluate((v) => { window.calApp.settings.rtaFft = v; window.calApp.applyAnalysisSettings(); }, n);
  // Detach a panel and close it
  await page.keyboard.press('1');
  const [pop] = await Promise.all([ctx.waitForEvent('page'), page.locator('.view:visible .dpanel[data-panel="rta"] [data-act="popout"]').click()]);
  await pop.waitForTimeout(500);
  await pop.close();
  // Traces
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  await page.keyboard.press('c');
  await page.evaluate(() => { const t = window.calApp.traces.traces; window.calApp.traces.remove(t[t.length - 1].id); });
  // Engine restart and source switch (demo ↔ fake microphone)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const s = document.querySelector('select.source'); s.value = '__default'; s.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { const s = document.querySelector('select.source'); s.value = '__demo'; s.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(1200);
  // Viewport changes (compact layout and back)
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1500, height: 920 });
  await page.waitForTimeout(300);
}

// Remote devices connect and disconnect repeatedly
async function remoteChurn() {
  for (let j = 0; j < 4; j++) {
    const rc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const r = await rc.newPage();
    r.on('pageerror', (e) => errors.push(`remote: ${e.message}`));
    await r.goto(`http://127.0.0.1:${PORT}/`);
    await r.waitForFunction(() => window.calApp?.engine.running === true, null, { timeout: 15000 }).catch(() => errors.push('remote did not connect'));
    for (const k of ['1', '2', '3', '5']) {
      await r.keyboard.press(k);
      await r.waitForTimeout(300);
    }
    await rc.close();
  }
}

await round(0);
const s0 = await stats();
for (let i = 1; i < 4; i++) await round(i);
await remoteChurn();
await page.waitForTimeout(1500);
const s1 = await stats();
console.log(JSON.stringify({ before: s0, after: s1 }));
check(s1.win <= s0.win + 2 && s1.doc <= s0.doc + 2, `no event-listener leaks (window ${s0.win} → ${s1.win}, document ${s0.doc} → ${s1.doc})`);
check(s1.nodes <= s0.nodes * 1.15 + 50, `no DOM node leaks (${s0.nodes} → ${s1.nodes})`);
check(!s0.heapMB || s1.heapMB <= s0.heapMB * 1.3 + 25, `no memory growth (${s0.heapMB} → ${s1.heapMB} MB)`);
check(await page.evaluate(() => window.calApp.engine.running && window.calApp.measurements[0].tfReady), 'still measuring after the stress rounds');
check(errors.length === 0, `no page errors ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
await browser.close();
await hub.stop();
process.exit(failed ? 1 : 0);
