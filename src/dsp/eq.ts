/** Parametric EQ modelling and automatic EQ suggestion against a target curve. */

export interface PeqFilter {
  type: 'peak' | 'lowshelf' | 'highshelf';
  f: number;
  gain: number;
  q: number;
}

/** Magnitude in dB of an RBJ-cookbook biquad at frequency f (analog-prototype approximation, fs-independent). */
export function filterDb(flt: PeqFilter, f: number): number {
  const A = Math.pow(10, flt.gain / 40);
  const w = f / flt.f;
  // Evaluate analog prototype H(s) at s = j*w (normalised)
  const s = { re: 0, im: w };
  const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
  const add = (...xs: C[]): C => xs.reduce((p, q) => ({ re: p.re + q.re, im: p.im + q.im }), { re: 0, im: 0 });
  const sc = (a: C, k: number): C => ({ re: a.re * k, im: a.im * k });
  const s2 = mul(s, s);
  const one = { re: 1, im: 0 };
  let num: C;
  let den: C;
  if (flt.type === 'peak') {
    num = add(s2, sc(s, A / flt.q), one);
    den = add(s2, sc(s, 1 / (A * flt.q)), one);
  } else if (flt.type === 'lowshelf') {
    const sq = Math.sqrt(A) / flt.q;
    num = sc(add(s2, sc(s, sq), { re: A, im: 0 }), A);
    den = add(sc(s2, A), sc(s, sq), one);
  } else {
    const sq = Math.sqrt(A) / flt.q;
    num = sc(add(sc(s2, A), sc(s, sq), one), A);
    den = add(s2, sc(s, sq), { re: A, im: 0 });
  }
  return 20 * Math.log10(Math.hypot(num.re, num.im) / Math.hypot(den.re, den.im));
}
interface C {
  re: number;
  im: number;
}

export function eqResponse(filters: PeqFilter[], freqs: ArrayLike<number>): Float64Array {
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    let s = 0;
    for (const f of filters) s += filterDb(f, freqs[i]);
    out[i] = s;
  }
  return out;
}

export interface TargetCurve {
  id: string;
  label: string;
  /** dB offset as a function of frequency. */
  at: (f: number) => number;
}

export const TARGETS: TargetCurve[] = [
  { id: 'flat', label: 'Flat', at: () => 0 },
  {
    id: 'house',
    label: 'House curve (−1 dB/oct above 1 kHz, +4 dB LF)',
    at: (f) => (f > 1000 ? -Math.log2(f / 1000) : 0) + (f < 120 ? 4 * Math.min(1, Math.log2(120 / f) / 1.5) : 0),
  },
  { id: 'tilt3', label: 'Tilt −3 dB / decade', at: (f) => -3 * Math.log10(f / 1000) },
  { id: 'cinema', label: 'X-curve (SMPTE ST 202)', at: (f) => (f > 2000 ? -3 * Math.log2(f / 2000) : 0) },
];

export interface AutoEqOptions {
  fMin: number;
  fMax: number;
  maxFilters: number;
  maxBoost: number;
  maxCut: number;
  /** Minimum coherence for a point to be considered (0..1). */
  minCoherence: number;
  /** Q range the filters may use (default 0.3–10), e.g. a console's limits. */
  qMin?: number;
  qMax?: number;
}

export interface AutoEqResult {
  filters: PeqFilter[];
  /** Offset applied so the measurement aligns to the target (dB). */
  offset: number;
  before: Float64Array;
  after: Float64Array;
  rmsBefore: number;
  rmsAfter: number;
}

/**
 * Greedy PEQ fit: repeatedly place a filter at the largest weighted deviation, then refine (f, gain, Q) by
 * coordinate search to minimise RMS error. Cuts are preferred; boosts are limited (dips are often
 * cancellations that EQ cannot fix, which also usually show as low coherence).
 */
