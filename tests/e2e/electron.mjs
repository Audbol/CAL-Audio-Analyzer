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
const [popup] = await Promise.all([app.waitForEvent('window'), page.locator('.dpanel[data-panel="rta"] [data-act="popout"]').click()]);
await popup.waitForTimeout(1200);
check((await popup.locator('.dpanel.popped canvas').count()) === 1, 'panel detaches into a separate desktop window');
await popup.close();
await page.waitForTimeout(300);
check((await page.locator('.dock-stack .dpanel[data-panel="rta"]').count()) === 1, 'closing the window re-docks the panel');
await page.reload();
await page.waitForSelector('.topbar');
const persisted = await page.evaluate(() => window.calApp.settings.wizardDone);
check(persisted, 'settings persist across reloads');
await page.screenshot({ path: 'test-results/electron.png' });
check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await app.close();
process.exit(failed ? 1 : 0);
