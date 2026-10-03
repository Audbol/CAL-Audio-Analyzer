// Accessibility checks: every button, list and input on every tab has a name screen readers can read, messages
// and new assistant tips are announced (once), and the Options panels work from the keyboard.
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
for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
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

// Screen-reader announcements: one polite and one assertive region; a warning goes to the assertive one
const regions = await page.evaluate(() => [...document.querySelectorAll('.sr-only[aria-live]')].map((e) => e.getAttribute('aria-live')).sort());
check(regions.join() === 'assertive,polite', `one polite and one assertive announcer (${regions.join(', ')})`);
check((await page.locator('[aria-live] [aria-live], [role=status] [role=alert]').count()) === 0, 'no nested live regions (nothing is read twice)');
await page.evaluate(() => window.calApp.toast('Test warning', 'warn'));
await page.waitForTimeout(100);
check((await page.locator('.sr-only[aria-live="assertive"]').textContent()) === 'Test warning', 'warnings are announced at once');
// Assistant tips are announced once, not every time a number in them changes
const heard = await page.evaluate(async () => {
  const el = document.querySelector('.sr-only[aria-live="polite"]');
  const said = [];
  new MutationObserver(() => el.textContent && said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  await new Promise((r) => setTimeout(r, 4000));
  return said.filter((t) => t.startsWith('Assistant')).length;
});
check(heard <= 1, `assistant tips are not re-announced while measuring (${heard} in 4 s)`);
// Fields that share a row label have names of their own
await page.keyboard.press('6');
await page.locator('[data-options="eq"]').click();
const same = await page.evaluate(() => [...document.querySelectorAll('.opt-wrap.open .opt-row')].filter((r) => {
  const names = [...r.querySelectorAll('select, input')].map((e) => e.getAttribute('aria-label') || e.title);
  return names.length > 1 && new Set(names).size < names.length;
}).length);
check(same === 0, 'fields that share a row have different names');
await page.keyboard.press('Escape');

// Icons are hidden from screen readers (their buttons carry the name)
const icons = await page.evaluate(() => [...document.querySelectorAll('svg')].filter((s) => s.getClientRects().length && s.closest('button') && s.getAttribute('aria-hidden') !== 'true').length);
check(icons === 0, 'button icons are hidden from screen readers');

await browser.close();
await new Promise((r) => server.httpServer.close(r));
process.exit(failed ? 1 : 0);
