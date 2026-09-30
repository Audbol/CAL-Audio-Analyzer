import { FFT, nextPow2 } from './fft';
import { bandCentres } from './freq';

/**
 * Room acoustics parameters from an impulse response (ISO 3382-1 style):
 * Schroeder backward integration with noise-floor compensation, EDT/T20/T30, C50/C80/D50, centre time.
 */

export interface DecayFit {
  /** Reverberation time in seconds (extrapolated to -60 dB), or NaN if the range was not available. */
  rt: number;
  /** Correlation coefficient of the linear fit (quality indicator; > 0.99 is good). */
  r: number;
  slope: number;
  intercept: number;
}

export interface BandAcoustics {
  centre: number;
  label: string;
  edt: DecayFit;
  t20: DecayFit;
  t30: DecayFit;
  c50: number;
  c80: number;
  d50: number;
  ts: number;
  /** Peak-to-noise ratio of the band IR (dB). Values under ~45 dB make T30 unreliable. */
  inr: number;
  /** Schroeder decay (dB, 0 at start) sampled every `decayStep` seconds, for plotting. */
  decay: Float32Array;
}

export interface AcousticsResult {
  broadband: BandAcoustics;
  bands: BandAcoustics[];
  decayStep: number;
}

/** Zero-phase octave (or 1/3 octave) band-pass in the frequency domain (6th-order Butterworth-like skirts). */
export function bandFilter(ir: Float64Array, fs: number, fc: number, fraction: 1 | 3): Float64Array {
  const n = nextPow2(ir.length * 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(ir);
  const fft = FFT.get(n);
  fft.forward(re, im);
  const G = Math.pow(10, 3 / 10);
  const qr = 1 / (Math.pow(G, 1 / (2 * fraction)) - Math.pow(G, -1 / (2 * fraction)));
  const order = 3;
  for (let k = 0; k <= n / 2; k++) {
    const f = (k * fs) / n;
    let g = 0;
    if (f > 0) {
      const x = qr * (f / fc - fc / f);
      g = 1 / Math.sqrt(1 + Math.pow(x * x, order));
    }
    re[k] *= g;
    im[k] *= g;
    if (k > 0 && k < n / 2) {
      re[n - k] *= g;
      im[n - k] *= g;
    }
  }
  fft.inverse(re, im);
  return re.slice(0, ir.length);
}

interface Truncation {
  /** Index where the decay meets the noise floor. */
  end: number;
  /** Noise floor (mean energy per sample). */
  noise: number;
  /** Energy of the extrapolated decay beyond `end` (Lundeby compensation). */
  tail: number;
}

function meanRange(e: Float64Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += e[i];
  return s / Math.max(1, b - a);
}

/**
 * Noise floor, truncation point and late-tail compensation after Lundeby et al. (1995):
 * iteratively fit the smoothed decay, intersect it with the noise floor and re-estimate the noise from the
 * region well past the intersection. Falls back to a backward scan when no decay slope can be fitted.
 */
function truncation(e: Float64Array, fs: number, peakIdx: number, centre: number): Truncation {
  const n = e.length;
  const tailN = Math.max(Math.round(n * 0.1), 1);
  let noise = meanRange(e, n - tailN, n);
  let blkS = centre > 0 && centre < 250 ? 0.03 : centre > 0 && centre < 1000 ? 0.02 : 0.01;
  let tc = NaN;
  let slope = NaN;
  for (let iter = 0; iter < 6; iter++) {
    const blk = Math.max(8, Math.round(blkS * fs));
    const noiseDb = 10 * Math.log10(Math.max(noise, 1e-300));
    const t: number[] = [];
    const v: number[] = [];
    let maxDb = -Infinity;
    for (let i = peakIdx; i + blk <= n; i += blk) {
      const db = 10 * Math.log10(Math.max(meanRange(e, i, i + blk), 1e-300));
      maxDb = Math.max(maxDb, db);
      if (db < noiseDb + 5) break;
      t.push((i + blk / 2 - peakIdx) / fs);
      v.push(db);
    }
    // Fit only the part of the decay 5 dB below its maximum (skip the direct sound)
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < t.length; k++) if (v[k] <= maxDb - 5) {
      xs.push(t[k]);
      ys.push(v[k]);
    }
    if (xs.length < 3) break;
    const fit = linearFit(xs, ys);
    if (!(fit.slope < 0)) break;
    const newTc = (noiseDb - fit.intercept) / fit.slope;
    if (!Number.isFinite(newTc) || newTc <= 0) break;
    const converged = Number.isFinite(tc) && Math.abs(newTc - tc) < 0.01 * tc;
    tc = newTc;
    slope = fit.slope;
    // Re-estimate noise starting where the decay would be 10 dB below the current noise estimate
    const nStart = peakIdx + Math.round((tc + 10 / -slope) * fs);
    noise = n - nStart >= tailN ? meanRange(e, nStart, n) : meanRange(e, n - tailN, n);
    // About 6 blocks per 10 dB of decay
    blkS = Math.min(0.05, Math.max(0.004, 10 / -slope / 6));
    if (converged) break;
  }
  if (Number.isFinite(tc) && slope < 0) {
    const end = Math.min(n, peakIdx + Math.round(tc * fs));
    const a = (-slope * Math.LN10) / 10; // energy decay rate (1/s)
    const tail = noise / (1 - Math.exp(-a / fs));
    return { end, noise, tail };
  }
  // Fallback: last 10 ms block clearly above the noise floor
  const blk = Math.max(1, Math.round(fs * 0.01));
  let end = n;
  for (let i = n - tailN - blk; i > peakIdx; i -= blk) {
    if (meanRange(e, i, i + blk) > noise * 2) {
      end = Math.min(n, i + blk);
      break;
    }
  }
  return { end, noise, tail: 0 };
}

