import { describe, expect, it } from 'vitest';
import { FFT } from '../src/dsp/fft';
import { weightingDb, WeightingFilter } from '../src/dsp/weighting';
import { RingBuffer } from '../src/dsp/ring';
import { SpectrumAnalyzer } from '../src/dsp/spectrum';
import { TransferFunction } from '../src/dsp/transfer';
import { logGrid, interp, bandCentres, gridPpo, regroupBands } from '../src/dsp/freq';
import { findDelay } from '../src/dsp/delay';
import { logSweep, deconvolve, harmonicDistortion, linearIR } from '../src/dsp/sweep';
import { analyseIR, roomModes } from '../src/dsp/acoustics';
import { filterDb, autoEq, TARGETS, eqResponse } from '../src/dsp/eq';
import { parseMicCal, calCorrection } from '../src/dsp/calibration';
import { SplMeter } from '../src/dsp/spl';
import { PinkNoise } from '../src/audio/noise';

const FS = 48000;

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const n = 64;
    const r = rng(3);
    const x = Array.from({ length: n }, r);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    FFT.get(n).forward(re, im);
    for (const k of [0, 1, 5, 31, 32, 63]) {
      let sr = 0,
        si = 0;
      for (let t = 0; t < n; t++) {
        sr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
        si -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
  });

  it('round-trips through the inverse', () => {
    const n = 1024;
    const r = rng(9);
    const x = Float64Array.from({ length: n }, r);
    const re = x.slice();
    const im = new Float64Array(n);
    const f = FFT.get(n);
    f.forward(re, im);
    f.inverse(re, im);
    for (let i = 0; i < n; i += 97) expect(re[i]).toBeCloseTo(x[i], 10);
  });
});

describe('weighting', () => {
  it('matches IEC 61672 table values', () => {
    expect(weightingDb('A', 1000)).toBeCloseTo(0, 1);
    expect(weightingDb('A', 100)).toBeCloseTo(-19.1, 1);
    expect(weightingDb('A', 10000)).toBeCloseTo(-2.5, 1);
    expect(weightingDb('C', 31.5)).toBeCloseTo(-3.0, 1);
    expect(weightingDb('C', 1000)).toBeCloseTo(0, 1);
  });

  it('digital filter tracks the analytic curve', () => {
    for (const w of ['A', 'C'] as const) {
      const filt = new WeightingFilter(w, FS);
      for (const f of [31.5, 63, 125, 250, 1000, 4000, 8000]) {
        expect(Math.abs(20 * Math.log10(filt.magnitudeAt(f)) - weightingDb(w, f))).toBeLessThan(0.6);
      }
    }
  });
});

describe('SPL meter', () => {
  it('reads a full-scale 1 kHz sine as 0 dB (A-weighted)', () => {
    const m = new SplMeter(FS, 'A');
    const blk = new Float32Array(1024);
    let ph = 0;
    for (let b = 0; b < 400; b++) {
      for (let i = 0; i < blk.length; i++) blk[i] = Math.sin((ph += (2 * Math.PI * 1000) / FS));
      m.process(blk);
    }
    const r = m.read('slow');
    expect(r.slow).toBeCloseTo(0, 0);
    expect(r.leq).toBeCloseTo(0, 0);
    expect(r.peak).toBeCloseTo(0, 1);
  });
});

describe('spectrum analyzer', () => {
  it('reads a sine at its dBFS level in bands and narrowband', () => {
    const grid = logGrid(20, 20000, 48);
    const sa = new SpectrumAnalyzer(FS, 8192, grid);
    const ring = new RingBuffer(1 << 16);
    const f0 = (171 * FS) / 8192; // bin-centred ≈ 1002 Hz
    const x = Float32Array.from({ length: 40000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f0 * i) / FS));
    ring.push(x);
    sa.process(ring, 100);
    const out = new Float64Array(grid.length);
    sa.render(3, 'avg', out);
    const at = interp(grid, out, f0);
    expect(at).toBeCloseTo(-6.02, 0);
    sa.render(0, 'avg', out);
    let peak = -Infinity;
    for (const v of out) peak = Math.max(peak, v);
    expect(peak).toBeCloseTo(-6.02, 0);
  });

  it('shows pink noise as roughly flat in 1/3 octave bands', () => {
    const grid = logGrid(20, 20000, 24);
    const sa = new SpectrumAnalyzer(FS, 16384, grid);
    sa.averaging = 0;
    const ring = new RingBuffer(1 << 20);
    const pink = new PinkNoise(5);
    const buf = new Float32Array(FS * 8);
    for (let i = 0; i < buf.length; i++) buf[i] = pink.next() * 0.1;
    for (let i = 0; i < buf.length; i += 4096) {
      ring.push(buf.subarray(i, i + 4096));
      sa.process(ring, 1000);
    }
    const out = new Float64Array(grid.length);
    sa.render(3, 'avg', out);
    const l100 = interp(grid, out, 100);
    const l1k = interp(grid, out, 1000);
    const l10k = interp(grid, out, 10000);
    expect(Math.abs(l100 - l1k)).toBeLessThan(1.5);
    expect(Math.abs(l10k - l1k)).toBeLessThan(1.5);
  });
});

