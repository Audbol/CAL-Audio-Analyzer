import { FFT, nextPow2 } from './fft';

export interface SweepSpec {
  fs: number;
  f1: number;
  f2: number;
  /** Sweep duration in seconds (excluding the silent tail). */
  duration: number;
  /** Amplitude 0..1. */
  amplitude: number;
}

/** Exponential (log) sine sweep after Farina, with short raised-cosine fades to avoid clicks. */
export function logSweep(spec: SweepSpec): Float32Array {
  const { fs, f1, f2, duration, amplitude } = spec;
  const n = Math.round(duration * fs);
  const out = new Float32Array(n);
  const w1 = 2 * Math.PI * f1;
  const L = duration / Math.log(f2 / f1);
  const fadeIn = Math.min(Math.round(fs * 0.05), n >> 3);
  const fadeOut = Math.min(Math.round(fs * 0.005), n >> 3);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let g = amplitude;
    if (i < fadeIn) g *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    else if (i > n - fadeOut) g *= 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / fadeOut);
    out[i] = g * Math.sin(w1 * L * (Math.exp(t / L) - 1));
  }
  return out;
}

export interface Deconvolution {
  /** Full circular impulse response. Linear response starts at index `peak - pre`; harmonics wrap to the end. */
  ir: Float64Array;
  fs: number;
  /** Index of the main peak. */
  peak: number;
}

/**
 * Deconvolve a recorded sweep response with regularised spectral division, band-limited to the sweep range.
 * The result is the system impulse response (circular: distortion products appear at negative time).
 */
export function deconvolve(recorded: ArrayLike<number>, sweep: ArrayLike<number>, spec: SweepSpec): Deconvolution {
  const n = nextPow2(Math.max(recorded.length, sweep.length) + sweep.length);
  const yr = new Float64Array(n);
  const yi = new Float64Array(n);
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  for (let i = 0; i < recorded.length; i++) yr[i] = recorded[i];
  for (let i = 0; i < sweep.length; i++) xr[i] = sweep[i];
  const fft = FFT.get(n);
  fft.forward(yr, yi);
  fft.forward(xr, xi);
  const df = spec.fs / n;
  let maxX = 0;
  for (let k = 0; k <= n / 2; k++) maxX = Math.max(maxX, xr[k] * xr[k] + xi[k] * xi[k]);
  const eps = maxX * 1e-6;
  const fLo = spec.f1;
  const fHi = Math.min(spec.f2, spec.fs / 2);
  for (let k = 0; k <= n / 2; k++) {
    const f = k * df;
    // Smooth band-limiting (half-octave raised-cosine skirts)
    let g = 1;
    if (f < fLo) g = f < fLo / 2 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * (Math.log2(f / (fLo / 2)) / 1));
    else if (f > fHi) g = f > fHi * 1.2 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (f - fHi)) / (fHi * 0.2));
    const d = xr[k] * xr[k] + xi[k] * xi[k] + eps;
    // Y conj(X) / |X|²
    const r = ((yr[k] * xr[k] + yi[k] * xi[k]) / d) * g;
    const i = ((yi[k] * xr[k] - yr[k] * xi[k]) / d) * g;
    yr[k] = r;
    yi[k] = i;
    if (k > 0 && k < n / 2) {
      yr[n - k] = r;
      yi[n - k] = -i;
    }
  }
  fft.inverse(yr, yi);
  let peak = 0;
  let pv = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(yr[i]);
    if (a > pv) {
      pv = a;
      peak = i;
    }
  }
  return { ir: yr, fs: spec.fs, peak };
}

/** Time offset (s) before the linear IR at which the k-th harmonic IR appears. */
export function harmonicOffset(spec: SweepSpec, k: number): number {
  return (spec.duration * Math.log(k)) / Math.log(spec.f2 / spec.f1);
}

/** Extract a windowed segment of a circular buffer. */
function segment(ir: Float64Array, start: number, len: number, fadeIn: number, fadeOut: number): Float64Array {
  const n = ir.length;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    let g = 1;
    if (i < fadeIn) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    else if (i >= len - fadeOut) g = 0.5 - 0.5 * Math.cos((Math.PI * (len - i)) / fadeOut);
    out[i] = ir[(((start + i) % n) + n) % n] * g;
  }
  return out;
}

