import { interpLog, targetDeviation, targetLevel, LEVEL_RANGE } from './target';

export interface CompareCurve {
  freqs: ArrayLike<number>;
  mag: ArrayLike<number>;
  /** Display offset (dB) of the trace. */
  offset?: number;
}

export interface CompareResult {
  before: Float64Array;
  after: Float64Array;
  /** After − before (dB). */
  diff: Float64Array;
  /** The target levelled to each curve (null without a target). */
  targetBefore: Float64Array | null;
  targetAfter: Float64Array | null;
  /** How far each curve is from its target over [fMin, fMax]: RMS (dB), share within ±tolerance, worst point. */
  devBefore: ReturnType<typeof targetDeviation>;
  devAfter: ReturnType<typeof targetDeviation>;
  /** Level shift applied to "before" so both sit at the same level (0 when not matched). */
  shift: number;
}

/** Mean level over the levelling range (250 Hz–4 kHz), for matching two curves. */
function meanLevel(freqs: ArrayLike<number>, y: ArrayLike<number>): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < LEVEL_RANGE[0] || freqs[i] > LEVEL_RANGE[1] || !Number.isFinite(y[i])) continue;
    s += y[i];
    n++;
  }
  return n ? s / n : NaN;
}

/**
 * Before/after comparison of two responses on a common grid: both curves, their difference and how far each is
 * from the target (each levelled to its own curve, so a level change alone does not count as an improvement).
 * With `matchLevels`, "before" is moved to the level of "after" so the difference shows only the change in shape.
 */
export function compareCurves(
  grid: ArrayLike<number>,
  before: CompareCurve,
  after: CompareCurve,
  shape: ArrayLike<number> | null,
  opts: { fMin: number; fMax: number; tolerance: number; matchLevels: boolean },
): CompareResult {
  const n = grid.length;
  const lo = (c: CompareCurve) => c.freqs[0];
  const hi = (c: CompareCurve) => c.freqs[c.freqs.length - 1];
  const sample = (c: CompareCurve) => Float64Array.from(grid, (f) => (f < lo(c) || f > hi(c) ? NaN : interpLog(c.freqs, c.mag, f) + (c.offset ?? 0)));
  const b = sample(before);
  const a = sample(after);
  let shift = 0;
  if (opts.matchLevels) {
    const d = meanLevel(grid, a) - meanLevel(grid, b);
    if (Number.isFinite(d)) {
      shift = d;
      for (let i = 0; i < n; i++) b[i] += d;
    }
  }
  const diff = Float64Array.from(a, (v, i) => v - b[i]);
  const levelled = (y: Float64Array) => {
    if (!shape) return null;
    const l = targetLevel(grid, y, shape);
    return l === null ? null : Float64Array.from(shape, (v) => v + l);
  };
  const tb = levelled(b);
  const ta = levelled(a);
  return {
    before: b,
    after: a,
    diff,
    targetBefore: tb,
    targetAfter: ta,
    devBefore: tb ? targetDeviation(grid, b, tb, opts.tolerance, opts.fMin, opts.fMax) : null,
    devAfter: ta ? targetDeviation(grid, a, ta, opts.tolerance, opts.fMin, opts.fMax) : null,
    shift,
  };
}