function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; r: number } {
  const n = xs.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r: 0 };
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  const slope = cov / vx;
  const intercept = (sy - slope * sx) / n;
  const r = vx > 0 && vy > 0 ? Math.abs(cov / Math.sqrt(vx * vy)) : 0;
  return { slope, intercept, r };
}

function fitDecay(decayDb: Float64Array, fs: number, from: number, to: number): DecayFit {
  const xs: number[] = [];
  const ys: number[] = [];
  let reached = false;
  const step = Math.max(1, Math.floor(decayDb.length / 20000));
  for (let i = 0; i < decayDb.length; i += step) {
    const v = decayDb[i];
    if (v <= from && v >= to) {
      xs.push(i / fs);
      ys.push(v);
    }
    if (v < to) {
      reached = true;
      break;
    }
  }
  if (!reached || xs.length < 4) return { rt: NaN, r: 0, slope: NaN, intercept: NaN };
  const { slope, intercept, r } = linearFit(xs, ys);
  return { rt: slope < 0 ? -60 / slope : NaN, r, slope, intercept };
}

/** Analyse a single (band-limited) impulse response. `start` is the index of the direct sound onset. */
export function analyseIR(ir: Float64Array, fs: number, centre = 0, label = 'Broadband', decayStep = 0.005): BandAcoustics {
  const n = ir.length;
  const e = new Float64Array(n);
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < n; i++) {
    e[i] = ir[i] * ir[i];
    if (e[i] > peak) {
      peak = e[i];
      peakIdx = i;
    }
  }
  // ISO 3382: start where the energy first rises to within 20 dB of the peak
  let start = peakIdx;
  for (let i = 0; i < peakIdx; i++) {
    if (e[i] >= peak * 0.01) {
      start = i;
      break;
    }
  }
  const { end, noise, tail } = truncation(e, fs, peakIdx, centre);
  // Schroeder backward integration from the truncation point, with noise subtraction and compensation for
  // the energy of the decay that is hidden below the noise floor
  const decay = new Float64Array(Math.max(1, end - start));
  let acc = tail;
  const floor = tail > 0 ? tail * 1e-3 : 1e-30;
  for (let i = end - 1; i >= start; i--) {
    acc += e[i] - noise;
    decay[i - start] = Math.max(acc, floor);
  }
  const total = decay[0] || 1e-30;
  const decayDb = new Float64Array(decay.length);
  for (let i = 0; i < decay.length; i++) decayDb[i] = 10 * Math.log10(Math.max(decay[i] / total, 1e-30));

  const edt = fitDecay(decayDb, fs, 0, -10);
  const t20 = fitDecay(decayDb, fs, -5, -25);
  const t30 = fitDecay(decayDb, fs, -5, -35);

  const idx50 = start + Math.round(0.05 * fs);
  const idx80 = start + Math.round(0.08 * fs);
  let e50 = 0,
    e80 = 0,
    eAll = 0,
    tSum = 0;
  for (let i = start; i < end; i++) {
    const v = Math.max(e[i] - noise, 0);
    if (i < idx50) e50 += v;
    if (i < idx80) e80 += v;
    eAll += v;
    tSum += v * ((i - start) / fs);
  }
  eAll += tail;
  const inr = 10 * Math.log10(peak / Math.max(noise, 1e-30));
  const stepN = Math.max(1, Math.round(decayStep * fs));
  const plot = new Float32Array(Math.ceil(decayDb.length / stepN));
  for (let i = 0; i < plot.length; i++) plot[i] = decayDb[i * stepN];
  return {
    centre,
    label,
    edt,
    t20,
    t30,
    c50: 10 * Math.log10(e50 / Math.max(eAll - e50, 1e-30)),
    c80: 10 * Math.log10(e80 / Math.max(eAll - e80, 1e-30)),
    d50: (100 * e50) / Math.max(eAll, 1e-30),
    ts: (tSum / Math.max(eAll, 1e-30)) * 1000,
    inr,
    decay: plot,
  };
}

