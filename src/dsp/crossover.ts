import type { AlignInput } from './align';

/**
 * Crossover designer: the response of standard crossover filters (Butterworth, Linkwitz-Riley), applied as a
 * virtual crossover to measured parts so their sum can be previewed before anything is set in the processor.
 */

export type XoverShape = 'none' | 'bw6' | 'bw12' | 'bw18' | 'bw24' | 'bw36' | 'bw48' | 'lr12' | 'lr24' | 'lr36' | 'lr48';

export const XOVER_SHAPES: { id: XoverShape; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'lr12', label: 'Linkwitz-Riley 12 dB/oct' },
  { id: 'lr24', label: 'Linkwitz-Riley 24 dB/oct' },
  { id: 'lr36', label: 'Linkwitz-Riley 36 dB/oct' },
  { id: 'lr48', label: 'Linkwitz-Riley 48 dB/oct' },
  { id: 'bw6', label: 'Butterworth 6 dB/oct' },
  { id: 'bw12', label: 'Butterworth 12 dB/oct' },
  { id: 'bw18', label: 'Butterworth 18 dB/oct' },
  { id: 'bw24', label: 'Butterworth 24 dB/oct' },
  { id: 'bw36', label: 'Butterworth 36 dB/oct' },
  { id: 'bw48', label: 'Butterworth 48 dB/oct' },
];

export interface XoverSide {
  shape: XoverShape;
  /** Corner frequency (Hz). */
  fc: number;
}

/** A two-way crossover: the sub's low-pass and the mains' high-pass, with the sub's level and polarity. */
export interface CrossoverDesign {
  on: boolean;
  low: XoverSide;
  high: XoverSide;
  /** Sub level change (dB). */
  subGain: number;
  /** Sub polarity inverted (as set in the processor). */
  subInvert: boolean;
}

export const DEFAULT_CROSSOVER: CrossoverDesign = { on: false, low: { shape: 'lr24', fc: 100 }, high: { shape: 'lr24', fc: 100 }, subGain: 0, subInvert: false };

interface C {
  re: number;
  im: number;
}
const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const div = (a: C, b: C): C => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

/** Normalised Butterworth low-pass of order n at s (poles on the unit circle, left half-plane). */
function butterLp(n: number, s: C): C {
  let h: C = { re: 1, im: 0 };
  for (let k = 1; k <= n; k++) {
    const a = (Math.PI * (2 * k + n - 1)) / (2 * n);
    h = div(h, { re: s.re - Math.cos(a), im: s.im - Math.sin(a) });
  }
  return h;
}

function parse(shape: XoverShape): { family: 'bw' | 'lr'; order: number } | null {
  if (shape === 'none') return null;
  const family = shape.startsWith('lr') ? 'lr' : 'bw';
  return { family, order: Math.round(+shape.slice(2) / 6) };
}

/** Complex response of a low- or high-pass at frequency f. */
export function xoverResponse(side: XoverSide, kind: 'lp' | 'hp', f: number): C {
  const p = parse(side.shape);
  if (!p || !(side.fc > 0) || !(f > 0)) return { re: 1, im: 0 };
  const w = f / side.fc;
  // High-pass: s → 1/s
  const s: C = kind === 'lp' ? { re: 0, im: w } : { re: 0, im: -1 / w };
  if (p.family === 'bw') return butterLp(p.order, s);
  // Linkwitz-Riley: a Butterworth of half the order, twice
  const b = butterLp(p.order / 2, s);
  return mul(b, b);
}

/** Level (dB) and phase (deg) of a crossover filter over a frequency grid. */
export function xoverCurve(side: XoverSide, kind: 'lp' | 'hp', freqs: ArrayLike<number>): { db: Float64Array; deg: Float64Array } {
  const db = new Float64Array(freqs.length);
  const deg = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const h = xoverResponse(side, kind, freqs[i]);
    db[i] = 10 * Math.log10(Math.max(1e-30, h.re * h.re + h.im * h.im));
    deg[i] = (Math.atan2(h.im, h.re) * 180) / Math.PI;
  }
  return { db, deg };
}

/** A measured part as it would be with a crossover filter (and level / polarity) in its path. */
export function applyXover(input: AlignInput, side: XoverSide, kind: 'lp' | 'hp', gainDb = 0, invert = false): AlignInput {
  const c = xoverCurve(side, kind, input.freqs);
  return {
    ...input,
    mag: Float64Array.from(input.mag, (v, i) => v + c.db[i] + gainDb),
    phase: Float64Array.from(input.phase, (v, i) => v + c.deg[i] + (invert ? 180 : 0)),
  };
}

/**
 * The crossover on its own: the low-pass and high-pass, and their sum when both are in phase (the parts
 * measured identical and aligned). Shows what the filter choice does before any measurement.
 */
export function idealSum(d: CrossoverDesign, freqs: ArrayLike<number>): { low: Float64Array; high: Float64Array; sum: Float64Array; lowDeg: Float64Array; highDeg: Float64Array } {
  const n = freqs.length;
  const low = new Float64Array(n);
  const high = new Float64Array(n);
  const sum = new Float64Array(n);
  const lowDeg = new Float64Array(n);
  const highDeg = new Float64Array(n);
  const g = Math.pow(10, d.subGain / 20) * (d.subInvert ? -1 : 1);
  for (let i = 0; i < n; i++) {
    const l = xoverResponse(d.low, 'lp', freqs[i]);
    const hgh = xoverResponse(d.high, 'hp', freqs[i]);
    const lr = l.re * g;
    const li = l.im * g;
    low[i] = 10 * Math.log10(Math.max(1e-30, lr * lr + li * li));
    high[i] = 10 * Math.log10(Math.max(1e-30, hgh.re * hgh.re + hgh.im * hgh.im));
    sum[i] = 10 * Math.log10(Math.max(1e-30, (lr + hgh.re) ** 2 + (li + hgh.im) ** 2));
    lowDeg[i] = (Math.atan2(li, lr) * 180) / Math.PI;
    highDeg[i] = (Math.atan2(hgh.im, hgh.re) * 180) / Math.PI;
  }
  return { low, high, sum, lowDeg, highDeg };
}

/** Short label, e.g. "LR 24 @ 100 Hz". */
export function xoverLabel(side: XoverSide): string {
  const p = parse(side.shape);
  if (!p) return 'none';
  return `${p.family === 'lr' ? 'LR' : 'BW'} ${p.order * 6} @ ${Math.round(side.fc)} Hz`;
}
