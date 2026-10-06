/** Parametric EQ modelling and automatic EQ suggestion against a target curve. */

export interface PeqFilter {
  /** `highpass`: a Butterworth high-pass (gain and q unused) with `slope` dB/octave. */
  type: 'peak' | 'lowshelf' | 'highshelf' | 'highpass';
  f: number;
  gain: number;
  q: number;
  /** High-pass slope in dB/octave (6 per order). */
  slope?: number;
}

/** A parametric band (bell or shelf), as opposed to a high-pass, which consoles have separately. */
export const isBand = (f: PeqFilter) => f.type !== 'highpass';

/** The order consoles list them in: the high-pass first, then the bands by frequency. */
export const byBand = (a: PeqFilter, b: PeqFilter) => Number(isBand(a)) - Number(isBand(b)) || a.f - b.f;

/** Magnitude in dB of an RBJ-cookbook biquad at frequency f (analog-prototype approximation, fs-independent). */
export function filterDb(flt: PeqFilter, f: number): number {
  if (flt.type === 'highpass') return -10 * Math.log10(1 + Math.pow(flt.f / f, (2 * (flt.slope ?? 12)) / 6));
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
  /** Its shape in numbers (shown as a tooltip). */
  note?: string;
  /** dB offset as a function of frequency. */
  at: (f: number) => number;
}

/**
 * A smooth low shelf: `gain` dB well below `fc`, half of it at `fc`, 0 dB well above; `width` is how many octaves
 * the transition takes (about 80 % of it).
 */
const lowShelf = (f: number, fc: number, gain: number, width = 1) => gain / (1 + Math.pow(2, (2 * Math.log2(f / fc) * 2.2) / width));
/** A smooth high shelf (as `lowShelf`, mirrored). */
const highShelf = (f: number, fc: number, gain: number, width = 1) => lowShelf(fc * fc / f, fc, gain, width);
/** A slope of `dbPerOct` above `fk` (0 below it). */
const slopeAbove = (f: number, fk: number, dbPerOct: number) => (f > fk ? dbPerOct * Math.log2(f / fk) : 0);
/** A second-order high-pass roll-off below `fc` (−3 dB at fc, −12 dB/oct below). */
const highPass2 = (f: number, fc: number) => -10 * Math.log10(1 + Math.pow(fc / f, 4));
/** A broad bell of `gain` dB at `fc`, `width` octaves wide at half gain. */
const bell = (f: number, fc: number, gain: number, width = 2) => gain * Math.exp(-Math.pow(Math.log2(f / fc) / (width / 2), 2) * Math.LN2);

/**
 * Target curves: what a tuned system should measure like at the listening positions (0 dB = the midrange). The
 * live ones are starting points from common practice; the tuning engineer, the music and the room decide the rest.
 */
export const TARGETS: TargetCurve[] = [
  { id: 'flat', label: 'Flat', at: () => 0 },
  {
    id: 'house',
    label: 'House curve',
    note: '+4 dB below 120 Hz, −1 dB/oct above 1 kHz',
    at: (f) => (f > 1000 ? -Math.log2(f / 1000) : 0) + (f < 120 ? 4 * Math.min(1, Math.log2(120 / f) / 1.5) : 0),
  },
  // Live sound
  {
    id: 'live-rock',
    label: 'Live – rock / pop',
    note: '+6 dB below 100 Hz, −1 dB/oct above 2 kHz',
    at: (f) => lowShelf(f, 100, 6, 1.5) + slopeAbove(f, 2000, -1),
  },
  {
    id: 'live-club',
    label: 'Live – club / EDM',
    note: '+10 dB subs below 80 Hz, −1 dB/oct above 3 kHz',
    at: (f) => lowShelf(f, 80, 10, 1.3) + slopeAbove(f, 3000, -1),
  },
  {
    id: 'live-acoustic',
    label: 'Live – jazz / acoustic',
    note: 'Jazz, acoustic and orchestral: +3 dB below 100 Hz, −1 dB/oct above 3 kHz',
    at: (f) => lowShelf(f, 100, 3, 1.5) + slopeAbove(f, 3000, -1),
  },
  {
    id: 'live-worship',
    label: 'Live – worship',
    note: 'Music and speech: +4 dB below 100 Hz, −1 dB/oct above 2 kHz',
    at: (f) => lowShelf(f, 100, 4, 1.5) + slopeAbove(f, 2000, -1),
  },
  {
    id: 'speech',
    label: 'Speech – theatre / conference',
    note: 'Rolled off below 100 Hz (−12 dB/oct), +2 dB presence around 3 kHz, −2 dB/oct above 8 kHz',
    at: (f) => highPass2(f, 100) + bell(f, 3000, 2, 2) + slopeAbove(f, 8000, -2),
  },
  {
    id: 'outdoor',
    label: 'Outdoor / long throw',
    note: '+6 dB below 100 Hz, flat highs (air absorption already takes some)',
    at: (f) => lowShelf(f, 100, 6, 1.5),
  },
  // Rooms and studios
  {
    id: 'preferred-room',
    label: 'Preferred in-room',
    note: 'From listening tests: +6.6 dB below 105 Hz, −2.4 dB above 2.5 kHz',
    at: (f) => lowShelf(f, 105, 6.6, 1.5) + highShelf(f, 2500, -2.4, 2),
  },
  {
    id: 'room-1974',
    label: 'Classic listening room',
    note: 'Flat to 400 Hz, −1 dB/oct above',
    at: (f) => slopeAbove(f, 400, -1),
  },
  { id: 'tilt3', label: 'Tilt −3 dB / decade', note: 'A straight tilt through 0 dB at 1 kHz', at: (f) => -3 * Math.log10(f / 1000) },
  // Cinema
  { id: 'cinema', label: 'X-curve (cinema)', note: 'SMPTE ST 202 / ISO 2969: flat to 2 kHz, −3 dB/oct above', at: (f) => (f > 2000 ? -3 * Math.log2(f / 2000) : 0) },
  { id: 'cinema-small', label: 'X-curve, small room', note: 'Rooms under 150 m³: flat to 2 kHz, −1.5 dB/oct above', at: (f) => slopeAbove(f, 2000, -1.5) },
];

