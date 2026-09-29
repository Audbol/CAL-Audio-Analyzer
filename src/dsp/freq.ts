/** Frequency-axis helpers: log grids, fractional-octave smoothing, interpolation, band centres. */

export const F_MIN = 20;
export const F_MAX = 20000;

/** Logarithmically spaced frequency grid with `pointsPerOctave` resolution. */
export function logGrid(fMin = F_MIN, fMax = F_MAX, pointsPerOctave = 48): Float64Array {
  const octaves = Math.log2(fMax / fMin);
  const n = Math.max(2, Math.ceil(octaves * pointsPerOctave) + 1);
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) g[i] = fMin * Math.pow(2, (i * octaves) / (n - 1));
  return g;
}

export type Smoothing = 0 | 1 | 3 | 6 | 12 | 24 | 48;
export const SMOOTHING_OPTIONS: { value: Smoothing; label: string }[] = [
  { value: 0, label: 'None' },
  { value: 48, label: '1/48 oct' },
  { value: 24, label: '1/24 oct' },
  { value: 12, label: '1/12 oct' },
  { value: 6, label: '1/6 oct' },
  { value: 3, label: '1/3 oct' },
  { value: 1, label: '1/1 oct' },
];

/**
 * Resample a linear-bin spectrum (power values, bin k ↔ k*df) onto a log grid with
 * fractional-octave smoothing. Uses prefix sums so each output point is O(1).
 * When smoothing is 0 a minimum width of the grid spacing is used (so no information is aliased away).
 */
export class LogSmoother {
  private prefix = new Float64Array(0);

  constructor(
    readonly grid: Float64Array,
    readonly df: number,
    readonly bins: number,
  ) {}

  /** power: linear power values for bins 0..bins-1. out: same length as grid. */
  apply(power: ArrayLike<number>, fraction: Smoothing, out: Float64Array): Float64Array {
    const n = this.bins;
    if (this.prefix.length !== n + 1) this.prefix = new Float64Array(n + 1);
    const p = this.prefix;
    p[0] = 0;
    for (let i = 0; i < n; i++) p[i + 1] = p[i] + power[i];
    const g = this.grid;
    const gridStep = g.length > 1 ? Math.log2(g[1] / g[0]) : 1 / 48;
    const width = fraction > 0 ? Math.max(1 / fraction, gridStep) : gridStep;
    const half = Math.pow(2, width / 2);
    const df = this.df;
    for (let i = 0; i < g.length; i++) {
      const f = g[i];
      const lo = f / half / df;
      const hi = f * half / df;
      out[i] = rangeMean(p, n, lo, hi, f / df);
    }
    return out;
  }
}

/** Mean of the bins between fractional bin positions lo..hi, linear-interpolating when the span is < 1 bin. */
function rangeMean(prefix: Float64Array, n: number, lo: number, hi: number, centre: number): number {
  if (hi - lo < 1) {
    // Narrower than one bin → interpolate between neighbouring bins
    const c = Math.min(Math.max(centre, 0), n - 1);
    const i0 = Math.floor(c);
    const i1 = Math.min(i0 + 1, n - 1);
    const t = c - i0;
    const v0 = prefix[i0 + 1] - prefix[i0];
    const v1 = prefix[i1 + 1] - prefix[i1];
    return v0 + (v1 - v0) * t;
  }
  const a = Math.max(0, Math.round(lo));
  const b = Math.min(n - 1, Math.round(hi));
  if (b < a) return 0;
  return (prefix[b + 1] - prefix[a]) / (b - a + 1);
}

/** Smooth an already log-spaced (or arbitrary) curve with fractional octave width. Works on linear values. */
export function smoothCurve(freqs: ArrayLike<number>, values: ArrayLike<number>, fraction: Smoothing): Float64Array {
  const n = freqs.length;
  const out = new Float64Array(n);
  if (!fraction) {
    for (let i = 0; i < n; i++) out[i] = values[i];
    return out;
  }
  const half = Math.pow(2, 1 / fraction / 2);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const fLo = freqs[i] / half;
    const fHi = freqs[i] * half;
    while (hi < n && freqs[hi] <= fHi) sum += values[hi++];
    while (lo < hi && freqs[lo] < fLo) sum -= values[lo++];
    out[i] = hi > lo ? sum / (hi - lo) : values[i];
  }
  return out;
}

