// End-to-end test of the Live view panel dock: rearrange, resize, float, detach and persistence.
// Usage: npm run build && node tests/e2e/dock.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });
const server = await preview({ preview: { port: 4181, strictPort: true } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1500, height: 920 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
const layout = () => page.evaluate(() => JSON.parse(JSON.stringify(window.calApp.settings.transferLayout)));
// Docked panels of the visible (Transfer or Spectrum) view
const docked = () => page.$$eval('.view:not([style*="none"]) .dock-stack > .dpanel', (els) => els.map((e) => e.dataset.panel));
const vis = (sel) => page.locator('.view:visible').locator(sel);
const head = (id) => vis(`.dpanel[data-panel="${id}"] .dp-head`);
const box = async (sel) => (await vis(sel).first().boundingBox());

await page.goto('http://localhost:4181/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(2500);

check(JSON.stringify(await docked()) === '["mag","phase"]', `Transfer tab: default docked order ${JSON.stringify(await docked())}`);
check((await vis('.dpanel[data-panel="levels"]:visible').count()) === 0, 'the level meter panel starts hidden (the meters are in the status bar)');
await page.screenshot({ path: `${out}/dock-01-default.png` });

// 1. Rearrange: drag the phase panel's title bar above the magnitude panel
{
  const from = await head('phase').boundingBox();
  const to = await box('.dpanel[data-panel="mag"]');
  await page.mouse.move(from.x + 200, from.y + 12);
  await page.mouse.down();
  await page.mouse.move(from.x + 200, to.y + 20, { steps: 12 });
  check(await vis('.dock-drop').isVisible(), 'drop indicator shown while dragging');
  await page.mouse.up();
  check(JSON.stringify(await docked()) === '["phase","mag"]', `reordered by dragging → ${JSON.stringify(await docked())}`);
}

// 2. Resize: drag the splitter between the first two panels down
{
  const before = (await box('.dpanel[data-panel="phase"]')).height;
  const split = await box('.dock-split');
  await page.mouse.move(split.x + split.width / 2, split.y + 3);
  await page.mouse.down();
  await page.mouse.move(split.x + split.width / 2, split.y + 120, { steps: 8 });
  await page.mouse.up();
  const after = (await box('.dpanel[data-panel="phase"]')).height;
  check(after > before + 80, `splitter resizes panels (${before.toFixed(0)} → ${after.toFixed(0)} px)`);
}

// 3. Float the magnitude panel, move it, resize it, then dock it back
{
  await vis('.dpanel[data-panel="mag"] [data-act="float"]').click();
  check(await vis('.dpanel[data-panel="mag"].floating').isVisible(), 'magnitude panel floats');
  const h0 = await head('mag').boundingBox();
  await page.mouse.move(h0.x + 60, h0.y + 12);
  await page.mouse.down();
  await page.mouse.move(h0.x + 260, h0.y - 88, { steps: 10 });
  await page.mouse.up();
  const h1 = await head('mag').boundingBox();
  check(Math.abs(h1.x - h0.x - 200) < 3 && Math.abs(h1.y - h0.y + 100) < 3, 'floating panel moves with its title bar');
  // Dragging far past the bottom edge keeps the whole panel visible
  await page.mouse.move(h1.x + 60, h1.y + 12);
  await page.mouse.down();
  await page.mouse.move(h1.x + 60, h1.y + 2000, { steps: 6 });
  await page.mouse.up();
  const dockBox = await box('.dock');
  const fb = await box('.dpanel[data-panel="mag"]');
  check(fb.y + fb.height <= dockBox.y + dockBox.height + 1, 'floating panel cannot be dragged out of view');
  await page.mouse.move(fb.x + 60, fb.y + 12);
  await page.mouse.down();
  await page.mouse.move(fb.x + 60, fb.y - 300, { steps: 6 });
  await page.mouse.up();
  const g = await box('.dpanel[data-panel="mag"] .dp-resize');
  const size0 = await box('.dpanel[data-panel="mag"]');
  await page.mouse.move(g.x + 8, g.y + 8);
  await page.mouse.down();
  await page.mouse.move(g.x + 108, g.y + 68, { steps: 8 });
  await page.mouse.up();
  const size1 = await box('.dpanel[data-panel="mag"]');
  check(Math.abs(size1.width - size0.width - 100) < 3 && Math.abs(size1.height - size0.height - 60) < 3, `floating panel resizes from its corner (${size0.width.toFixed(0)}×${size0.height.toFixed(0)} → ${size1.width.toFixed(0)}×${size1.height.toFixed(0)})`);
  const canvas = await box('.dpanel[data-panel="mag"] canvas');
  check(Math.abs(canvas.width - size1.width + 2) < 4, 'plot re-renders at the new size');
  await page.screenshot({ path: `${out}/dock-02-floating.png` });
  await vis('.dpanel[data-panel="mag"] [data-act="float"]').click();
  check((await docked()).includes('mag'), 'floating panel docks back');
}

// 4. Drag a docked panel out of the stack → it floats where dropped
{
  const hd = await head('phase').boundingBox();
  await page.mouse.move(hd.x + 100, hd.y + 12);
  await page.mouse.down();
  await page.mouse.move(40, 40, { steps: 10 }); // over the sidebar, outside the dock
  await page.mouse.up();
  check(await vis('.dpanel[data-panel="phase"].floating').isVisible(), 'dropping outside the stack floats the panel');
  const lay = await layout();
  check(lay.hidden.includes('spl') && lay.hidden.includes('levels'), 'panels hidden from the toolbar chips');
  await vis('.dpanel[data-panel="phase"] [data-act="float"]').click();
  await page.locator('.view:visible [data-options]').click();
  await page.locator('.view:visible .opt-panel .chip', { hasText: 'SPL' }).click();
  await page.locator('.view:visible .opt-panel .chip', { hasText: 'Levels' }).click();
  await page.keyboard.press('Escape');
  check(JSON.stringify(await docked()) === '["phase","mag"]', 'docking back restores the panel to its place in the order');
}

// 5. Spectrum tab: detach the RTA into a separate window, check it renders live data, then close it to re-dock
await page.keyboard.press('1');
await page.waitForTimeout(500);
check(JSON.stringify(await docked()) === '["rta"]', `Spectrum tab has its own layout ${JSON.stringify(await docked())}`);
{
  const [popup] = await Promise.all([context.waitForEvent('page'), vis('.dpanel[data-panel="rta"] [data-act="popout"]').click()]);
  await popup.waitForTimeout(1500);
  check((await popup.locator('.dpanel[data-panel="rta"].popped canvas').count()) === 1, 'RTA panel moved into its own window');
  check(!(await docked()).includes('rta'), 'detached panel removed from the main window');
  const lit = await popup.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
    return { n, w: c.width, h: c.height, vw: innerWidth };
  });
  check(lit.n > 50 && lit.w >= lit.vw - 4, `detached plot is drawn and fills its window (${lit.w}×${lit.h})`);
  await popup.setViewportSize({ width: 900, height: 500 });
  await popup.waitForTimeout(400);
  const w2 = await popup.evaluate(() => document.querySelector('canvas').width / devicePixelRatio);
  check(Math.abs(w2 - 900) < 4, 'detached plot follows window resizing');
  await popup.screenshot({ path: `${out}/dock-03-popout.png` });
  await popup.waitForTimeout(900);
  await popup.close();
  await page.waitForTimeout(300);
  check((await docked()).includes('rta'), 'closing the detached window re-docks the panel');
}
// 5b. A detached panel keeps updating when its tab is not the active one (and full screen does not freeze it)
{
  const [popup] = await Promise.all([context.waitForEvent('page'), vis('.dpanel[data-panel="rta"] [data-act="popout"]').click()]);
  await popup.waitForTimeout(800);
  const saved = await page.evaluate(() => window.calApp.settings.spectrumLayout?.windows?.rta);
  const size = await popup.evaluate(() => ({ w: outerWidth, h: outerHeight }));
  check(saved && Math.abs(size.w - saved.w) < 4 && Math.abs(size.h - saved.h) < 4 && Math.abs(saved.w - 900) < 30, `detaching again reopens the window with its remembered size (${size.w}×${size.h}, saved ${saved?.w}×${saved?.h})`);
  await page.keyboard.press('2'); // main window shows the Transfer tab now
  const snap = () => popup.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4 * 53) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    return h;
  });
  const a1 = await snap();
  await popup.waitForTimeout(1200);
  const a2 = await snap();
  check(a1 !== a2, 'detached RTA keeps updating while the main window shows another tab');
  await popup.locator('[data-act="fullscreen"]').click();
  await popup.waitForTimeout(800);
  const fs = await popup.evaluate(() => {
    const f = document.querySelector('.dpanel');
    return { on: f.classList.contains('is-fullscreen'), w: document.querySelector('canvas').width / devicePixelRatio, vw: innerWidth };
  });
  const b1 = await snap();
  await popup.waitForTimeout(1200);
  const b2 = await snap();
  check(fs.on && Math.abs(fs.w - fs.vw) < 4 && b1 !== b2, `full-screen detached panel fills the window and keeps updating (${fs.w}/${fs.vw})`);
  await popup.close();
  await page.waitForTimeout(300);
}
await page.waitForTimeout(300);

