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
