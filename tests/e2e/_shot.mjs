import { chromium } from 'playwright';
import { preview } from 'vite';
const server = await preview({ preview: { port: 4193, strictPort: true } });
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto('http://localhost:4193/');
await p.getByText('Explore with the demo room').click();
await p.getByRole('button', { name: 'Start demo' }).click();
await p.waitForTimeout(2500);
for (const step of process.argv.slice(2)) {
  const [kind, arg, file] = step.split('|');
  if (kind === 'key') await p.keyboard.press(arg);
  else if (kind === 'eval') await p.evaluate(arg);
  else if (kind === 'click') await p.locator(arg).first().click();
  else if (kind === 'wait') await p.waitForTimeout(+arg);
  else if (kind === 'shot') await p.screenshot({ path: `test-results/${arg}.png` });
}
console.log('errors:', errs.join(' | ') || 'none');
await b.close(); server.httpServer.close();
