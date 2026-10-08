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
  devices(api: string): { id: number; name: string; inputs: number; outputs: number; sampleRates: number[]; preferredRate: number }[];
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

  it('keeps playing and keeps count when JavaScript falls behind (capture ring full)', async () => {
    process.env.CAL_NATIVE_TEST = '1';
    const a = createRequire(import.meta.url)(path) as Addon;
    a.open({ api: 'test', device: 0, sampleRate: 48000, bufferFrames: 256 }, () => undefined);
    a.setOutputs([0]);
    a.write(new Float32Array(48000).fill(0.1));
    a.start();
    // Nothing read for 2.6 s: the 2 s capture ring fills
    await new Promise((r) => setTimeout(r, 2600));
    type R = ReturnType<Addon['read']> & { played: number; consumed: number; overruns: number };
    const r = a.read() as R;
    const captured = r.frames;
    a.close();
    // The output went on (a whole second of signal played), and the frames lost are counted: a sample played
    // at frame p is captured at p + shift, with shift = −(frames lost)
    expect(r.overruns).toBeGreaterThan(0);
    expect(r.consumed).toBe(48000);
    const shift = r.silent - (r.played - r.consumed);
    // (Within a driver buffer or two: one can arrive between taking the frames and reading the counts)
    expect(Math.abs(-shift - (r.played - captured))).toBeLessThanOrEqual(512);
    expect(-shift).toBeGreaterThan(0);
  });

  it('keeps the reference aligned with two devices on separate clocks (input and output 500 ppm apart)', async () => {
    process.env.CAL_NATIVE_TEST = '1';
    const a = createRequire(import.meta.url)(path) as Addon;
    expect(a.devices('test').map((d) => d.outputs > 0 && d.inputs === 0)).toEqual([false, true]);
    const info = a.open({ api: 'test', device: 0, outputDevice: 1, sampleRate: 48000, bufferFrames: 256 }, () => undefined) as unknown as { split: boolean; outputName: string };
    expect(info.split).toBe(true);
    expect(info.outputName).toMatch(/separate clock/);
    a.setOutputs([0]);
    let g = 0;
    const gen = (n: number) => Float32Array.from({ length: n }, () => (g++ % 2000 === 7 ? 1 : 0));
    a.write(gen(4800));
    a.start();
    const rows: [number, number][] = [];
    type Read = ReturnType<Addon['read']> & { drift: number; inputFrames: number };
    let last: Read | null = null;
    let mid: Read | null = null;
    const t0 = Date.now();
    const t = setInterval(() => {
      const r = a.read() as Read;
      last = r;
      if (!mid && Date.now() - t0 > 2500) mid = r;
      for (let i = 0; i < r.frames; i++) rows.push([r.data[i * 3 + 1], r.data[i * 3 + 2]]);
      if (r.queued < 4800) a.write(gen(2400));
    }, 5);
    await new Promise((r) => setTimeout(r, 5000));
    clearInterval(t);
    a.close();
    // Each impulse in the reference arrives on the loopback input about 2400 samples later (less the queue
    // between the devices). The clocks alone move that by 24 samples a second (60 over the test); once the
    // servo has learnt the drift (about two seconds for this much), it holds within a few samples. (The simulated
    // devices keep simulated hardware time, so this doesn't depend on how busy the computer is.)
    const offsets: { at: number; off: number }[] = [];
    rows.forEach((r, i) => {
      if (r[1] !== 1 || i + 3000 >= rows.length) return;
      let best = 0;
      let at = 0;
      for (let k = i + 1200; k < i + 3000; k++) if (rows[k][0] > best) [best, at] = [rows[k][0], k];
      if (best > 0.4) offsets.push({ at: i, off: at - i });
    });
    const settled = offsets.filter((o) => o.at > 48000 * 2.5);
    expect(settled.length).toBeGreaterThan(20);
    const offs = settled.map((o) => o.off);
    const med = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
    const median = med(offs);
    expect(offs.filter((o) => Math.abs(o - median) <= 3).length).toBeGreaterThanOrEqual(offs.length * 0.95);
    // No trend: the first and last thirds agree (the clocks alone would part them by about 20 samples)
    const third = Math.floor(offs.length / 3);
    expect(Math.abs(med(offs.slice(-third)) - med(offs.slice(0, third)))).toBeLessThan(5);
    expect(median).toBeGreaterThan(1900);
    expect(median).toBeLessThan(2400);
    // The servo follows the drift: about 500 ppm of the output dropped (≈ 24 samples a second)
    const ppm = ((last!.drift - mid!.drift) / (last!.inputFrames - mid!.inputFrames)) * 1e6;
    expect(ppm).toBeGreaterThan(250);
    expect(ppm).toBeLessThan(1000);
  }, 15000);

  it('offers the platform’s native API (ASIO, Core Audio, or JACK / PipeWire and ALSA)', () => {
    const a = createRequire(import.meta.url)(path) as Addon;
    const apis = a.apis();
    if (process.platform === 'win32') expect(apis).toContain('asio');
    if (process.platform === 'darwin') expect(apis).toContain('core');
    if (process.platform === 'linux') expect(apis).toContain('alsa');
    // Listing never throws, even with no hardware or server
    for (const api of apis) expect(Array.isArray(a.devices(api))).toBe(true);
  });

  // A JACK server must be running (CI starts one with the dummy driver): CAL_JACK_TEST=1
  it.skipIf(process.env.CAL_JACK_TEST !== '1')('streams through JACK / PipeWire at the server’s rate', async () => {
    const a = createRequire(import.meta.url)(path) as Addon;
    expect(a.apis()).toContain('jack');
    const dev = a.devices('jack').find((d) => d.inputs > 0 && d.outputs > 0)!;
    expect(dev).toBeTruthy();
    const info = a.open({ api: 'jack', device: dev.id, sampleRate: dev.preferredRate, bufferFrames: 256 }, () => undefined) as { sampleRate: number; inputs: number; bufferFrames: number };
    expect(info.sampleRate).toBe(dev.preferredRate);
    expect(info.inputs).toBe(dev.inputs);
    a.setOutputs([0]);
    a.write(new Float32Array(info.sampleRate / 2).fill(0.25));
    a.start();
    let frames = 0;
    let consumed = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 800) {
      await new Promise((r) => setTimeout(r, 20));
      const r = a.read();
      frames += r.frames;
      consumed = (r as unknown as { consumed: number }).consumed;
      // Every captured frame carries the inputs and the generator sample played with them
      expect(r.data.length).toBe(r.frames * (info.inputs + 1));
    }
    a.close();
    // About 0.8 s of audio arrived, and the generator signal written was played
    expect(frames).toBeGreaterThan(info.sampleRate * 0.5);
    expect(consumed).toBe(info.sampleRate / 2);
  });
});