/**
 * Gentle fractional-octave smoothing with a bell-shaped (near-Gaussian) window: three passes of a box average,
 * whose combined width at half height is about 1/fraction octave. Unlike a single box it has no flat tops or
 * steps, so curves look natural. `values` should be linear power; pass log-spaced frequencies.
 */
export function gaussianSmooth(freqs: ArrayLike<number>, values: ArrayLike<number>, fraction: number): Float64Array {
  let out = Float64Array.from(values);
  if (!fraction || freqs.length < 3) return out;
  // Three boxes of width b have a standard deviation of b/2; FWHM = 2.355·σ
  const box = 0.85 / fraction; // octaves
  const half = Math.pow(2, box / 2);
  const n = freqs.length;
  for (let pass = 0; pass < 3; pass++) {
    const src = out;
    out = new Float64Array(n);
    let lo = 0;
    let hi = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const fLo = freqs[i] / half;
      const fHi = freqs[i] * half;
      while (hi < n && freqs[hi] <= fHi) sum += src[hi++];
      while (lo < hi && freqs[lo] < fLo) sum -= src[lo++];
      out[i] = hi > lo ? sum / (hi - lo) : src[i];
    }
  }
  return out;
}

/** Linear interpolation of y(x) at xi, with x ascending. Values outside the range are clamped. */
export function interp(x: ArrayLike<number>, y: ArrayLike<number>, xi: number): number {
  const n = x.length;
  if (n === 0) return 0;
  if (xi <= x[0]) return y[0];
  if (xi >= x[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= xi) lo = mid;
    else hi = mid;
  }
  const t = (xi - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + (y[hi] - y[lo]) * t;
}

/** Interpolate in log-frequency, useful for calibration curves. */
export function interpLogF(freqs: ArrayLike<number>, vals: ArrayLike<number>, f: number): number {
  const lx = Array.from(freqs, (v) => Math.log(Math.max(v, 1e-9)));
  return interp(lx, vals, Math.log(Math.max(f, 1e-9)));
}

/** Nominal / exact fractional octave band centres (base-10, IEC 61260). */
export function bandCentres(fraction: 1 | 3, fMin = 20, fMax = 20000): number[] {
  const G = Math.pow(10, 3 / 10);
  const out: number[] = [];
  for (let x = -40; x <= 40; x++) {
    const f = 1000 * Math.pow(G, x / fraction);
    if (f >= fMin * 0.98 && f <= fMax * 1.02) out.push(f);
  }
  return out;
}

export function nominalBandLabel(f: number): string {
  const nominal = [
    16, 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500,
    3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
  ];
  let best = nominal[0];
  for (const n of nominal) if (Math.abs(Math.log(n / f)) < Math.abs(Math.log(best / f))) best = n;
  return best >= 1000 ? `${best / 1000}k` : `${best}`;
}

export function formatFreq(f: number): string {
  if (f >= 10000) return `${(f / 1000).toFixed(1)} kHz`;
  if (f >= 1000) return `${(f / 1000).toFixed(2)} kHz`;
  if (f >= 100) return `${f.toFixed(0)} Hz`;
  return `${f.toFixed(1)} Hz`;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(f: number): string {
  if (f <= 0) return '';
  const midi = 69 + 12 * Math.log2(f / 440);
  const r = Math.round(midi);
  const cents = Math.round((midi - r) * 100);
  const name = NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  return `${name}${cents >= 0 ? '+' : ''}${cents}¢`;
}

export const dB = (p: number): number => 10 * Math.log10(Math.max(p, 1e-30));
export const dBa = (a: number): number => 20 * Math.log10(Math.max(Math.abs(a), 1e-15));

/** Points per octave of a log grid (e.g. 48 for the analysis grid). */
export function gridPpo(grid: ArrayLike<number>): number {
  return (grid.length - 1) / Math.log2(grid[grid.length - 1] / grid[0]);
}

/**
 * Combine fine band levels (dB, one band per grid point at 1/ppo octave) into 1/`fraction` octave band levels
 * centred on every grid point (power sum with fractional edge weights, so pink noise stays flat).
 */
export function regroupBands(db: ArrayLike<number>, ppo: number, fraction: number, out: Float64Array): Float64Array {
  const n = db.length;
  const hw = ppo / (2 * fraction);
  if (hw <= 0.5) {
    for (let i = 0; i < n; i++) out[i] = db[i];
    return out;
  }
  const r = Math.ceil(hw + 0.5);
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) p[i] = Math.pow(10, db[i] / 10);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let wsum = 0;
    for (let j = -r; j <= r; j++) {
      const w = Math.min(1, hw + 0.5 - Math.abs(j));
      if (w <= 0) continue;
      wsum += w;
      const k = i + j;
      if (k >= 0 && k < n) s += w * p[k];
    }
    // At the grid ends the band extends past the data: scale up the covered part
    let covered = 0;
    for (let j = -r; j <= r; j++) {
      const w = Math.min(1, hw + 0.5 - Math.abs(j));
      if (w > 0 && i + j >= 0 && i + j < n) covered += w;
    }
    out[i] = 10 * Math.log10(Math.max((s * wsum) / Math.max(covered, 1e-9), 1e-30));
  }
  return out;
}

