import { describe, expect, it } from 'vitest';
import { designFir, firResponse, wavBytes } from '../src/dsp/fir';
import { eqResponse, type PeqFilter } from '../src/dsp/eq';
import { idealSum, xoverCurve, applyXover } from '../src/dsp/crossover';
import { alignSubMain } from '../src/dsp/align';
import { logGrid } from '../src/dsp/freq';

const eq: PeqFilter[] = [
  { type: 'peak', f: 63, gain: -6, q: 4 },
  { type: 'peak', f: 1000, gain: 3, q: 1.4 },
  { type: 'highshelf', f: 8000, gain: -4, q: 0.7 },
];

describe('FIR correction', () => {
  for (const phase of ['minimum', 'linear'] as const) {
    it(`${phase} phase matches the parametric EQ`, () => {
      const r = designFir(eq, { fs: 48000, taps: 16384, phase, headroom: false });
      expect(r.taps.length).toBe(16384);
      const f = [40, 63, 200, 1000, 4000, 12000];
      const want = eqResponse(eq, f);
      const got = firResponse(r.taps, 48000, f);
      for (let i = 0; i < f.length; i++) expect(Math.abs(got[i] - want[i])).toBeLessThan(0.5);
      expect(r.accurateFrom).toBeLessThan(40);
      expect(r.latencyMs).toBeCloseTo(phase === 'linear' ? (8192 / 48000) * 1000 : 0, 6);
    });
  }
  it('headroom lowers boosts to 0 dB', () => {
    const r = designFir(eq, { fs: 48000, taps: 8192, phase: 'minimum', headroom: true });
    expect(r.gainDb).toBeLessThan(-2.5);
    const got = firResponse(r.taps, 48000, logGrid(30, 18000, 24));
    expect(Math.max(...got)).toBeLessThan(0.3);
  });
  it('short filters report where they stop being accurate', () => {
    const r = designFir(eq, { fs: 48000, taps: 512, phase: 'linear', headroom: false });
    expect(r.accurateFrom).toBeGreaterThan(60);
  });
  it('writes WAV files', () => {
    const b = new DataView(wavBytes([0, 0.5, -0.5], 48000, 'pcm24'));
    expect(b.byteLength).toBe(44 + 9);
    expect(b.getUint16(20, true)).toBe(1);
    expect(b.getUint16(34, true)).toBe(24);
    const f = new DataView(wavBytes([0.25], 96000, 'float32'));
    expect(f.getUint16(20, true)).toBe(3);
    expect(f.getUint32(24, true)).toBe(96000);
    expect(f.getFloat32(44, true)).toBeCloseTo(0.25);
  });
});

describe('Crossover designer', () => {
  const freqs = logGrid(20, 1000, 48);
  const at = (arr: Float64Array, f: number) => arr[freqs.findIndex((x) => x >= f)];
  it('Linkwitz-Riley parts are −6 dB at the corner and sum flat', () => {
    const d = { on: true, low: { shape: 'lr24' as const, fc: 100 }, high: { shape: 'lr24' as const, fc: 100 }, subGain: 0, subInvert: false };
    const s = idealSum(d, freqs);
    expect(xoverCurve(d.low, 'lp', [100]).db[0]).toBeCloseTo(-6.02, 1);
    expect(xoverCurve(d.high, 'hp', [100]).db[0]).toBeCloseTo(-6.02, 1);
    for (const v of s.sum) expect(Math.abs(v)).toBeLessThan(0.05);
    // 24 dB per octave well past the corner
    expect(at(s.low, 400) - at(s.low, 800)).toBeCloseTo(24, 0);
  });
  it('Butterworth parts are −3 dB at the corner; 12 dB/oct needs one part inverted', () => {
    const c = xoverCurve({ shape: 'bw24', fc: 80 }, 'hp', [80]);
    expect(c.db[0]).toBeCloseTo(-3.01, 1);
    const lr12 = { on: true, low: { shape: 'lr12' as const, fc: 100 }, high: { shape: 'lr12' as const, fc: 100 }, subGain: 0, subInvert: false };
    expect(at(idealSum(lr12, freqs).sum, 100)).toBeLessThan(-20);
    expect(Math.abs(at(idealSum({ ...lr12, subInvert: true }, freqs).sum, 100))).toBeLessThan(0.1);
  });
  it('a virtual crossover on measured parts aligns to a flat sum', () => {
    // Two flat full-range "measurements"; the sub arrives 2 ms late
    const flat = (delayMs: number) => ({ freqs, mag: new Float64Array(freqs.length), phase: Float64Array.from(freqs, (f) => -360 * f * delayMs * 1e-3), delayMs: 0 });
    const main = applyXover(flat(0), { shape: 'lr24', fc: 90 }, 'hp');
    const sub = applyXover(flat(2), { shape: 'lr24', fc: 90 }, 'lp');
    const r = alignSubMain(main, sub, { rangeMs: 10 });
    expect(r.delayMs).toBeCloseTo(-2, 1);
    expect(r.polarity).toBe(1);
    expect(r.after).toBeGreaterThan(0.99);
  });
});

describe('Console EQ profiles', () => {
  it('convert between Q and octaves as consoles define them', async () => {
    const { qToOctaves, octavesToQ } = await import('../src/dsp/console-eq');
    expect(qToOctaves(1.414)).toBeCloseTo(1, 2);
    expect(octavesToQ(1)).toBeCloseTo(1.414, 2);
    expect(qToOctaves(octavesToQ(1 / 9))).toBeCloseTo(1 / 9, 4);
  });
  it('fit filters into a console’s ranges and precision', async () => {
    const { fitToProfile, profileById, consoleText } = await import('../src/dsp/console-eq');
    const ah = profileById('ah-dlive');
    const f = fitToProfile({ type: 'peak', f: 63.37, gain: -21.26, q: 30 }, ah);
    expect(f).toEqual({ type: 'peak', f: 63, gain: -15, q: 13 });
    const y = profileById('yamaha-cl');
    const text = consoleText([{ type: 'peak', f: 2512, gain: -3.04, q: 4.26 }, { type: 'peak', f: 80, gain: -6, q: 2 }], y);
    expect(text.split('\n')).toEqual(['Yamaha CL / QL – Mix / matrix / stereo EQ, 4 bands', 'LOW: bell, 80 Hz, -6.0 dB, Q 2.0', 'LOW-MID: bell, 2.51 kHz, -3.0 dB, Q 4.3']);
    expect(consoleText([{ type: 'peak', f: 1000, gain: 2, q: 1.414 }], ah)).toContain('LF: bell, 1.00 kHz, +2.0 dB, 1.00 oct');
  });
  it('the assistant keeps to a console’s bands and Q range', async () => {
    const { autoEq, TARGETS } = await import('../src/dsp/eq');
    const { logGrid } = await import('../src/dsp/freq');
    const g = logGrid(20, 20000, 24);
    // A response with many narrow bumps
    const mag = Array.from(g, (f) => 6 * Math.sin(Math.log2(f) * 5));
    const r = autoEq(g, mag, null, TARGETS[0], { fMin: 40, fMax: 12000, maxFilters: 4, maxBoost: 3, maxCut: 12, minCoherence: 0, qMin: 0.92, qMax: 13 });
    expect(r.filters.length).toBeLessThanOrEqual(4);
    for (const f of r.filters) expect(f.q >= 0.92 && f.q <= 13).toBe(true);
  });
});
