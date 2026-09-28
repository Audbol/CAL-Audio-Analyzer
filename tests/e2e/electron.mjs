// Smoke test for the packaged desktop app: launches Electron, runs the demo room and checks the analysis.
// Usage: npm run build && node tests/e2e/electron.mjs [path-to-app-executable]
import { _electron as electron } from 'playwright';

const exe = process.argv[2];
const app = await electron.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['.', '--no-sandbox'] });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
await page.waitForSelector('.topbar');
// Start from a clean profile so the first-run wizard appears
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('.topbar');
check((await page.title()) === 'CAL Audio Analyzer', 'window loads the app');
check(page.url().startsWith('app://cal/'), `served from secure app:// origin (${page.url()})`);
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(6000);
const s = await page.evaluate(() => {
  const a = window.calApp;
  const m = a.measurements[0];
  let c = 0, n = 0;
  a.grid.forEach((f, i) => { if (f > 300 && f < 8000) { c += m.result.coh[i]; n++; } });
  return { running: a.engine.running, delayMs: (m.cfg.delay / a.fs) * 1000, coh: c / n, secure: window.isSecureContext };
});
console.log(JSON.stringify(s));
check(s.secure, 'secure context (required for microphone access)');
check(s.running, 'audio engine + AudioWorklet running');
check(Math.abs(s.delayMs - 12.54) < 0.2, `delay finder (${s.delayMs.toFixed(2)} ms)`);
check(s.coh > 0.6, `coherence ${s.coh.toFixed(2)}`);
const perm = await page.evaluate(async () => {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    st.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (e) {
    return String(e.name);
  }
});
// In CI/containers there is no audio input device; the permission itself must not be denied
check(perm !== 'NotAllowedError', `microphone permission not blocked (${perm})`);
// Detach a panel into its own desktop window
const [popup] = await Promise.all([app.waitForEvent('window'), page.locator('.dpanel[data-panel="mag"] [data-act="popout"]').click()]);
await popup.waitForTimeout(1200);
check((await popup.locator('.dpanel.popped canvas').count()) === 1, 'panel detaches into a separate desktop window');
await popup.close();
await page.waitForTimeout(300);
check((await page.locator('.dock-stack .dpanel[data-panel="mag"]').count()) === 1, 'closing the window re-docks the panel');
// Remote access: turn on the built-in server from Tools and connect a separate browser to it
{
  await page.keyboard.press('8');
  await page.getByRole('button', { name: 'Turn on remote access' }).click();
  await page.waitForFunction(() => window.calApp.hostLink?.connected && window.calApp.hostLink.info, null, { timeout: 8000 });
  const srv = await page.evaluate(() => ({ port: window.calApp.settings.remoteServer.port, pin: window.calApp.hostLink.info.pin, urls: window.calApp.hostLink.info.urls.length }));
  check(srv.port > 0 && srv.pin.length === 6, `desktop app runs the remote-access server (port ${srv.port}, ${srv.urls} network address${srv.urls === 1 ? '' : 'es'})`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const rem = await browser.newPage();
  await rem.goto(`http://127.0.0.1:${srv.port}/?pin=${srv.pin}`);
  await rem.waitForFunction(() => window.calApp?.engine.running === true, null, { timeout: 15000 }).catch(() => undefined);
  check(await rem.evaluate(() => window.calApp.engine.running), 'a browser connects to the desktop app and receives live audio');
  await browser.close();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.waitForTimeout(300);
  check(!(await page.evaluate(() => window.calApp.hostLink)), 'remote access turns off');
}
await page.reload();
await page.waitForSelector('.topbar');
const persisted = await page.evaluate(() => window.calApp.settings.wizardDone);
check(persisted, 'settings persist across reloads');
await page.screenshot({ path: 'test-results/electron.png' });
check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await app.close();
process.exit(failed ? 1 : 0);