export interface AutoEqOptions {
  fMin: number;
  fMax: number;
  maxFilters: number;
  maxBoost: number;
  maxCut: number;
  /** Minimum coherence for a point to be considered (0..1). */
  minCoherence: number;
  /**
   * High-pass slopes (dB/octave) the assistant may use where the target itself rolls off in the bass (e.g. a
   * speech target): a high-pass there instead of a broad cut. Empty or absent: none.
   */
  hpfSlopes?: number[];
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
  /**
   * Where the system rolls off at the ends of the range (more than 6 dB under the target down to `fMin` or up to
   * `fMax`): those ends are left alone, since boosting a loudspeaker past its range only costs headroom and
   * excursion. null when it doesn't.
   */
  rolloff: { low: number | null; high: number | null };
}

/** A target curve made by the user: levels (dB) at frequencies, joined smoothly on a log-frequency scale. */
export interface CustomTarget {
  id: string;
  name: string;
  /** [frequency (Hz), level (dB)] in rising frequency. */
  points: [number, number][];
}

/** Custom targets prefix their id with this (so they never collide with built-in ones). */
export const CUSTOM_PREFIX = 'custom:';

/** A custom target as a curve: linear in dB between points on a log-frequency scale, level beyond the ends. */
export function customCurve(c: CustomTarget): TargetCurve {
  const pts = [...c.points].filter(([f, v]) => f > 0 && Number.isFinite(f) && Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const at = (f: number) => {
    if (!pts.length) return 0;
    if (f <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (f >= last[0]) return last[1];
    let i = 1;
    while (pts[i][0] < f) i++;
    const [f0, v0] = pts[i - 1];
    const [f1, v1] = pts[i];
    return v0 + ((v1 - v0) * Math.log(f / f0)) / Math.log(f1 / f0);
  };
  return { id: CUSTOM_PREFIX + c.id, label: c.name || 'Custom target', note: `Your target: ${pts.length} points`, at };
}

let customTargets: TargetCurve[] = [];
let customVersion = 0;

/** Use these custom targets (from the settings) alongside the built-in ones. */
export function setCustomTargets(list: CustomTarget[]): void {
  customTargets = list.map(customCurve);
  customVersion++;
}

/** Changes whenever the custom targets do (lists of targets rebuild themselves then). */
export function targetsVersion(): number {
  return customVersion;
}

/** Built-in and custom targets, in the order the lists show them. */
export function allTargets(): TargetCurve[] {
  return [...TARGETS, ...customTargets];
}

export function findTarget(id: string): TargetCurve | undefined {
  return TARGETS.find((t) => t.id === id) ?? customTargets.find((t) => t.id === id);
}

/** Filters of the same kind (both cuts or both boosts) stay at least this far apart (octaves). */
const MIN_SPACING_OCT = 1 / 3;
/** Deeper than this under the target at the ends of the range counts as the system's roll-off (dB). */
const ROLLOFF_DB = -6;

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
  const none = { low: null, high: null };
  if (idx.length < 8) return { filters: [], offset: 0, before, after: before, rmsBefore: 0, rmsAfter: 0, rolloff: none };
  // Level-align: median of deviation
  const dev = idx.map((i) => magDb[i] - target.at(freqs[i]));
  const sorted = [...dev].sort((a, b) => a - b);
  const offset = sorted[Math.floor(sorted.length / 2)];
  for (let i = 0; i < n; i++) before[i] = magDb[i] - offset - target.at(freqs[i]);
  // Every point in the chosen range: the EQ as a whole must stay within the boost and cut limits there
  const range: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] >= opt.fMin && freqs[i] <= opt.fMax) range.push(i);

  // The system's roll-off at either end: not EQ'd. On a 1/3-octave average, the end of the range that is more
  // than 6 dB under the target and keeps falling towards the end (a room dip next to it is not part of it)
  const sm = idx.map((i) => {
    let sum = 0;
    let cnt = 0;
    for (const j of idx) if (Math.abs(Math.log2(freqs[j] / freqs[i])) <= 1 / 6) (sum += before[j]), cnt++;
    return sum / cnt;
  });
  let lo = 0;
  while (lo < idx.length - 1 && sm[lo] <= ROLLOFF_DB) lo++;
  let hi = idx.length - 1;
  while (hi > lo + 1 && sm[hi] <= ROLLOFF_DB) hi--;
  const rolloff = { low: lo > 0 && lo < idx.length ? freqs[idx[lo]] : null, high: hi < idx.length - 1 ? freqs[idx[hi]] : null };
  idx.splice(hi + 1);
  idx.splice(0, lo);
  if (idx.length < 8) return { filters: [], offset, before, after: Float64Array.from(before), rmsBefore: 0, rmsAfter: 0, rolloff };
  const fLo = freqs[idx[0]];
  const fHi = freqs[idx[idx.length - 1]];

  /** The filters together stay within the limits at every frequency of the range. */
  const withinLimits = (fl: PeqFilter[]) => {
    const bands = fl.filter(isBand);
    for (const i of range) {
      let e = 0;
      for (const f of bands) e += filterDb(f, freqs[i]);
      if (e > opt.maxBoost + 0.05 || e < -opt.maxCut - 0.05) return false;
    }
    return true;
  };
  /** Two cuts (or two boosts) don't sit on top of each other. */
  const spaced = (c: PeqFilter, fl: PeqFilter[]) => fl.every((f) => !isBand(f) || Math.sign(f.gain) !== Math.sign(c.gain) || Math.abs(Math.log2(c.f / f.f)) >= MIN_SPACING_OCT);

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

  // Where the target itself rolls off in the bass (6 dB or more over the lowest two octaves of the range), a
  // high-pass shapes it better than a broad cut, and needs no EQ band
  if (opt.hpfSlopes?.length && target.at(opt.fMin) <= target.at(opt.fMin * 4) - 6) {
    const base = err(filters);
    let best: PeqFilter | null = null;
    let bestErr = base - 0.3;
    for (let fc = 20; fc <= Math.min(400, opt.fMax / 4); fc *= Math.pow(2, 1 / 12)) {
      for (const slope of opt.hpfSlopes) {
        const hp: PeqFilter = { type: 'highpass', f: fc, gain: 0, q: 0.707, slope };
        const e = err([hp]);
        if (e < bestErr) (bestErr = e), (best = hp);
      }
    }
    if (best) filters.push({ ...best, f: Math.round(best.f) });
  }

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
    // Within what the filters so far leave of the boost / cut limits, and not on top of a filter of the same kind
    for (let t = 0; t < 8 && Math.abs(cand.gain) >= 0.5 && !withinLimits([...filters, cand]); t++) cand.gain *= 0.7;
    if (Math.abs(cand.gain) < 0.5 || !withinLimits([...filters, cand]) || !spaced(cand, filters)) {
      for (const i of idx) if (Math.abs(Math.log2(freqs[i] / freqs[worst])) < 1 / 6) skip.add(i);
      continue;
    }
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
          trial.f = Math.min(fHi, Math.max(fLo, trial.f));
          if (!spaced(trial, filters) || !withinLimits([...filters, trial])) continue;
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
  filters.sort(byBand);
  const eqr = eqResponse(filters, freqs);
  const after = new Float64Array(n);
  for (let i = 0; i < n; i++) after[i] = before[i] + eqr[i];
  const rms = (arr: Float64Array) => Math.sqrt(idx.reduce((s, i) => s + arr[i] * arr[i], 0) / idx.length);
  return { filters, offset, before, after, rmsBefore: rms(before), rmsAfter: rms(after), rolloff };
}
