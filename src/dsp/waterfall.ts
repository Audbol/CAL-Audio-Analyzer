import { FFT, nextPow2 } from './fft';
import { gaussianSmooth } from './freq';

/**
 * Cumulative spectral decay (waterfall): the spectrum of the impulse response from successively later start
 * times, so resonances (room modes, ringing) show as ridges that take long to die away.
 */
export interface WaterfallOptions {
  /** Time span covered by the slices (ms after the direct sound). */
  spanMs: number;
  /** Number of slices. */
  slices: number;
  /** Analysis window length (ms): longer resolves lower frequencies. */
  windowMs: number;
  /** Frequency range. */
  fMin: number;
  fMax: number;
  /** Smoothing (1/n octave, bell-shaped). */
  smoothing: number;
}

export interface WaterfallResult {
  freqs: Float64Array;
  /** Start time of each slice (ms after the direct sound). */
  times: number[];
  /** Level per slice (dB, 0 = the highest level of the first slice). */
  slices: Float64Array[];
}

export const WATERFALL_PRESETS: Record<'bass' | 'full', WaterfallOptions> = {
  // Room modes: long window for bass resolution, a few hundred ms of decay
  bass: { spanMs: 400, slices: 32, windowMs: 300, fMin: 15, fMax: 500, smoothing: 24 },
  // Loudspeaker / early decay over the whole range
  full: { spanMs: 20, slices: 32, windowMs: 40, fMin: 100, fMax: 20000, smoothing: 12 },
};

export function waterfall(ir: Float64Array, fs: number, t0: number, o: WaterfallOptions): WaterfallResult {
  const winN = Math.max(32, Math.round((o.windowMs / 1000) * fs));
  const size = nextPow2(winN) * 2;
  const fft = FFT.get(size);
  const df = fs / size;
  // Log grid: 48 points per octave
  const nPts = Math.max(8, Math.round(Math.log2(o.fMax / o.fMin) * 48));
  const freqs = Float64Array.from({ length: nPts }, (_, i) => o.fMin * Math.pow(o.fMax / o.fMin, i / (nPts - 1)));
  const rise = Math.max(1, Math.round(0.0005 * fs)); // 0.5 ms rise at the start
  const fall = Math.max(1, Math.round(winN * 0.25)); // quarter-length half-Hann fade at the end
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const times: number[] = [];
  const slices: Float64Array[] = [];
  let ref = -Infinity;
  for (let k = 0; k < o.slices; k++) {
    const tMs = (k / Math.max(1, o.slices - 1)) * o.spanMs;
    const start = t0 + Math.round((tMs / 1000) * fs);
    if (start >= ir.length) break;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < winN && start + i < ir.length; i++) {
      let w = 1;
      if (k > 0 && i < rise) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
      if (i >= winN - fall) w *= 0.5 + 0.5 * Math.cos((Math.PI * (i - (winN - fall))) / fall);
      re[i] = ir[start + i] * w;
    }
    fft.forward(re, im);
    // Power at the grid frequencies: all FFT bins between neighbouring grid points (or the nearest bin)
    const pow = new Float64Array(nPts);
    for (let i = 0; i < nPts; i++) {
      const fLo = i > 0 ? Math.sqrt(freqs[i] * freqs[i - 1]) : freqs[i];
      const fHi = i < nPts - 1 ? Math.sqrt(freqs[i] * freqs[i + 1]) : freqs[i];
      let a = Math.max(1, Math.floor(fLo / df));
      let b = Math.min(size / 2, Math.ceil(fHi / df));
      if (b <= a) {
        a = Math.min(size / 2, Math.max(1, Math.round(freqs[i] / df)));
        b = a + 1;
      }
      let p = 0;
      for (let j = a; j < b; j++) p += re[j] * re[j] + im[j] * im[j];
      pow[i] = p / (b - a);
    }
    const sm = gaussianSmooth(freqs, pow, o.smoothing);
    const db = Float64Array.from(sm, (v) => 10 * Math.log10(Math.max(v, 1e-30)));
    if (k === 0) for (const v of db) ref = Math.max(ref, v);
    for (let i = 0; i < nPts; i++) db[i] -= ref;
    times.push(tMs);
    slices.push(db);
  }
  return { freqs, times, slices };
}