export function autoEq(
  freqs: ArrayLike<number>,
  magDb: ArrayLike<number>,
  coh: ArrayLike<number> | null,
  target: TargetCurve,
  opt: AutoEqOptions,
): AutoEqResult {
  const idx: number[] = [];
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < opt.fMin || freqs[i] > opt.fMax) continue;
    if (coh && coh[i] < opt.minCoherence) continue;
    if (!Number.isFinite(magDb[i])) continue;
    idx.push(i);
  }
  const n = freqs.length;
  const before = new Float64Array(n);
  if (idx.length < 8) return { filters: [], offset: 0, before, after: before, rmsBefore: 0, rmsAfter: 0 };
  // Level-align: median of deviation
  const dev = idx.map((i) => magDb[i] - target.at(freqs[i]));
  const sorted = [...dev].sort((a, b) => a - b);
  const offset = sorted[Math.floor(sorted.length / 2)];
  for (let i = 0; i < n; i++) before[i] = magDb[i] - offset - target.at(freqs[i]);

  const filters: PeqFilter[] = [];
  const err = (fl: PeqFilter[]) => {
    let s = 0;
    for (const i of idx) {
      let e = before[i];
      for (const f of fl) e += filterDb(f, freqs[i]);
      // Penalise residual peaks more than dips
      s += e > 0 ? e * e * 1.5 : e * e;
    }
    return Math.sqrt(s / idx.length);
  };

  // Frequencies where a filter didn't help (e.g. a dip when boosts are off): the fit moves on to the next problem
  const skip = new Set<number>();
  for (let k = 0, tries = 0; k < opt.maxFilters && tries < opt.maxFilters * 4; tries++) {
    // Current residual
    let worst = -1;
    let worstVal = 0;
    for (const i of idx) {
      if (skip.has(i)) continue;
      let e = before[i];
      for (const f of filters) e += filterDb(f, freqs[i]);
      const weighted = e > 0 ? e : e * 0.5;
      // Only what the limits allow: peaks need cuts, dips need boosts
      if ((weighted > 0 && opt.maxCut <= 0) || (weighted < 0 && opt.maxBoost <= 0)) continue;
      if (Math.abs(weighted) > Math.abs(worstVal)) {
        worstVal = weighted;
        worst = i;
      }
    }
    if (worst < 0 || Math.abs(worstVal) < 1.0) break;
    const residual = worstVal > 0 ? worstVal : worstVal * 2;
    const cand: PeqFilter = {
      type: 'peak',
      f: freqs[worst],
      gain: Math.max(-opt.maxCut, Math.min(opt.maxBoost, -residual)),
      q: Math.min(opt.qMax ?? 10, Math.max(opt.qMin ?? 0.3, 2)),
    };
    const base = err(filters);
    // Coordinate search refinement
    let best = err([...filters, cand]);
    const steps = [
      { key: 'f' as const, mul: [0.94, 1.06] },
      { key: 'q' as const, mul: [0.8, 1.25] },
      { key: 'gain' as const, add: [-0.5, 0.5] },
    ];
    for (let iter = 0; iter < 30; iter++) {
      let improved = false;
      for (const st of steps) {
        const opts = 'mul' in st ? st.mul!.map((m) => cand[st.key] * m) : st.add!.map((a) => cand[st.key] + a);
        for (const v of opts) {
          const trial = { ...cand, [st.key]: v } as PeqFilter;
          trial.q = Math.min(opt.qMax ?? 10, Math.max(opt.qMin ?? 0.3, trial.q));
          trial.gain = Math.max(-opt.maxCut, Math.min(opt.maxBoost, trial.gain));
          trial.f = Math.min(opt.fMax, Math.max(opt.fMin, trial.f));
          const e = err([...filters, trial]);
          if (e < best - 1e-4) {
            best = e;
            Object.assign(cand, trial);
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    if (best >= base - 0.02 || Math.abs(cand.gain) < 0.5) {
      // No useful filter here: leave this region (±1/6 octave) and try the next worst point
      for (const i of idx) if (Math.abs(Math.log2(freqs[i] / freqs[worst])) < 1 / 6) skip.add(i);
      continue;
    }
    k++;
    cand.f = Math.round(cand.f * 10) / 10;
    cand.gain = Math.round(cand.gain * 10) / 10;
    cand.q = Math.round(cand.q * 100) / 100;
    filters.push(cand);
  }
  filters.sort((a, b) => a.f - b.f);
  const eqr = eqResponse(filters, freqs);
  const after = new Float64Array(n);
  for (let i = 0; i < n; i++) after[i] = before[i] + eqr[i];
  const rms = (arr: Float64Array) => Math.sqrt(idx.reduce((s, i) => s + arr[i] * arr[i], 0) / idx.length);
  return { filters, offset, before, after, rmsBefore: rms(before), rmsAfter: rms(after) };
}