describe('transfer function', () => {
  it('recovers gain, delay-compensated phase and coherence', () => {
    const grid = logGrid(20, 20000, 24);
    const tf = new TransferFunction(FS, grid);
    tf.delay = 100;
    const ref = new RingBuffer(1 << 18);
    const mic = new RingBuffer(1 << 18);
    const r = rng(7);
    const n = FS * 3;
    const x = Float32Array.from({ length: n }, r);
    const y = new Float32Array(n);
    for (let i = 100; i < n; i++) y[i] = 0.5 * x[i - 100];
    for (let i = 0; i < n; i += 4096) {
      ref.push(x.subarray(i, i + 4096));
      mic.push(y.subarray(i, i + 4096));
      tf.process(ref, mic, 1000);
    }
    const res = tf.result(12);
    for (const f of [50, 200, 1000, 5000, 15000]) {
      const i = grid.findIndex((g) => g >= f);
      expect(res.mag[i]).toBeCloseTo(-6.02, 1);
      expect(Math.abs(res.phase[i])).toBeLessThan(2);
      expect(res.coh[i]).toBeGreaterThan(0.99);
    }
  });
});

describe('delay finder', () => {
  it('finds a delay and polarity through a filtered path', () => {
    const r = rng(11);
    const n = 32768;
    const x = Float64Array.from({ length: n }, r);
    const y = new Float64Array(n);
    const d = 1234;
    let lp = 0;
    for (let i = d; i < n; i++) {
      lp = 0.7 * lp + 0.3 * x[i - d];
      y[i] = -0.8 * lp + 0.01 * r();
    }
    const est = findDelay(x, y, FS);
    expect(Math.abs(est.fractional - d)).toBeLessThan(2);
    expect(est.polarityInverted).toBe(true);
    expect(est.confidenceDb).toBeGreaterThan(20);
  });
});

describe('log sweep', () => {
  const spec = { fs: FS, f1: 20, f2: 20000, duration: 2, amplitude: 0.5 };
  const sweep = logSweep(spec);

  it('deconvolves an ideal delayed system into a flat response', () => {
    const lat = 500;
    const rec = new Float32Array(sweep.length + FS);
    for (let i = 0; i < sweep.length; i++) rec[i + lat] = 0.25 * sweep[i];
    const d = deconvolve(rec, sweep, spec);
    expect(d.peak).toBe(lat);
    const { ir } = linearIR(d, 5, 0.5);
    let sumSq = 0;
    for (const v of ir) sumSq += v * v;
    expect(Math.sqrt(sumSq)).toBeGreaterThan(0.2);
  });

  it('measures harmonic distortion (Farina)', () => {
    const rec = new Float32Array(sweep.length + FS);
    for (let i = 0; i < sweep.length; i++) {
      const x = sweep[i];
      rec[i] = x + 0.2 * x * x; // 2nd harmonic amplitude = 0.1*A = 5% at A=0.5
    }
    const d = deconvolve(rec, sweep, spec);
    const grid = logGrid(100, 5000, 12);
    const hd = harmonicDistortion(d, spec, grid, 3);
    const thd1k = interp(grid, hd.thd, 1000);
    expect(thd1k).toBeGreaterThan(3.5);
    expect(thd1k).toBeLessThan(6.5);
  });
});