export interface Spectrum {
  freqs: Float64Array;
  /** Linear magnitude. */
  mag: Float64Array;
  /** Phase, radians (wrapped). */
  phase: Float64Array;
}

export function spectrumOf(x: Float64Array, fs: number, size?: number): Spectrum {
  const n = size ?? nextPow2(x.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x.subarray(0, Math.min(n, x.length)));
  FFT.get(n).forward(re, im);
  const bins = n / 2 + 1;
  const freqs = new Float64Array(bins);
  const mag = new Float64Array(bins);
  const phase = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * fs) / n;
    mag[k] = Math.hypot(re[k], im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }
  return { freqs, mag, phase };
}

/** Linear IR (starting slightly before the direct sound) with an optional tail window. */
export function linearIR(d: Deconvolution, preMs = 5, lengthS = 2): { ir: Float64Array; t0: number } {
  const pre = Math.round((preMs / 1000) * d.fs);
  const len = Math.min(Math.round(lengthS * d.fs), d.ir.length / 2);
  return { ir: segment(d.ir, d.peak - pre, len, Math.max(1, pre >> 1), Math.round(len * 0.02)), t0: pre };
}

export interface DistortionResult {
  freqs: Float64Array;
  /** Fundamental magnitude, dB (relative). */
  fundamental: Float64Array;
  /** Harmonic k=2..K magnitudes on the fundamental frequency axis, dB (same reference). */
  harmonics: Float64Array[];
  /** THD in percent. */
  thd: Float64Array;
}

/**
 * Harmonic distortion from a log sweep deconvolution (Farina method). Harmonic IRs are windowed out of the
 * negative-time part of the circular IR and their spectra are mapped back to the excitation frequency.
 */
export function harmonicDistortion(d: Deconvolution, spec: SweepSpec, grid: Float64Array, maxHarmonic = 5): DistortionResult {
  const fs = d.fs;
  const winLen = nextPow2(Math.round(fs * 0.05)); // ~50 ms windows → resolution adequate above ~40 Hz
  const size = winLen * 2;
  const fundSeg = segment(d.ir, d.peak - (winLen >> 4), winLen, winLen >> 5, winLen >> 2);
  const fund = spectrumOf(fundSeg, fs, size);
  const harmSpec: Spectrum[] = [];
  for (let k = 2; k <= maxHarmonic; k++) {
    const off = Math.round(harmonicOffset(spec, k) * fs);
    const gap = Math.round((harmonicOffset(spec, k) - harmonicOffset(spec, k - 1)) * fs);
    const len = Math.min(winLen, Math.max(64, Math.round(gap * 0.9)));
    const seg = segment(d.ir, d.peak - off - (len >> 4), len, len >> 5, len >> 2);
    harmSpec.push(spectrumOf(seg, fs, size));
  }
  const df = fs / size;
  const at = (s: Spectrum, f: number) => {
    const b = f / df;
    const i = Math.floor(b);
    if (i + 1 >= s.mag.length) return 0;
    const t = b - i;
    return s.mag[i] * (1 - t) + s.mag[i + 1] * t;
  };
  const n = grid.length;
  const fundamental = new Float64Array(n);
  const harmonics = harmSpec.map(() => new Float64Array(n));
  const thd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = grid[i];
    const m1 = at(fund, f);
    fundamental[i] = 20 * Math.log10(Math.max(m1, 1e-12));
    let sum = 0;
    harmSpec.forEach((s, j) => {
      const fk = f * (j + 2);
      const mk = fk < Math.min(spec.f2, fs / 2) ? at(s, fk) : 0;
      harmonics[j][i] = 20 * Math.log10(Math.max(mk, 1e-12));
      sum += mk * mk;
    });
    thd[i] = m1 > 0 ? (100 * Math.sqrt(sum)) / m1 : 0;
  }
  return { freqs: grid, fundamental, harmonics, thd };
}
