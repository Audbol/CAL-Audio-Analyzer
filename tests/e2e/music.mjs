// End-to-end test of the music generator and playlist (demo room, generated WAV files).
// Usage: npm run build && node tests/e2e/music.mjs [outDir]
import { chromium } from 'playwright';
import { preview } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'test-results';
fs.mkdirSync(out, { recursive: true });

/** A short stereo 16-bit WAV: a chord plus a little noise (music-like, broadband enough for a TF). */
export function makeWav(file, seconds, f0, rate = 44100) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 4);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = 0.25 * (Math.sin(2 * Math.PI * f0 * t) + Math.sin(2 * Math.PI * f0 * 1.25 * t) + Math.sin(2 * Math.PI * f0 * 1.5 * t)) / 3 + 0.2 * rnd();
    const s = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const songA = makeWav(path.join(out, 'Song A.wav'), 2.5, 220);
  const songB = makeWav(path.join(out, 'Song B.wav'), 2.5, 330);
  const server = await preview({ preview: { port: 4181, strictPort: true } });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 920 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let failed = false;
  const check = (ok, msg) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
    if (!ok) failed = true;
  };

  await page.goto('http://localhost:4181/');
  await page.getByText('Explore with the demo room').click();
  await page.getByRole('button', { name: 'Start demo' }).click();
  await page.waitForTimeout(2500);

  // Choosing "Music" with an empty playlist opens the playlist window
  await page.locator('.gen-controls select').first().selectOption('music');
  await page.waitForSelector('.pl-modal', { timeout: 3000 });
  check(true, 'choosing Music opens the playlist');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.pl-modal').getByRole('button', { name: 'Add songs…' }).click();
  await (await chooser).setFiles([songA, songB]);
  await page.waitForFunction(() => window.calApp.playlist.state().tracks.length === 2, null, { timeout: 5000 });
  check(true, 'two songs added');
  // The generator was on (pink noise), so choosing Music switched it straight to the playlist
  check((await page.locator('.pl-modal').getByRole('button', { name: 'Stop music' }).count()) === 1, 'the playlist shows the music is playing');
  await page.waitForFunction(() => (window.calApp.engine.musicPos?.pos ?? 0) > 20000, null, { timeout: 8000 }).catch(() => undefined);
  const st1 = await page.evaluate(() => ({ gen: window.calApp.settings.generator.type, rms: window.calApp.engine.genLevel.rms, cur: window.calApp.playlist.state() }));
  check(st1.gen === 'music', 'generator plays music');
  check(st1.rms > 0.01, `music reaches the generator output (RMS ${st1.rms.toFixed(3)})`);
  check(st1.cur.tracks.find((t) => t.id === st1.cur.current)?.name === 'Song A', 'first song plays first');
  await page.locator('.pl-modal').screenshot({ path: `${out}/music-01-playlist.png` });
  await page.keyboard.press('Escape');

  // Level matching: the generator level sets the song's RMS like for noise (−18 dBFS setting → ≈ −21 dBFS RMS)
  await page.waitForTimeout(600);
  const rmsDb = await page.evaluate(() => 20 * Math.log10(window.calApp.engine.genLevel.rms));
  check(Math.abs(rmsDb - -21) < 3, `songs are level-matched to the generator setting (${rmsDb.toFixed(1)} dBFS RMS)`);

  // The music is the transfer-function reference
  await page.keyboard.press('2');
  await page.waitForTimeout(1200);
  const coh = await page.evaluate(() => {
    const a = window.calApp;
    const m = a.measurements[0];
    let c = 0, n = 0;
    a.grid.forEach((f, i) => { if (f > 200 && f < 5000) { c += m.result.coh[i]; n++; } });
    return c / n;
  });
  check(coh > 0.4, `transfer function works with music as the reference (coherence ${coh.toFixed(2)})`);
  await page.screenshot({ path: `${out}/music-02-transfer.png` });

  // At the end of a song the next one starts; repeat all wraps around
  await page.waitForFunction(() => { const s = window.calApp.playlist.state(); return s.tracks.find((t) => t.id === s.current)?.name === 'Song B'; }, null, { timeout: 8000 }).catch(() => undefined);
  check(await page.evaluate(() => { const s = window.calApp.playlist.state(); return s.tracks.find((t) => t.id === s.current)?.name === 'Song B'; }), 'next song starts at the end of the first');
  await page.waitForFunction(() => { const s = window.calApp.playlist.state(); return s.tracks.find((t) => t.id === s.current)?.name === 'Song A'; }, null, { timeout: 8000 }).catch(() => undefined);
  check(await page.evaluate(() => { const s = window.calApp.playlist.state(); return s.tracks.find((t) => t.id === s.current)?.name === 'Song A'; }), 'repeat all wraps to the first song');
  check((await page.locator('.music-title').textContent()).length > 0, 'the generator bar shows the current song');
  await page.locator('.topbar').screenshot({ path: `${out}/music-03-topbar.png` });

  // Generator off pauses the song; on resumes it
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  const p1 = await page.evaluate(() => window.calApp.engine.musicPos.pos);
  await page.waitForTimeout(600);
  const p2 = await page.evaluate(() => window.calApp.engine.musicPos.pos);
  check(p1 === p2, 'switching the generator off pauses the song');
  await page.keyboard.press(' ');

  // Controls: next, reorder, remove
  await page.evaluate(() => window.calApp.playlist.act({ action: 'next' }));
  await page.waitForTimeout(800);
  const ids = await page.evaluate(() => window.calApp.playlist.state().tracks.map((t) => t.name));
  await page.evaluate(() => { const s = window.calApp.playlist.state(); window.calApp.playlist.act({ action: 'move', id: s.tracks[1].id, to: 0 }); });
  const ids2 = await page.evaluate(() => window.calApp.playlist.state().tracks.map((t) => t.name));
  check(ids2[0] === ids[1] && ids2[1] === ids[0], 'songs can be reordered');

  // The playlist is kept after a restart
  await page.reload();
  await page.waitForTimeout(1500);
  const kept = await page.evaluate(() => window.calApp.playlist.state().tracks.map((t) => t.name));
  check(JSON.stringify(kept) === JSON.stringify(ids2), `the playlist is kept after a restart (${kept.join(', ')})`);
  await page.evaluate(() => { const s = window.calApp.playlist.state(); window.calApp.playlist.act({ action: 'remove', id: s.tracks[0].id }); });
  check((await page.evaluate(() => window.calApp.playlist.state().tracks.length)) === 1, 'songs can be removed');

  check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
  await browser.close();
  server.httpServer.close();
  process.exit(failed ? 1 : 0);
}