export function roomAcoustics(ir: Float64Array, fs: number, fraction: 1 | 3 = 1): AcousticsResult {
  const decayStep = 0.005;
  const broadband = analyseIR(ir, fs, 0, 'Broadband', decayStep);
  // ISO 3382 range: 63 Hz – 8 kHz octaves (50 Hz – 10 kHz thirds), capped well below Nyquist
  const centres = bandCentres(fraction, fraction === 1 ? 60 : 48, Math.min(fs / 4, fraction === 1 ? 8500 : 10500));
  const bands = centres.map((fc) => {
    const label = fc >= 1000 ? `${Math.round(fc / 100) / 10}k` : `${Math.round(fc)}`;
    return analyseIR(bandFilter(ir, fs, fc, fraction), fs, fc, label, decayStep);
  });
  return { broadband, bands, decayStep };
}

/** Energy-time curve in dB (squared analytic-signal envelope, peak = 0 dB). */
export function energyTimeCurve(ir: Float64Array): Float64Array {
  const n = nextPow2(ir.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(ir);
  const fft = FFT.get(n);
  fft.forward(re, im);
  // Analytic signal: zero negative frequencies, double positive
  for (let k = 1; k < n / 2; k++) {
    re[k] *= 2;
    im[k] *= 2;
  }
  for (let k = n / 2 + 1; k < n; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fft.inverse(re, im);
  const out = new Float64Array(ir.length);
  let max = 1e-30;
  for (let i = 0; i < ir.length; i++) {
    out[i] = re[i] * re[i] + im[i] * im[i];
    if (out[i] > max) max = out[i];
  }
  for (let i = 0; i < ir.length; i++) out[i] = 10 * Math.log10(Math.max(out[i] / max, 1e-12));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Room mode calculator

export interface RoomMode {
  f: number;
  n: [number, number, number];
  kind: 'axial' | 'tangential' | 'oblique';
}

export function roomModes(L: number, W: number, H: number, c = 343, fMax = 300): RoomMode[] {
  const modes: RoomMode[] = [];
  const max = (d: number) => Math.ceil((2 * d * fMax) / c);
  for (let a = 0; a <= max(L); a++)
    for (let b = 0; b <= max(W); b++)
      for (let d = 0; d <= max(H); d++) {
        if (a + b + d === 0) continue;
        const f = (c / 2) * Math.sqrt((a / L) ** 2 + (b / W) ** 2 + (d / H) ** 2);
        if (f > fMax) continue;
        const nz = (a ? 1 : 0) + (b ? 1 : 0) + (d ? 1 : 0);
        modes.push({ f, n: [a, b, d], kind: nz === 1 ? 'axial' : nz === 2 ? 'tangential' : 'oblique' });
      }
  return modes.sort((p, q) => p.f - q.f);
}

/** Schroeder frequency (Hz) for a room of volume V (m³) and reverberation time RT60 (s). */
export function schroederFrequency(rt60: number, volume: number): number {
  return 2000 * Math.sqrt(rt60 / volume);
}

/** Critical distance (m) for directivity factor Q. */
export function criticalDistance(volume: number, rt60: number, Q = 2): number {
  return 0.057 * Math.sqrt((Q * volume) / rt60);
}
