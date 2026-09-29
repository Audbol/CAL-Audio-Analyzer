// Native audio module (built with `npm run build:native`): the virtual interface returns the output 480 samples
// later on input 2. Skipped when the module hasn't been built.
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../native/build/Release/cal_audio.node', import.meta.url));
const built = existsSync(path);

interface Addon {
  open(o: object, notify: () => void): { bufferFrames: number };
  start(): void;
  close(): void;
  read(): { data: Float32Array; frames: number; silent: number; underruns: number; queued: number };
  write(a: Float32Array): number;
  setOutputs(c: number[]): void;
  apis(): string[];
}

describe.skipIf(!built)('native audio module', () => {
  it('keeps the internal reference sample-aligned through generator dropouts', async () => {
    process.env.CAL_NATIVE_TEST = '1';
    const a = createRequire(import.meta.url)(path) as Addon;
    expect(a.apis()).toContain('test');
    a.open({ api: 'test', device: 0, sampleRate: 48000, bufferFrames: 256 }, () => undefined);
    a.setOutputs([0]);
    let g = 0;
    const gen = (n: number) => Float32Array.from({ length: n }, () => (g++ % 2000 === 7 ? 1 : 0));
    a.write(gen(2400));
    a.start();
    const rows: [number, number][] = [];
    let starve = false;
    let last: ReturnType<Addon['read']> | null = null;
    const t = setInterval(() => {
      const r = a.read();
      last = r;
      for (let i = 0; i < r.frames; i++) rows.push([r.data[i * 3 + 1], r.data[i * 3 + 2]]);
      if (!starve && r.queued < 2400) a.write(gen(1200));
    }, 5);
    await new Promise((r) => setTimeout(r, 400));
    starve = true;
    await new Promise((r) => setTimeout(r, 150));
    starve = false;
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(t);
    a.close();
    const refs = rows.map((r, i) => (r[1] === 1 ? i : -1)).filter((i) => i >= 0 && i + 480 < rows.length);
    expect(refs.length).toBeGreaterThan(15);
    expect(last!.underruns).toBeGreaterThan(0);
    // Every generator impulse actually played appears on the loopback input exactly 480 samples later
    for (const i of refs) expect(rows[i + 480][0]).toBe(1);
  });
});
