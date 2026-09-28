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
