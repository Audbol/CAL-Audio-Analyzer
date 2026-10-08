import { describe, expect, it } from 'vitest';
import { FFT } from '../src/dsp/fft';
import { weightingDb, WeightingFilter } from '../src/dsp/weighting';
import { RingBuffer } from '../src/dsp/ring';
import { SpectrumAnalyzer, MultiSpectrum } from '../src/dsp/spectrum';
import { DecimatedRing, decimationFactor } from '../src/dsp/decimate';
import { TransferFunction } from '../src/dsp/transfer';
import { logGrid, interp, bandCentres, gridPpo, regroupBands, sampleLogGrid } from '../src/dsp/freq';
import { findDelay } from '../src/dsp/delay';
import { logSweep, deconvolve, harmonicDistortion, linearIR } from '../src/dsp/sweep';
import { analyseIR, roomModes } from '../src/dsp/acoustics';
import { filterDb, autoEq, TARGETS, eqResponse, customCurve, setCustomTargets, findTarget, allTargets } from '../src/dsp/eq';
import { parseTargetText } from '../src/ui/target-editor';
import { parseMicCal, calCorrection } from '../src/dsp/calibration';
import { SplMeter } from '../src/dsp/spl';
import { PinkNoise } from '../src/audio/noise';
import { alignSubMain, alignFullRange } from '../src/dsp/align';
import { targetShape, targetLevel, targetDeviation } from '../src/dsp/target';
import { Biquad } from '../src/audio/biquad';
import { groupDelayMs, smoothGroupDelay } from '../src/dsp/groupdelay';
import { compareCurves } from '../src/dsp/compare';

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

  it('matches a direct DFT for every size (radix-2 and radix-4 pass layouts), complex and real input', () => {
    for (const n of [2, 4, 8, 16, 32, 128, 256, 2048]) {
      const r = rng(n);
      const x = Array.from({ length: n }, r);
      const y = Array.from({ length: n }, r);
      const re = Float64Array.from(x);
      const im = Float64Array.from(y);
      FFT.get(n).forward(re, im);
      const rr = new Float64Array(n / 2 + 1);
      const ri = new Float64Array(n / 2 + 1);
      FFT.get(n).forwardReal(x, rr, ri);
      for (let k = 0; k < n; k += Math.max(1, n >> 4)) {
        let sr = 0, si = 0, xr = 0, xi = 0;
        for (let t = 0; t < n; t++) {
          const c = Math.cos((2 * Math.PI * k * t) / n);
          const s = Math.sin((2 * Math.PI * k * t) / n);
          sr += x[t] * c + y[t] * s;
          si += y[t] * c - x[t] * s;
          xr += x[t] * c;
          xi -= x[t] * s;
        }
        expect(re[k]).toBeCloseTo(sr, 9);
        expect(im[k]).toBeCloseTo(si, 9);
        if (k <= n / 2) {
          expect(rr[k]).toBeCloseTo(xr, 9);
          expect(ri[k]).toBeCloseTo(xi, 9);
        }
      }
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

  it('follows a level change at once with averaging set to None', () => {
    const grid = logGrid(20, 20000, 48);
    const sa = new SpectrumAnalyzer(FS, 8192, grid, 1024);
    sa.averaging = 1;
    const ring = new RingBuffer(1 << 17);
    const f0 = (171 * FS) / 8192;
    const tone = (amp: number, n: number, from: number) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f0 * (i + from)) / FS));
    ring.push(tone(0.5, 40000, 0));
    sa.process(ring, 100);
    // 20 dB quieter: the very next frame that holds only the new level reads it
    ring.push(tone(0.05, 8192, 40000));
    sa.process(ring, 100);
    const out = new Float64Array(grid.length);
    sa.render(3, 'avg', out);
    expect(interp(grid, out, f0)).toBeCloseTo(-26.02, 0);
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

describe('decimated rings', () => {
  it('keep up with the input when the reference is delayed (no extra latency)', () => {
    const d = decimationFactor(FS);
    const src = new RingBuffer(1 << 18);
    const plain = new DecimatedRing(FS, d);
    const delayed = new DecimatedRing(FS, d, Math.round(FS * 0.1)); // 100 ms reference delay
    const block = new Float32Array(1024).fill(0.1);
    for (let i = 0; i < 200; i++) {
      src.push(block);
      plain.update(src);
      delayed.update(src);
    }
    // The delayed copy reads older input, so it is complete at least as far as the undelayed one
    expect(delayed.ring.written).toBeGreaterThanOrEqual(plain.ring.written);
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

  it('reports the measurement floor: distortion below it is noise', () => {
    const grid = logGrid(100, 5000, 12);
    // Clean and distorted: the floor is far below the 5 % that is there
    const rec = new Float32Array(sweep.length + FS);
    for (let i = 0; i < sweep.length; i++) rec[i] = sweep[i] + 0.2 * sweep[i] * sweep[i];
    const hd = harmonicDistortion(deconvolve(rec, sweep, spec), spec, grid, 3);
    expect(interp(grid, hd.floor, 1000)).toBeLessThan(0.5);
    // A linear system in noise: no distortion, so the THD found is the noise, at about the floor
    const r = rng(5);
    const noisy = new Float32Array(sweep.length + FS);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i < sweep.length ? sweep[i] : 0) + 0.003 * r();
    const hn = harmonicDistortion(deconvolve(noisy, sweep, spec), spec, grid, 3);
    const f1k = interp(grid, hn.floor, 1000);
    const t1k = interp(grid, hn.thd, 1000);
    expect(f1k).toBeGreaterThan(0.01);
    expect(t1k).toBeLessThan(f1k * 4);
  });

  it('measures the floor away from the harmonics on a narrow sweep (20–200 Hz: the 5th arrives at 70 %)', () => {
    const narrow = { fs: FS, duration: 2, f1: 20, f2: 200, amplitude: 0.5 };
    const sw = logSweep(narrow);
    // A strongly distorting sub (5th harmonic 10 %), no noise: the floor must stay far below the distortion
    const rec = new Float32Array(sw.length + FS);
    for (let i = 0; i < sw.length; i++) {
      const x = sw[i] / 0.5;
      rec[i] = 0.5 * (x + 0.1 * (16 * x ** 5 - 20 * x ** 3 + 5 * x));
    }
    const grid = logGrid(20, 40, 12);
    const hd = harmonicDistortion(deconvolve(rec, sw, narrow), narrow, grid, 5);
    const t = interp(grid, hd.thd, 30);
    const fl = interp(grid, hd.floor, 30);
    expect(t).toBeGreaterThan(5);
    // (Before: the floor read the 5th harmonic itself, 12 %; a little of a low sweep's long ringing remains)
    expect(fl).toBeLessThan(t / 5);
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

  it('does not take a room dip at the edge of the range for the loudspeaker’s roll-off', () => {
    const grid = logGrid(20, 20000, 24);
    // A full-range system with a deep dip around 50 Hz that recovers above it (e.g. a boundary cancellation)
    const room = eqResponse([{ type: 'peak', f: 52, gain: -14, q: 1.4 }], grid);
    const flat = TARGETS.find((t) => t.id === 'flat')!;
    const res = autoEq(grid, Array.from(room), null, flat, { fMin: 40, fMax: 12000, maxFilters: 4, maxBoost: 6, maxCut: 12, minCoherence: 0 });
    expect(res.rolloff.low).toBeNull();
    // A real roll-off is still found from the same edge
    const hp = (f: number) => -10 * Math.log10(1 + Math.pow(70 / f, 8));
    const res2 = autoEq(grid, Array.from(grid, hp), null, flat, { fMin: 40, fMax: 12000, maxFilters: 4, maxBoost: 6, maxCut: 12, minCoherence: 0 });
    expect(res2.rolloff.low).not.toBeNull();
  });

  it('leaves a loudspeaker roll-off alone and never stacks filters past the boost limit', () => {
    const grid = logGrid(20, 20000, 24);
    // A system that rolls off below ~50 Hz (4th-order high-pass), a room peak at 120 Hz and two dips
    const hp = (f: number) => -10 * Math.log10(1 + Math.pow(50 / f, 8));
    const room = eqResponse([{ type: 'peak', f: 120, gain: 7, q: 4 }, { type: 'peak', f: 250, gain: -4, q: 2 }, { type: 'peak', f: 900, gain: -4, q: 1.5 }], grid);
    const mag = Array.from(grid, (f, i) => hp(f) + room[i]);
    const house = TARGETS.find((t) => t.id === 'house')!;
    const opt = { fMin: 35, fMax: 12000, maxFilters: 8, maxBoost: 6, maxCut: 12, minCoherence: 0 };
    const res = autoEq(grid, mag, null, house, opt);
    // The roll-off is found and nothing is placed in it
    expect(res.rolloff.low).not.toBeNull();
    expect(res.rolloff.low!).toBeGreaterThan(38);
    expect(res.rolloff.low!).toBeLessThan(60);
    for (const f of res.filters) expect(f.f).toBeGreaterThanOrEqual(res.rolloff.low! - 1);
    // All the filters together stay within the boost and cut limits everywhere
    const eq = eqResponse(res.filters, grid);
    for (let i = 0; i < grid.length; i++) if (grid[i] >= 20 && grid[i] <= 20000) expect(eq[i]).toBeLessThanOrEqual(opt.maxBoost + 0.15);
    // No two boosts (or two cuts) on top of each other
    for (const a of res.filters) for (const b of res.filters) if (a !== b && Math.sign(a.gain) === Math.sign(b.gain)) expect(Math.abs(Math.log2(a.f / b.f))).toBeGreaterThanOrEqual(1 / 3 - 0.01);
    // And the room peak is still cut
    expect(res.filters.some((f) => f.gain < -3 && Math.abs(Math.log2(f.f / 120)) < 0.2)).toBe(true);
  });

  it('target curves have the shapes their names promise', () => {
    const t = (id: string) => TARGETS.find((x) => x.id === id)!.at;
    expect(new Set(TARGETS.map((x) => x.id)).size).toBe(TARGETS.length);
    for (const x of TARGETS) for (const f of [20, 100, 1000, 10000, 20000]) expect(Number.isFinite(x.at(f))).toBe(true);
    // Shelves reach their gain in the deep bass, half of it at the corner, and leave the midrange at 0 dB
    expect(t('live-rock')(25)).toBeCloseTo(6, 0);
    expect(t('live-rock')(100)).toBeCloseTo(3, 1);
    expect(Math.abs(t('live-rock')(1000))).toBeLessThan(0.2);
    expect(t('live-rock')(16000)).toBeCloseTo(-3, 1);
    expect(t('live-club')(30)).toBeGreaterThan(9);
    expect(t('preferred-room')(20)).toBeCloseTo(6.6, 0);
    expect(t('preferred-room')(18000)).toBeCloseTo(-2.4, 0);
    // Speech: rolled off in the bass, a little presence lift
    expect(t('speech')(50)).toBeLessThan(-10);
    expect(t('speech')(3000)).toBeCloseTo(2, 1);
    expect(t('room-1974')(400)).toBe(0);
    expect(t('room-1974')(1600)).toBeCloseTo(-2, 6);
    expect(t('cinema-small')(8000)).toBeCloseTo(-3, 6);
  });

  it('uses a high-pass where the target rolls off in the bass, without spending an EQ band', () => {
    const grid = logGrid(20, 20000, 24);
    // A full-range system, flat to 30 Hz, with a room peak at 250 Hz
    const mag = Array.from(eqResponse([{ type: 'peak', f: 250, gain: 6, q: 3 }], grid));
    const speech = TARGETS.find((t) => t.id === 'speech')!;
    const res = autoEq(grid, mag, null, speech, { fMin: 30, fMax: 12000, maxFilters: 4, maxBoost: 3, maxCut: 12, minCoherence: 0, hpfSlopes: [12, 24] });
    const hp = res.filters.filter((f) => f.type === 'highpass');
    expect(hp.length).toBe(1);
    expect(hp[0].f).toBeGreaterThan(50);
    expect(hp[0].f).toBeLessThan(200);
    expect(res.filters[0].type).toBe('highpass');
    // The four bands are still there for the rest (the room peak is cut)
    expect(res.filters.filter((f) => f.type !== 'highpass').length).toBeLessThanOrEqual(4);
    expect(res.filters.some((f) => f.gain < -3 && Math.abs(Math.log2(f.f / 250)) < 0.3)).toBe(true);
    // A high-pass's response: -3 dB at its corner, its slope well below
    expect(filterDb({ type: 'highpass', f: 100, gain: 0, q: 0.707, slope: 24 }, 100)).toBeCloseTo(-3.01, 1);
    expect(filterDb({ type: 'highpass', f: 100, gain: 0, q: 0.707, slope: 24 }, 25)).toBeCloseTo(-48, 0);
    // Not with a flat target, and not when switched off
    expect(autoEq(grid, mag, null, TARGETS[0], { fMin: 30, fMax: 12000, maxFilters: 4, maxBoost: 3, maxCut: 12, minCoherence: 0, hpfSlopes: [12, 24] }).filters.some((f) => f.type === 'highpass')).toBe(false);
    expect(autoEq(grid, mag, null, speech, { fMin: 30, fMax: 12000, maxFilters: 4, maxBoost: 3, maxCut: 12, minCoherence: 0 }).filters.some((f) => f.type === 'highpass')).toBe(false);
  });

  it('custom targets join their points smoothly and hold their level beyond the ends', () => {
    const c = customCurve({ id: 'x', name: 'Mine', points: [[100, 6], [1000, 0], [10000, -4]] });
    expect(c.id).toBe('custom:x');
    expect(c.at(20)).toBe(6);
    expect(c.at(100)).toBe(6);
    expect(c.at(Math.sqrt(100 * 1000))).toBeCloseTo(3, 6);
    expect(c.at(20000)).toBe(-4);
    setCustomTargets([{ id: 'x', name: 'Mine', points: [[100, 6], [1000, 0]] }]);
    expect(findTarget('custom:x')?.label).toBe('Mine');
    expect(allTargets().length).toBe(TARGETS.length + 1);
    setCustomTargets([]);
    expect(findTarget('custom:x')).toBeUndefined();
    expect(parseTargetText('# my curve\nHz,dB\n20, 4\n1000\t0\n20000 -3\n')).toEqual([[20, 4], [1000, 0], [20000, -3]]);
  });

  it('still cuts a peak when a bigger dip cannot be boosted', () => {
    const grid = logGrid(20, 20000, 24);
    const mag = eqResponse([{ type: 'peak', f: 200, gain: -10, q: 3 }, { type: 'peak', f: 2000, gain: 4, q: 3 }], grid);
    const res = autoEq(grid, mag, null, TARGETS[0], { fMin: 30, fMax: 16000, maxFilters: 4, maxBoost: 0, maxCut: 12, minCoherence: 0 });
    expect(res.filters.length).toBeGreaterThan(0);
    expect(res.filters.every((f) => f.gain < 0)).toBe(true);
    expect(res.filters.some((f) => Math.abs(Math.log2(f.f / 2000)) < 0.25)).toBe(true);
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

describe('low-frequency resolution (decimated bass windows)', () => {
  const feed = (rings: RingBuffer[], sigs: Float32Array[], step: (i: number) => void) => {
    for (let i = 0; i < sigs[0].length; i += 1024) {
      rings.forEach((r, k) => r.push(sigs[k].subarray(i, i + 1024)));
      step(i);
    }
  };

  it('decimates without changing bass levels and without aliasing into the bass', () => {
    const d = decimationFactor(FS);
    expect(FS / d).toBeGreaterThanOrEqual(2400);
    const level = (f: number) => {
      const src = new RingBuffer(1 << 18);
      const dec = new DecimatedRing(FS, d);
      const x = Float32Array.from({ length: FS * 2 }, (_, i) => Math.sin((2 * Math.PI * f * i) / FS));
      feed([src], [x], () => dec.update(src));
      const out = new Float64Array(1024);
      dec.ring.read(dec.ring.written - 1024, 1024, out);
      return 20 * Math.log10(Math.max(...out.map(Math.abs)));
    };
    for (const f of [20, 63, 160, 350]) expect(Math.abs(level(f))).toBeLessThan(0.05);
    // A tone just below the decimated sample rate would fold down to ~100 Hz
    expect(level(FS / d - 100)).toBeLessThan(-70);
  });

  it('separates tones 2 Hz apart at 40 Hz only with the long bass windows', () => {
    const grid = logGrid(20, 20000, 48);
    const x = Float32Array.from({ length: FS * 8 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 40 * i) / FS) + 0.5 * Math.sin((2 * Math.PI * 42 * i) / FS));
    const dip = (lf: 'standard' | 'high' | 'max') => {
      const ms = new MultiSpectrum(FS, 16384, grid, lf);
      ms.averaging = 0;
      const ring = new RingBuffer(1 << 20);
      feed([ring], [x], () => ms.process(ring));
      const out = new Float64Array(grid.length);
      ms.render(0, 'avg', out);
      // Narrowband display: deepest point between the tones relative to the tone peaks
      let peak = -Infinity;
      let mid = Infinity;
      grid.forEach((g, i) => {
        if (g >= 39.8 && g <= 42.2) peak = Math.max(peak, out[i]);
        if (g > 40.2 && g < 41.8) mid = Math.min(mid, out[i]);
      });
      return { dip: peak - mid, peak };
    };
    expect(dip('standard').dip).toBeLessThan(1); // one merged hump
    expect(dip('high').dip).toBeGreaterThan(6); // two separate tones
    const max = dip('max');
    expect(max.dip).toBeGreaterThan(15);
    expect(max.peak).toBeGreaterThan(-8); // each tone still reads close to its −6 dBFS level
  });

  it('keeps band levels continuous where the long windows take over', () => {
    const grid = logGrid(20, 20000, 48);
    const ms = new MultiSpectrum(FS, 16384, grid, 'high');
    ms.averaging = 0;
    const ring = new RingBuffer(1 << 20);
    const pink = new PinkNoise(9);
    const x = Float32Array.from({ length: FS * 12 }, () => pink.next() * 0.1);
    feed([ring], [x], () => ms.process(ring));
    const out = new Float64Array(grid.length);
    ms.render(3, 'avg', out);
    const at = (f: number) => sampleLogGrid(grid, out, f);
    expect(Math.abs(at(150) - at(170))).toBeLessThan(1); // across the 160 Hz handover
    expect(Math.abs(at(63) - at(1000))).toBeLessThan(1.5); // pink noise still reads flat
  });

  it('keeps the transfer function exact in the bass with a delay that is not a multiple of the decimation', () => {
    const grid = logGrid(20, 20000, 24);
    const tf = new TransferFunction(FS, grid);
    tf.setLfResolution('max');
    tf.delay = 1237;
    const r = rng(21);
    const n = FS * 10;
    const x = Float32Array.from({ length: n }, r);
    const y = new Float32Array(n);
    for (let i = 1237; i < n; i++) y[i] = 0.5 * x[i - 1237];
    const ref = new RingBuffer(1 << 20);
    const mic = new RingBuffer(1 << 20);
    feed([ref, mic], [x, y], () => tf.process(ref, mic, 1000));
    const res = tf.result(24);
    for (const f of [25, 40, 70, 120]) {
      const i = grid.findIndex((g) => g >= f);
      expect(res.mag[i]).toBeCloseTo(-6.02, 1);
      expect(Math.abs(res.phase[i])).toBeLessThan(2);
      expect(res.coh[i]).toBeGreaterThan(0.98);
    }
  });
});

describe('bass windows in real conditions', () => {
  it('measures a sharp low-frequency response accurately, with no steps where windows hand over', () => {
    const grid = logGrid(20, 20000, 48);
    // System: +9 dB at 40 Hz (Q 4), −12 dB at 70 Hz (Q 3), +5 dB at 140 Hz, 2 ms delay
    const mk = () => {
      const a = new Biquad('peak', 40, 4, 9, FS), b = new Biquad('peak', 70, 3, -12, FS), c = new Biquad('peak', 140, 2, 5, FS);
      const dl = new Float64Array(96);
      let p = 0;
      return (x: number) => {
        const y = c.process(b.process(a.process(x)));
        const o = dl[p];
        dl[p] = y;
        p = (p + 1) % dl.length;
        return o;
      };
    };
    // Ground truth from a long impulse response, smoothed like the analyzer (1/24 octave power)
    const n = 1 << 20;
    const sys0 = mk();
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = sys0(i === 0 ? 1 : 0);
    FFT.get(n).forward(re, im);
    const half = Math.pow(2, 1 / 48);
    const truth = (f: number) => {
      let s = 0, c = 0;
      for (let k = Math.ceil(f / half / (FS / n)); k <= Math.floor((f * half) / (FS / n)); k++) {
        s += re[k] ** 2 + im[k] ** 2;
        c++;
      }
      return 10 * Math.log10(s / c);
    };
    for (const lf of ['standard', 'high', 'max'] as const) {
      const sys = mk();
      const pink = new PinkNoise(3);
      const tf = new TransferFunction(FS, grid);
      tf.setLfResolution(lf);
      tf.delay = 96;
      const ref = new RingBuffer(1 << 21);
      const mic = new RingBuffer(1 << 21);
      const bx = new Float32Array(1024);
      const by = new Float32Array(1024);
      for (let t = 0; t < 16 * FS; t += 1024) {
        for (let i = 0; i < 1024; i++) {
          bx[i] = pink.next() * 0.2;
          by[i] = sys(bx[i]);
        }
        ref.push(bx);
        mic.push(by);
        tf.process(ref, mic);
      }
      const r = tf.result(24);
      let worst = 0;
      let sq = 0;
      let cnt = 0;
      grid.forEach((f, i) => {
        if (f < 25 || f > 250) return;
        const e = r.mag[i] - truth(f);
        worst = Math.max(worst, Math.abs(e));
        sq += e * e;
        cnt++;
      });
      // Long windows are more accurate in the bass; none of the modes may show steps or offsets
      expect(Math.sqrt(sq / cnt)).toBeLessThan(lf === 'standard' ? 0.3 : 0.15);
      expect(worst).toBeLessThan(lf === 'standard' ? 1 : 0.5);
    }
  });

  it('does not count silence from before a (re)connected stream began', () => {
    const grid = logGrid(20, 20000, 48);
    const level = (anchor: number) => {
      const ms = new MultiSpectrum(FS, 16384, grid, 'max');
      ms.averaging = 0;
      const ring = new RingBuffer(1 << 21);
      ring.anchor(anchor); // like a remote device joining a host that has been running for a while
      const pink = new PinkNoise(8);
      const b = new Float32Array(1024);
      for (let t = 0; t < 8 * FS; t += 1024) {
        for (let i = 0; i < 1024; i++) b[i] = pink.next() * 0.1;
        ring.push(b);
        ms.process(ring);
      }
      const out = new Float64Array(grid.length);
      ms.render(3, 'avg', out);
      return sampleLogGrid(grid, out, 40) - sampleLogGrid(grid, out, 1000);
    };
    // Pink noise reads flat: the bass must not be pulled down by zeros from before the anchor
    expect(Math.abs(level(123_456_789))).toBeLessThan(1);
  });
});

describe('other sample rates', () => {
  for (const fs of [44100, 96000, 192000]) {
    it(`measures correctly at ${fs / 1000} kHz with the bass windows`, () => {
      const grid = logGrid(20, 20000, 48);
      // Transfer function: −6 dB, 777-sample delay, all bass windows active
      const tf = new TransferFunction(fs, grid);
      tf.setLfResolution('max');
      tf.delay = 777;
      const ms = new MultiSpectrum(fs, 16384 * Math.max(1, Math.round(fs / 48000)), grid, 'max');
      ms.averaging = 0;
      const r = rng(5);
      const n = Math.round(fs * 7);
      const x = Float32Array.from({ length: n }, r);
      const y = new Float32Array(n);
      for (let i = 777; i < n; i++) y[i] = 0.5 * x[i - 777];
      // Sine at 50 Hz, −6 dBFS, on its own channel for the RTA
      const s = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 50 * i) / fs));
      const ref = new RingBuffer(1 << 22);
      const mic = new RingBuffer(1 << 22);
      const sin = new RingBuffer(1 << 22);
      for (let i = 0; i < n; i += 2048) {
        ref.push(x.subarray(i, i + 2048));
        mic.push(y.subarray(i, i + 2048));
        sin.push(s.subarray(i, i + 2048));
        tf.process(ref, mic, 1000);
        ms.process(sin);
      }
      const res = tf.result(24);
      for (const f of [30, 60, 150, 1000, 10000]) {
        const i = grid.findIndex((g) => g >= f);
        expect(res.mag[i]).toBeCloseTo(-6.02, 1);
        expect(Math.abs(res.phase[i])).toBeLessThan(2);
      }
      const out = new Float64Array(grid.length);
      ms.render(0, 'avg', out);
      // Narrowband peak of a −6 dBFS sine: within the Hann window's worst-case scalloping (1.42 dB) below
      const pk = Math.max(...out.filter((_, i) => grid[i] > 45 && grid[i] < 55));
      expect(pk).toBeLessThan(-6.02 + 0.2);
      expect(pk).toBeGreaterThan(-6.02 - 1.45);
    });
  }
});

describe('sub / main alignment', () => {
  const grid = Array.from(logGrid(20, 20000, 48));
  /** Linkwitz-Riley crossover sections (order 2 or 4) with a delay, as a measured TF (mag dB, phase deg). */
  const lr = (kind: 'lp' | 'hp', order: 2 | 4, fc: number, delayMs: number, gainDb = 0) => {
    const mag: number[] = [];
    const phase: number[] = [];
    for (const f of grid) {
      // s = j f / fc
      const s = { re: 0, im: f / fc };
      const mul = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
      const div = (a: { re: number; im: number }, b: { re: number; im: number }) => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; };
      // Butterworth section: order-2 LR = two 1st-order, order-4 LR = two 2nd-order Butterworth
      let h1: { re: number; im: number };
      if (order === 2) h1 = kind === 'lp' ? div({ re: 1, im: 0 }, { re: 1, im: s.im }) : div(s, { re: 1, im: s.im });
      else {
        const den = { re: 1 - s.im * s.im, im: Math.SQRT2 * s.im };
        h1 = kind === 'lp' ? div({ re: 1, im: 0 }, den) : div(mul(s, s), den);
      }
      let hh = mul(h1, h1);
      const ph = -2 * Math.PI * f * delayMs / 1000;
      hh = mul(hh, { re: Math.cos(ph), im: Math.sin(ph) });
      mag.push(20 * Math.log10(Math.hypot(hh.re, hh.im)) + gainDb);
      phase.push((Math.atan2(hh.im, hh.re) * 180) / Math.PI);
    }
    return { freqs: grid, mag, phase, delayMs: 0 };
  };

  it('finds the delay for an LR4 crossover where the sub arrives 3 ms late (delay the mains)', () => {
    const r = alignSubMain(lr('hp', 4, 90, 10), lr('lp', 4, 90, 13));
    expect(r.delayMs).toBeCloseTo(-3, 1);
    expect(r.polarity).toBe(1);
    expect(r.after).toBeGreaterThan(0.99);
    expect(r.before).toBeLessThan(r.after);
    expect(r.gainDb).toBeGreaterThan(5.5);
    expect(r.cancellations.length).toBe(0);
  });

  it('asks for inverted polarity on an LR2 crossover', () => {
    const r = alignSubMain(lr('hp', 2, 100, 5), lr('lp', 2, 100, 5));
    expect(r.polarity).toBe(-1);
    expect(Math.abs(r.delayMs)).toBeLessThan(0.1);
    expect(r.after).toBeGreaterThan(0.99);
  });

  it('uses the delay compensation each trace was captured with', () => {
    // Same acoustic situation as above, but the sub was captured with 3 ms of delay compensation set
    const sub = { ...lr('lp', 4, 90, 10), delayMs: 3 };
    const r = alignSubMain(lr('hp', 4, 90, 10), sub);
    expect(r.delayMs).toBeCloseTo(-3, 1);
  });

  it('refuses responses that do not overlap', () => {
    expect(() => alignSubMain(lr('hp', 4, 2000, 0), lr('lp', 4, 30, 0, -40))).toThrow(/overlap/);
  });
});

describe('target curves', () => {
  it('levels a target to the measurement and reports the deviation', () => {
    const grid = logGrid(20, 20000, 48);
    const shape = targetShape('house', grid)!;
    const data = Float64Array.from(shape, (v) => v - 20 + 1); // the house curve, 20 dB down, plus 1 dB
    const level = targetLevel(grid, data, shape)!;
    expect(level).toBeCloseTo(-19, 6);
    const dev = targetDeviation(grid, data, Float64Array.from(shape, (v) => v + level), 3)!;
    expect(dev.rms).toBeLessThan(1e-9);
    expect(dev.within).toBe(1);
    expect(targetShape('off', grid)).toBeNull();
  });
});

describe('full-range alignment (fills and delay speakers)', () => {
  const grid = Array.from(logGrid(20, 20000, 48));
  /** A full-range speaker (2nd-order high-pass at 80 Hz) arriving `arrivalMs` after the reference signal. */
  const speaker = (arrivalMs: number, compensatedMs: number, gainDb = 0, invert = false) => {
    const mag: number[] = [];
    const phase: number[] = [];
    for (const f of grid) {
      const w = f / 80;
      // H = s² / (s² + √2 s + 1) at s = jw
      const dre = 1 - w * w;
      const dim = Math.SQRT2 * w;
      const d = dre * dre + dim * dim;
      const hre = (-w * w * dre) / d;
      const him = (w * w * dim) / d;
      // The measurement's delay compensation (captured with the delay finder) is taken out of the phase
      const ph = Math.atan2(him, hre) - 2 * Math.PI * f * ((arrivalMs - compensatedMs) / 1000) + (invert ? Math.PI : 0);
      mag.push(20 * Math.log10(Math.hypot(hre, him)) + gainDb);
      phase.push((((ph * 180) / Math.PI + 540) % 360) - 180);
    }
    return { freqs: grid, mag, phase, delayMs: compensatedMs };
  };

  it('delays a delay tower that is 68 ms closer to the listener (arrival known from the captures)', () => {
    // Mains arrive 80 ms after the reference, the tower 12 ms: both measured with the delay finder
    const r = alignFullRange(speaker(80, 80), speaker(12, 12, -4));
    expect(r.delayMs).toBeCloseTo(68, 2);
    expect(r.polarity).toBe(1);
    expect(r.after).toBeGreaterThan(0.99);
    expect(r.levelDb).toBeCloseTo(-4, 1);
  });

  it('finds a small offset in the phase alone, and an inverted fill', () => {
    const r = alignFullRange(speaker(5, 0), speaker(2.4, 0, 0, true));
    expect(r.delayMs).toBeCloseTo(2.6, 2);
    expect(r.polarity).toBe(-1);
  });
});

describe('spectrum peak highlights', () => {
  it('finds the highest peak in the low, mid and high ranges', async () => {
    const { rangePeaks } = await import('../src/dsp/peaks');
    const grid = logGrid(20, 20000, 48);
    // Rising slope into the low range's top edge (not a peak), bumps at 63 Hz, 1 kHz (+ a smaller one) and 8 kHz
    const bump = (f: number, fc: number, h: number) => h * Math.exp(-Math.pow(Math.log2(f / fc) * 6, 2));
    const y = Array.from(grid, (f) => (f < 250 ? (f / 250) * 2 : 0) + bump(f, 63, 6) + bump(f, 1000, 8) + bump(f, 400, 4) + bump(f, 8000, 5));
    const p = rangePeaks(grid, y);
    expect(p.map((x) => x.range.id)).toEqual(['low', 'mid', 'high']);
    expect(Math.abs(Math.log2(p[0].f / 63))).toBeLessThan(0.05);
    expect(Math.abs(Math.log2(p[1].f / 1000))).toBeLessThan(0.05);
    expect(Math.abs(Math.log2(p[2].f / 8000))).toBeLessThan(0.05);
    expect(p[1].level).toBeCloseTo(8, 0);
  });
});

describe('spectrum peak highlights on a slope', () => {
  it('says when a range has no real peak', async () => {
    const { rangePeaks } = await import('../src/dsp/peaks');
    const grid = logGrid(20, 20000, 48);
    const y = Array.from(grid, (f) => -3 * Math.log2(f / 1000)); // falling everywhere
    const p = rangePeaks(grid, y);
    expect(p.every((x) => !x.isPeak)).toBe(true);
    expect(p[2].f).toBeCloseTo(4000, -2);
  });
});

describe('group delay', () => {
  it('reads a pure delay from a wrapped phase', () => {
    const grid = logGrid(20, 20000, 48);
    const tau = 0.0025; // 2.5 ms
    const wrapped = Array.from(grid, (f) => {
      const p = -360 * f * tau;
      return p - 360 * Math.round(p / 360);
    });
    const gd = groupDelayMs(grid, wrapped);
    for (const f of [30, 100, 1000, 5000]) expect(interp(grid, gd, f)).toBeCloseTo(2.5, 2);
  });

  it('shows the extra delay of a low-pass filter at its corner', () => {
    const grid = logGrid(20, 20000, 48);
    // 2nd-order Butterworth low-pass at 100 Hz: τ = (√2 / ω0)·(1 + w²) / (1 + w⁴), w = f / 100
    const ph = Array.from(grid, (f) => {
      const w = f / 100;
      return (-Math.atan2(Math.SQRT2 * w, 1 - w * w) * 180) / Math.PI;
    });
    const gd = groupDelayMs(grid, ph);
    const exact = (f: number) => ((Math.SQRT2 / (2 * Math.PI * 100)) * (1 + (f / 100) ** 2)) / (1 + (f / 100) ** 4) * 1000;
    for (const f of [20, 70, 100, 200]) expect(interp(grid, gd, f)).toBeCloseTo(exact(f), 1);
    expect(interp(grid, gd, 5000)).toBeLessThan(0.1);
  });

  it('smoothing ignores the spikes in dips that carry no energy', () => {
    const grid = logGrid(20, 20000, 48);
    const gd = Array.from(grid, (_, i) => (i % 40 === 0 ? 80 : 3));
    const w = Array.from(grid, (_, i) => (i % 40 === 0 ? 1e-4 : 1));
    const sm = smoothGroupDelay(grid, gd, w, 6);
    for (const f of [50, 500, 5000]) expect(interp(grid, sm, f)).toBeCloseTo(3, 1);
  });
});

describe('before/after compare', () => {
  const grid = logGrid(20, 20000, 24);
  const flat = new Float64Array(grid.length);
  // Before: a 10 dB room-mode peak at 50 Hz; after: the peak mostly removed and 6 dB louder overall
  const peak = (f: number, g: number) => g * Math.exp(-((Math.log2(f / 50) / 0.25) ** 2));
  const before = { freqs: Array.from(grid), mag: Array.from(grid, (f) => peak(f, 10)) };
  const after = { freqs: Array.from(grid), mag: Array.from(grid, (f) => 6 + peak(f, 2)) };

  it('scores each curve against the target, ignoring the level change', () => {
    const r = compareCurves(grid, before, after, flat, { fMin: 20, fMax: 20000, tolerance: 3, matchLevels: true });
    expect(r.devAfter!.rms).toBeLessThan(r.devBefore!.rms / 3);
    expect(r.devBefore!.worst.f).toBeCloseTo(50, -1);
    expect(r.shift).toBeCloseTo(6, 1);
  });

  it('shows only the change in shape when levels are matched', () => {
    const r = compareCurves(grid, before, after, null, { fMin: 20, fMax: 20000, tolerance: 3, matchLevels: true });
    expect(interp(grid, r.diff, 1000)).toBeCloseTo(0, 1);
    expect(interp(grid, r.diff, 50)).toBeCloseTo(-8, 0);
    expect(r.devBefore).toBeNull();
  });
});
