/**
 * Live average of several measurement mics: the power average per frequency (the spatial average used for
 * system tuning) and the spread between the mics (lowest and highest level).
 */
export interface MicAverage {
  avg: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  /** Mics that contributed. */
  count: number;
}

/**
 * Curves in dB on one grid. Points that are not finite (blanked, no data) are left out for that mic. `weights`:
 * per frequency (e.g. coherence); `scale`: per mic (how much each position counts, 1 = equal).
 */
export function micAverage(curves: ArrayLike<number>[], weights?: (ArrayLike<number> | null)[], scale?: number[]): MicAverage | null {
  if (curves.length < 2) return null;
  const n = curves[0].length;
  const avg = new Float64Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    let w = 0;
    let mn = Infinity;
    let mx = -Infinity;
    curves.forEach((c, k) => {
      const v = c[i];
      if (!Number.isFinite(v) || v < -190) return;
      const wk = (weights?.[k] ? Math.max(0.02, weights[k]![i]) : 1) * Math.max(0, scale?.[k] ?? 1);
      p += wk * Math.pow(10, v / 10);
      w += wk;
      if (!(scale?.[k] === 0)) mn = Math.min(mn, v);
      if (!(scale?.[k] === 0)) mx = Math.max(mx, v);
    });
    avg[i] = w > 0 ? 10 * Math.log10(p / w) : NaN;
    lo[i] = w > 0 ? mn : NaN;
    hi[i] = w > 0 ? mx : NaN;
  }
  return { avg, lo, hi, count: scale ? scale.filter((v, k) => v > 0 && k < curves.length).length : curves.length };
}