describe('room acoustics', () => {
  it('estimates RT60 from a synthetic exponential decay', () => {
    const rt = 0.8;
    const r = rng(21);
    const n = FS * 2;
    const ir = new Float64Array(n);
    const k = Math.log(10 ** 3) / rt; // amplitude decays 60 dB in rt
    for (let i = 0; i < n; i++) ir[i] = r() * Math.exp((-k * i) / FS) + r() * 1e-5;
    ir[0] = 1;
    const res = analyseIR(ir, FS);
    expect(res.t30.rt).toBeGreaterThan(rt * 0.9);
    expect(res.t30.rt).toBeLessThan(rt * 1.1);
    expect(res.t20.rt).toBeGreaterThan(rt * 0.9);
    expect(res.t20.rt).toBeLessThan(rt * 1.1);
  });

  it('is robust to a silent gap between direct sound and reverberant tail', () => {
    const rt = 0.6;
    const r = rng(33);
    const n = FS * 2;
    const ir = new Float64Array(n);
    const k = Math.log(10 ** 3) / rt;
    const gap = Math.round(0.05 * FS);
    ir[0] = 1;
    for (let i = gap; i < n; i++) ir[i] = 0.05 * r() * Math.exp((-k * i) / FS) + r() * 1e-7;
    const res = analyseIR(ir, FS);
    expect(res.t30.rt).toBeGreaterThan(rt * 0.85);
    expect(res.t30.rt).toBeLessThan(rt * 1.15);
  });

  it('computes axial modes of a room', () => {
    const modes = roomModes(5, 4, 3, 343, 100);
    expect(modes[0].f).toBeCloseTo(34.3, 1);
    expect(modes[0].kind).toBe('axial');
  });

  it('generates IEC band centres', () => {
    const c = bandCentres(1, 20, 20000);
    expect(c.length).toBe(10);
    expect(c[5]).toBeCloseTo(1000, 0);
  });
});

describe('EQ', () => {
  it('peaking filter reaches its gain at centre', () => {
    expect(filterDb({ type: 'peak', f: 1000, gain: -6, q: 2 }, 1000)).toBeCloseTo(-6, 5);
    expect(Math.abs(filterDb({ type: 'peak', f: 1000, gain: -6, q: 2 }, 20000))).toBeLessThan(0.1);
  });

  it('auto EQ reduces a resonance', () => {
    const grid = logGrid(20, 20000, 24);
    const bump = { type: 'peak' as const, f: 120, gain: 9, q: 4 };
    const mag = eqResponse([bump], grid);
    const res = autoEq(grid, mag, null, TARGETS[0], {
      fMin: 30,
      fMax: 16000,
      maxFilters: 4,
      maxBoost: 3,
      maxCut: 12,
      minCoherence: 0,
    });
    expect(res.filters.length).toBeGreaterThan(0);
    expect(res.rmsAfter).toBeLessThan(res.rmsBefore * 0.4);
    expect(Math.abs(res.filters[0].f - 120)).toBeLessThan(15);
  });
});

describe('mic calibration', () => {
  it('parses a quoted-sensitivity calibration file', () => {
    const cal = parseMicCal(`"Sens Factor =-1.2dB, SERNO: 7000000"\n20 -2.0\n1000 0.0\n20000 3.0\n`);
    expect(cal.sensitivity).toBeCloseTo(-1.2);
    expect(cal.freqs).toEqual([20, 1000, 20000]);
    expect(calCorrection(cal, 20000)).toBeCloseTo(-3);
  });
});

describe('host-processed band regrouping', () => {
  it('combines 1/48-octave band levels into flat 1/3-octave levels for pink noise', () => {
    const grid = logGrid(20, 20000, 48);
    const ppo = gridPpo(grid);
    expect(ppo).toBeGreaterThan(47.9);
    // Pink noise: equal power per 1/48 octave band
    const fine = new Float64Array(grid.length).fill(-40);
    const out = regroupBands(fine, ppo, 3, new Float64Array(grid.length));
    const mid = out.slice(50, grid.length - 50);
    for (const v of mid) expect(v).toBeCloseTo(-40 + 10 * Math.log10(ppo / 3), 1);
    // The ends are compensated for the part of the band outside the grid
    expect(out[0]).toBeCloseTo(mid[0], 1);
  });
});
