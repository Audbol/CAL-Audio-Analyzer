// Loudness to ITU-R BS.1770-4 / EBU R128, checked with the EBU Tech 3341 reference cases.
import { describe, expect, it } from 'vitest';
import { LoudnessMeter, kWeighting } from '../src/dsp/loudness';

const FS = 48000;
const sine = (seconds: number, dbfs: number, f = 1000, fs = FS, phase = 0) =>
  Float32Array.from({ length: Math.round(seconds * fs) }, (_, i) => Math.pow(10, dbfs / 20) * Math.sin((2 * Math.PI * f * i) / fs + phase));

function measure(parts: Float32Array[], stereo = true, fs = FS): ReturnType<LoudnessMeter['reading']> {
  const m = new LoudnessMeter(fs);
  for (const p of parts) for (let i = 0; i < p.length; i += 1024) {
    const b = p.subarray(i, i + 1024);
    m.process(stereo ? [b, b] : [b]);
  }
  return m.reading();
}

describe('loudness (BS.1770 / EBU R128)', () => {
  it('K-weighting matches the standard coefficients at 48 kHz', () => {
    const [shelf, hp] = kWeighting(48000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 6);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6);
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 6);
    expect(hp.a2).toBeCloseTo(0.99007225036621, 6);
  });

  it('a stereo 1 kHz sine at −23 dBFS reads −23 LUFS (Tech 3341 case 1)', () => {
    const r = measure([sine(20, -23)]);
    expect(r.momentary).toBeCloseTo(-23, 1);
    expect(r.shortTerm).toBeCloseTo(-23, 1);
    expect(r.integrated).toBeCloseTo(-23, 1);
  });

  it('a mono sine reads 3 dB lower, at any sample rate', () => {
    expect(measure([sine(10, -23)], false).integrated).toBeCloseTo(-26, 1);
    expect(measure([sine(10, -23, 1000, 44100)], false, 44100).integrated).toBeCloseTo(-26, 1);
    expect(measure([sine(10, -23, 1000, 96000)], false, 96000).integrated).toBeCloseTo(-26, 1);
  });

  it('gates quiet passages out of the integrated loudness (Tech 3341 case 3)', () => {
    // −36, −23, −36 dBFS for 10, 60 and 10 s: integrated −23 LUFS
    const r = measure([sine(10, -36), sine(60, -23), sine(10, -36)]);
    expect(r.integrated).toBeGreaterThan(-23.1);
    expect(r.integrated).toBeLessThan(-22.9);
    // Absolute gate: silence doesn't count
    const s = measure([sine(20, -23), new Float32Array(FS * 20)]);
    expect(s.integrated).toBeCloseTo(-23, 1);
  });

  it('measures the loudness range (Tech 3342: −20 then −30 dBFS → 10 LU)', () => {
    const r = measure([sine(20, -20), sine(20, -30)]);
    expect(r.range).toBeGreaterThan(9);
    expect(r.range).toBeLessThan(11);
  });

  it('finds the true peak between samples', () => {
    // fs/4 at 45°: every sample is at ±0.707, the waveform peaks at 1.0 (0 dBTP) between them
    const x = sine(2, 0, FS / 4, FS, Math.PI / 4);
    let sp = 0;
    for (const v of x) sp = Math.max(sp, Math.abs(v));
    expect(20 * Math.log10(sp)).toBeCloseTo(-3, 0);
    const r = measure([x], false);
    expect(r.truePeak).toBeGreaterThan(-0.6);
    expect(r.truePeak).toBeLessThan(0.3);
  });
});
