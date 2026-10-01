// Accessibility checks: every button, list and input on every tab has a name screen readers can read, messages
// and assistant tips are live regions, and the Options panels work from the keyboard.
// Usage: npm run build && node tests/e2e/a11y.mjs
import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4192, strictPort: true } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};

await page.goto('http://localhost:4192/');
await page.getByText('Explore with the demo room').click();
await page.getByRole('button', { name: 'Start demo' }).click();
await page.waitForTimeout(2500);

const unnamed = () =>
  page.evaluate(() => {
    const named = (el) => !!(el.getAttribute('aria-label') || el.title || el.closest('label') || (el.tagName === 'BUTTON' && el.textContent.trim()));
    return [...document.querySelectorAll('button, select, input:not([type=hidden]):not([type=file]), textarea')]
      .filter((el) => el.getClientRects().length && !named(el))
      .map((el) => el.outerHTML.slice(0, 100));
  });
const missing = new Set();
for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
  await page.keyboard.press(k);
  await page.waitForTimeout(300);
  for (const m of await unnamed()) missing.add(`tab ${k}: ${m}`);
}
// Options panels too
await page.keyboard.press('1');
await page.locator('[data-options="spectrum"]').click();
for (const m of await unnamed()) missing.add(`options: ${m}`);
check(missing.size === 0, `every control has an accessible name${missing.size ? `: ${[...missing].join(' | ')}` : ''}`);

// Escape closes the panel and returns focus to its button
await page.keyboard.press('Escape');
const closed = await page.evaluate(() => !document.querySelector('.opt-wrap.open') && document.activeElement?.dataset.options === 'spectrum');
check(closed, 'Escape closes the Options panel and returns focus to its button');

const live = await page.evaluate(() => ({
  toasts: document.querySelector('.toasts')?.getAttribute('aria-live'),
  hints: document.querySelector('.hints')?.getAttribute('aria-live'),
}));
check(live.toasts === 'polite' && live.hints === 'polite', 'messages and assistant tips are announced (live regions)');

// A warning is announced at once
await page.evaluate(() => window.calApp.toast('Test warning', 'warn'));
check((await page.locator('.toast[role="alert"]').count()) === 1, 'warnings use the alert role');

// Icons are hidden from screen readers (their buttons carry the name)
const icons = await page.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => s.getClientRects().length && s.closest('button') && s.getAttribute('aria-hidden') !== 'true').length);
check(icons === 0, 'button icons are hidden from screen readers');

await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