// 5c. Full screen a docked panel in the main window
{
  await vis('.dpanel[data-panel="mag"] [data-act="fullscreen"]').click();
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => {
    const f = document.querySelector('.dpanel[data-panel="mag"]');
    const c = f.querySelector('canvas');
    return { on: f.classList.contains('is-fullscreen'), w: c.width / devicePixelRatio, h: c.height / devicePixelRatio, vw: innerWidth, vh: innerHeight };
  });
  check(st.on && st.w > st.vw - 4 && st.h > st.vh - 80, `panel full screen fills the screen (${st.w}×${st.h})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check(!(await page.evaluate(() => document.querySelector('.dpanel[data-panel="mag"]').classList.contains('is-fullscreen'))), 'Escape leaves full screen');
}

// 6. Meters show data and the arrangement persists across reloads
{
  const spl = await page.locator('.view:visible .spl-val').textContent();
  check(/-?\d+\.\d/.test(spl), `SPL meter panel shows a reading (${spl})`);
  check((await page.locator('.view:visible .lv-col').count()) === 3, 'level meter panel shows In 1, In 2 and Gen');
  const before = await layout();
  await page.reload();
  await page.waitForSelector('.view:visible .dock');
  const after = await layout();
  check(JSON.stringify(before.order) === JSON.stringify(after.order) && JSON.stringify(await docked()) === '["phase","mag"]', 'layout persists across reloads');
  await page.locator('.view:visible [data-options]').click();
  await page.locator('.view:visible').getByRole('button', { name: 'Reset layout' }).click();
  await page.keyboard.press('Escape');
  check(JSON.stringify(await docked()) === '["mag","phase"]', 'Reset layout restores the default arrangement');
}
await page.screenshot({ path: `${out}/dock-04-final.png` });

check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
server.httpServer.close();
process.exit(failed ? 1 : 0);
