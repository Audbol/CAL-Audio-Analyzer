// Regenerates the screenshots in docs/ (README) and docs/guide/ (user guide) from the demo room.
// Usage: npm run build && node scripts/docs-screenshots.mjs
import { chromium, devices } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeWav } from '../tests/e2e/music.mjs';

const require = createRequire(import.meta.url);
const { createHub } = require('../electron/hub.cjs');
const DOCS = path.resolve('docs');
const GUIDE = path.join(DOCS, 'guide');
fs.mkdirSync(GUIDE, { recursive: true });
const PORT = 8575;
const hub = createHub({ distDir: path.resolve('dist'), pin: '482915', allowControl: true, version: 'docs' });
await hub.start(PORT);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const shot = async (file, opts = {}) => {
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(opts.wait ?? 400);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await (opts.el ? page.locator(opts.el).first() : page).screenshot({ path: file });
  console.log('saved', path.relative(process.cwd(), file));
};
const key = async (k, wait = 900) => {
  await page.keyboard.press(k);
  await page.waitForTimeout(wait);
};

// --- First start: the welcome wizard
await page.goto(`http://localhost:${PORT}/host`);
await page.waitForSelector('.modal');
await shot(path.join(GUIDE, 'welcome.png'));
await page.getByText('Measure a real system').click();
await page.getByRole('button', { name: 'Next', exact: true }).click();
await shot(path.join(GUIDE, 'connect.png'));
await page.getByRole('button', { name: 'Back', exact: true }).click();
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(9000);

// --- Transfer function (README hero) and day mode
await key('2', 600);
await page.locator('.toolbar select[data-setting="tfSmoothing"]').first().selectOption('12');
await page.waitForTimeout(2000);
await shot(path.join(DOCS, 'screenshot-live.png'));
await shot(path.join(GUIDE, 'transfer.png'));
await key('t', 1200);
await shot(path.join(DOCS, 'screenshot-day.png'));
await key('t', 600);

// --- Spectrum: bars with a target, then the line with the average curve
await key('1', 600);
await page.evaluate(() => {
  const a = window.calApp;
  a.settings.targetCurve = 'house';
  a.settings.rtaAverageCurve = 10;
  a.syncSettingControls();
  a.views.find((v) => v.id === 'spectrum').setStyle('bars');
});
await page.waitForTimeout(4000);
await shot(path.join(DOCS, 'screenshot-bars.png'));
await page.evaluate(() => window.calApp.views.find((v) => v.id === 'spectrum').setStyle('line'));
await page.locator('.toolbar select[data-setting="rtaSmoothing"]').first().selectOption('24');
await page.waitForTimeout(3000);
await shot(path.join(GUIDE, 'spectrum.png'));
await page.locator('[data-options="spectrum"]').click();
await page.waitForTimeout(300);
await shot(path.join(GUIDE, 'options.png'));
await page.keyboard.press('Escape');

// --- Spectrogram and impulse response
await key('3', 25000);
await shot(path.join(GUIDE, 'spectrogram.png'));
await key('4', 1500);
await shot(path.join(GUIDE, 'impulse.png'));

// --- Sweep & Room: reverberation table, frequency response with a target
await key('5', 600);
await page.getByRole('button', { name: 'Measure sweep' }).click();
await page.waitForFunction(() => window.calApp.views.find((v) => v.id === 'room').result !== null, null, { timeout: 40000 });
await page.waitForTimeout(800);
await page.locator('.room-tabs-row').getByRole('button', { name: 'Reverberation (RT60)' }).click();
await shot(path.join(DOCS, 'screenshot-room.png'), { wait: 800 });
await page.locator('.room-tabs-row').getByRole('button', { name: 'Frequency response' }).click();
await page.locator('select[data-setting="roomTargetCurve"]').selectOption('house');
await shot(path.join(GUIDE, 'sweep.png'), { wait: 800 });
await page.locator('.room-tabs-row').getByRole('button', { name: 'Waterfall' }).click();
await shot(path.join(GUIDE, 'waterfall.png'), { wait: 1200 });
await page.locator('.room-tabs-row').getByRole('button', { name: 'Frequency response' }).click();

// --- EQ assistant
await key('6', 600);
await page.getByRole('button', { name: 'Calculate EQ' }).click();
await shot(path.join(GUIDE, 'eq.png'), { wait: 1200 });

// --- Align
await key('7', 600);
await shot(path.join(GUIDE, 'align.png'), { wait: 800 });

// --- SPL meter and noise log
await key('8', 3000);
await shot(path.join(GUIDE, 'spl.png'));
await page.locator('select[data-log="interval"]').selectOption('1');
await page.locator('button[data-log="toggle"]').click();
await page.waitForTimeout(8000);
await shot(path.join(GUIDE, 'noise-log.png'));
await page.locator('button[data-log="toggle"]').click();

// --- Tools: microphones, remote access, display & performance
await key('9', 800);
await page.getByRole('button', { name: 'Add microphone' }).click();
await page.locator('.mic-row').first().locator('input[data-mic="name"]').fill('Measurement mic');
await page.locator('.mic-row').first().locator('input[data-mic="name"]').dispatchEvent('change');
await page.locator('.mic-row').first().locator('[data-mic="calibrate"]').click();
await page.waitForTimeout(600);
await shot(path.join(GUIDE, 'mics.png'), { el: '.tool-card:has(h4:has-text("Microphones"))' });
await page.locator('[data-section="remote"]').click();
await page.waitForTimeout(500);
await shot(path.join(DOCS, 'screenshot-remote-host.png'), { el: '.tool-card:has(h4:has-text("Remote access"))' });
await page.locator('[data-section="display"]').click();
await shot(path.join(GUIDE, 'performance.png'), { el: '.tool-card:has(h4:has-text("Display & performance"))' });
await page.locator('[data-section="session"]').click();
await shot(path.join(GUIDE, 'session.png'), { el: '.tool-card:has(h4:has-text("Session & report"))' });

// --- Workspace menu (the native list can't be captured: show the control itself)
await page.evaluate(() => window.scrollTo(0, 0));
await key('2', 1200);

// --- Music generator with a playlist
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-docs-'));
const songs = [makeWav(path.join(tmp, 'Reference track.wav'), 3, 220), makeWav(path.join(tmp, 'Vocal check.wav'), 3, 330)];
await page.locator('.gen-controls select').first().selectOption('music');
await page.waitForSelector('.pl-modal', { timeout: 3000 });
const chooser = page.waitForEvent('filechooser');
await page.locator('.pl-modal').getByRole('button', { name: 'Add songs…' }).click();
await (await chooser).setFiles(songs);
await page.waitForFunction(() => window.calApp.playlist.state().tracks.length === 2, null, { timeout: 5000 });
await shot(path.join(DOCS, 'screenshot-music.png'), { wait: 1500 });
await page.keyboard.press('Escape');
await page.locator('.gen-controls select').first().selectOption('pink');

// --- A phone connected as a remote display
const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
const phone = await phoneCtx.newPage();
await phone.goto(`http://127.0.0.1:${PORT}/?pin=482915`);
await phone.waitForFunction(() => window.calApp?.engine.running === true, null, { timeout: 15000 });
await phone.keyboard.press('1').catch(() => undefined);
await phone.waitForTimeout(4000);
await phone.screenshot({ path: path.join(DOCS, 'screenshot-phone.png') });
console.log('saved docs/screenshot-phone.png');

if (errors.length) console.log('page errors:', errors.join(' | '));
await browser.close();
await hub.stop();
fs.rmSync(tmp, { recursive: true, force: true });
