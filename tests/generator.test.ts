// The signal generator (shared by the browser worklet and the desktop audio host)
import { describe, expect, it } from 'vitest';
import { GeneratorCore } from '../src/audio/gen-core';
import type { GeneratorConfig } from '../src/audio/protocol';

const cfg = (type: GeneratorConfig['type'], level = 0): GeneratorConfig => ({ type, level, freq: 1000, outputs: [0], polarity: 1 });
const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe('generator', () => {
  const run = (g: GeneratorCore, n: number) => Array.from({ length: n }, (_, i) => g.next(i));

  it('fades out when switched off, instead of stopping on the next sample (a click)', () => {
    const g = new GeneratorCore(48000, () => undefined, () => 0);
    g.onMessage({ type: 'generator', config: cfg('pink', -6) });
    const on = run(g, 48000);
    const level = rms(on.slice(-4800));
    g.onMessage({ type: 'generator', config: cfg('off', -6) });
    const off = run(g, 9600);
    // Still sounding just after Off (fading), silent within 0.2 s
    expect(rms(off.slice(0, 48))).toBeGreaterThan(level * 0.7);
    expect(Math.max(...off.slice(-480).map(Math.abs))).toBe(0);
  });

  it('fades one signal out before the next comes in', () => {
    const g = new GeneratorCore(48000, () => undefined, () => 0);
    g.onMessage({ type: 'generator', config: cfg('sine', -6) });
    run(g, 48000);
    g.onMessage({ type: 'generator', config: cfg('pink', -6) });
    const sw = run(g, 48000);
    // No jump: neighbouring samples stay close while the sine fades (a pink sample would jump)
    let maxStep = 0;
    for (let i = 1; i < 240; i++) maxStep = Math.max(maxStep, Math.abs(sw[i] - sw[i - 1]));
    expect(maxStep).toBeLessThan(0.1);
    // Then the new signal plays at its level
    expect(rms(sw.slice(-4800))).toBeGreaterThan(0.2);
  });

  it('glides to a new level of the same signal', () => {
    const g = new GeneratorCore(48000, () => undefined, () => 0);
    g.onMessage({ type: 'generator', config: cfg('sine', -20) });
    run(g, 24000);
    g.onMessage({ type: 'generator', config: cfg('sine', -6) });
    const up = run(g, 24000);
    expect(rms(up.slice(-4800))).toBeCloseTo(Math.pow(10, -6 / 20) / Math.SQRT2, 2);
  });
});