/** Smooth a transfer function (dB, degrees, coherence) given on a fine log grid to 1/`fraction` octave. */
export function smoothTransfer(
  mag: ArrayLike<number>,
  phase: ArrayLike<number>,
  coh: ArrayLike<number>,
  ppo: number,
  fraction: number,
  outMag: Float64Array,
  outPhase: Float64Array,
  outCoh: Float64Array,
): void {
  const n = mag.length;
  const hw = ppo / (2 * fraction);
  const r = Math.max(0, Math.floor(hw));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const pw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Number.isFinite(mag[i]) ? Math.pow(10, mag[i] / 20) : 0;
    const ph = (phase[i] * Math.PI) / 180;
    re[i] = Number.isFinite(ph) ? a * Math.cos(ph) : 0;
    im[i] = Number.isFinite(ph) ? a * Math.sin(ph) : 0;
    pw[i] = a * a;
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(mag[i])) {
      outMag[i] = NaN;
      outPhase[i] = NaN;
      outCoh[i] = 0;
      continue;
    }
    let sr = 0;
    let si = 0;
    let sp = 0;
    let sc = 0;
    let c = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) {
      sr += re[k];
      si += im[k];
      sp += pw[k];
      sc += coh[k];
      c++;
    }
    outMag[i] = 10 * Math.log10(Math.max(sp / c, 1e-40));
    outPhase[i] = (Math.atan2(si, sr) * 180) / Math.PI;
    outCoh[i] = sc / c;
  }
}

/** Exact base-2 fractional-octave band centres (1 kHz reference) of the bands that overlap [fMin, fMax]
 * by at least half (so the nominal 20 Hz and 20 kHz third-octave bands are included). */
export function octaveBandCentres(fraction: number, fMin = 20, fMax = 20000): number[] {
  const out: number[] = [];
  const k0 = Math.ceil(Math.log2(fMin / 1000) * fraction - 0.5);
  const k1 = Math.floor(Math.log2(fMax / 1000) * fraction + 0.5);
  for (let k = k0; k <= k1; k++) out.push(1000 * Math.pow(2, k / fraction));
  return out;
}

/** Sample values on a log-uniform grid at frequency f (linear interpolation in log frequency). */
export function sampleLogGrid(grid: ArrayLike<number>, vals: ArrayLike<number>, f: number): number {
  const n = grid.length;
  const pos = (Math.log2(f / grid[0]) / Math.log2(grid[n - 1] / grid[0])) * (n - 1);
  if (pos <= 0) return vals[0];
  if (pos >= n - 1) return vals[n - 1];
  const i = Math.floor(pos);
  const t = pos - i;
  return vals[i] * (1 - t) + vals[i + 1] * t;
}
