// Renders the PNG versions of the logo set (after scripts/make-logo.py): the mark at 1024 px and the
// 1280 × 640 social preview. Usage: node scripts/render-logo.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const dir = 'docs/brand';
const browser = await chromium.launch();
for (const [svg, png, scale] of [
  ['cal-mark.svg', 'cal-mark.png', 2],
  ['social-preview.svg', 'social-preview.png', 1],
]) {
  const src = fs.readFileSync(`${dir}/${svg}`, 'utf8');
  const [, w, h] = src.match(/viewBox="0 0 (\d+) (\d+)"/).map(Number);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.setContent(`<html><body style="margin:0;line-height:0">${src}</body></html>`);
  await page.screenshot({ path: `${dir}/${png}`, omitBackground: true });
  await page.close();
  console.log(`saved ${dir}/${png}`);
}
await browser.close();
