/**
 * Sub / main alignment: from two transfer functions measured at the same position with the same reference
 * (the mains alone, then the sub alone), find the delay and polarity for the sub that make them add up best
 * through the crossover region.
 */

export interface AlignInput {
  freqs: ArrayLike<number>;
  /** Magnitude in dB. */
  mag: ArrayLike<number>;
  /** Phase in degrees, as measured (with the measurement's delay compensation removed from it). */
  phase: ArrayLike<number>;
  /** The measurement's delay compensation when captured (ms): added back so both share one time reference. */
  delayMs: number;
  coh?: ArrayLike<number> | null;
}

export interface AlignOptions {
  /** Search range for the sub delay, ± ms. */
  rangeMs?: number;
  /** Crossover region to optimise; null = automatic (where the two are within 10 dB of each other). */
  region?: [number, number] | null;
}

export interface AlignResult {
  /** Delay to add to the sub (ms). Negative: delay the mains by −delayMs instead. */
  delayMs: number;
  /** Polarity for the sub: 1 = normal, −1 = inverted. */
  polarity: 1 | -1;
  region: [number, number];
  /** Crossover frequency (where the two are closest in level). */
  crossover: number;
  /** Summation efficiency in the region, 0…1 (1 = the two add perfectly in phase). Before / after. */
  before: number;
  after: number;
  /** Level gain of the sum over the louder of the two at the crossover (ideal +6 dB for equal levels). */
  gainDb: number;
  /** Frequencies near the crossover where the aligned sum still falls ≥ 3 dB below the louder part. */
  cancellations: number[];
  freqs: Float64Array;
  mainDb: Float64Array;
  subDb: Float64Array;
  sumBeforeDb: Float64Array;
  sumAfterDb: Float64Array;
  /** Phase (deg, wrapped) of the mains and of the aligned sub, on the common time reference. */
  mainPhase: Float64Array;
  subPhase: Float64Array;
}

export function alignSubMain(main: AlignInput, sub: AlignInput, opts: AlignOptions = {}): AlignResult {
  const freqs = Float64Array.from(main.freqs);
  const n = freqs.length;
  const M = toComplex(main, freqs);
  const S = toComplex(sub, freqs);
  const mDb = new Float64Array(n);
  const sDb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    mDb[i] = 10 * Math.log10(Math.max(M.re[i] ** 2 + M.im[i] ** 2, 1e-30));
    sDb[i] = 10 * Math.log10(Math.max(S.re[i] ** 2 + S.im[i] ** 2, 1e-30));
  }
  // Crossover region: where the two are within 10 dB of each other (low frequencies only)
  let region = opts.region ?? null;
  if (!region) {
    // Only where both carry real energy (within 30 dB of the loudest level anywhere)
    let peak = -Infinity;
    for (let i = 0; i < n; i++) peak = Math.max(peak, mDb[i], sDb[i]);
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      const f = freqs[i];
      if (f < 20 || f > 1000 || Math.abs(mDb[i] - sDb[i]) > 10 || Math.min(mDb[i], sDb[i]) < peak - 30) continue;
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
    }
    if (!Number.isFinite(lo) || hi / lo < 1.2) throw new Error('The two responses do not overlap in level anywhere below 1 kHz. Check that the mains and the sub were measured at the same position and level.');
    region = [lo, hi];
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] >= region[0] && freqs[i] <= region[1]) idx.push(i);
  if (idx.length < 3) throw new Error('The crossover region is too narrow.');
  // Weight: equal-level points count most; low coherence counts less
  const w = idx.map((i) => {
    const d = Math.abs(mDb[i] - sDb[i]);
    const c = Math.min(main.coh?.[i] ?? 1, sub.coh?.[i] ?? 1);
    return Math.pow(10, -d / 20) * Math.max(0.05, c);
  });
  const denom = idx.reduce((acc, i, k) => acc + w[k] * (Math.hypot(M.re[i], M.im[i]) + Math.hypot(S.re[i], S.im[i])) ** 2, 0);
  const efficiency = (tau: number, pol: number) => {
    let s = 0;
    idx.forEach((i, k) => {
      const ph = -2 * Math.PI * freqs[i] * tau;
      const c = Math.cos(ph);
      const sn = Math.sin(ph);
      const sr = pol * (S.re[i] * c - S.im[i] * sn);
      const si = pol * (S.re[i] * sn + S.im[i] * c);
      s += w[k] * ((M.re[i] + sr) ** 2 + (M.im[i] + si) ** 2);
    });
    return s / denom;
  };
  const range = (opts.rangeMs ?? 20) / 1000;
  const step = 0.00002; // 20 µs
  // The efficiency over delay has one peak per period of the crossover frequency: collect the peaks
  const peaks: { tau: number; pol: 1 | -1; e: number }[] = [];
  const steps = Math.round((2 * range) / step);
  for (const pol of [1, -1] as const) {
    const e = Array.from({ length: steps + 1 }, (_, k) => efficiency(-range + k * step, pol));
    for (let k = 0; k <= steps; k++) {
      if ((k === 0 || e[k] >= e[k - 1]) && (k === steps || e[k] > e[k + 1])) peaks.push({ tau: -range + k * step, pol, e: e[k] });
    }
  }
  const best = Math.max(...peaks.map((c) => c.e));
  // Several peaks can be almost equally good (one period apart): prefer the smallest change, normal polarity
  const good = peaks.filter((c) => c.e >= best - 0.003);
  good.sort((a, b) => Math.abs(a.tau) - Math.abs(b.tau) || b.pol - a.pol);
  // Refine around the chosen delay
  let pick = good[0];
  for (let t = pick.tau - step; t <= pick.tau + step; t += step / 20) {
    const e = efficiency(t, pick.pol);
    if (e > pick.e) pick = { tau: t, pol: pick.pol, e };
  }
  const sum = (tau: number, pol: number) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const ph = -2 * Math.PI * freqs[i] * tau;
      const sr = pol * (S.re[i] * Math.cos(ph) - S.im[i] * Math.sin(ph));
      const si = pol * (S.re[i] * Math.sin(ph) + S.im[i] * Math.cos(ph));
      out[i] = 10 * Math.log10(Math.max((M.re[i] + sr) ** 2 + (M.im[i] + si) ** 2, 1e-30));
    }
    return out;
  };
  const after = sum(pick.tau, pick.pol);
  let xi = idx[0];
  for (const i of idx) if (Math.abs(mDb[i] - sDb[i]) < Math.abs(mDb[xi] - sDb[xi])) xi = i;
  const crossover = freqs[xi];
  const cancellations: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    if (f < crossover / 2 || f > crossover * 2) continue;
    if (after[i] < Math.max(mDb[i], sDb[i]) - 3) cancellations.push(f);
  }
  const phaseOf = (re: number, im: number) => (Math.atan2(im, re) * 180) / Math.PI;
  const mainPhase = Float64Array.from(freqs, (_, i) => phaseOf(M.re[i], M.im[i]));
  const subPhase = Float64Array.from(freqs, (f, i) => {
    const ph = -2 * Math.PI * f * pick.tau;
    return phaseOf(pick.pol * (S.re[i] * Math.cos(ph) - S.im[i] * Math.sin(ph)), pick.pol * (S.re[i] * Math.sin(ph) + S.im[i] * Math.cos(ph)));
  });
  return {
    delayMs: pick.tau * 1000,
    polarity: pick.pol,
    region,
    crossover,
    before: efficiency(0, 1),
    after: pick.e,
    gainDb: after[xi] - Math.max(mDb[xi], sDb[xi]),
    cancellations,
    freqs,
    mainDb: mDb,
    subDb: sDb,
    sumBeforeDb: sum(0, 1),
    sumAfterDb: after,
    mainPhase,
    subPhase,
  };
}

/** Complex response on `freqs`, with the capture's delay compensation added back into the phase. */
function toComplex(r: AlignInput, freqs: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = freqs.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const src = r.freqs;
  const same = src.length === n && Math.abs(src[0] - freqs[0]) < 1e-6 && Math.abs(src[n - 1] - freqs[n - 1]) < 1e-3;
  // Complex values of the source points (interpolated in log frequency when the grids differ)
  const cre = new Float64Array(src.length);
  const cim = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const a = Math.pow(10, r.mag[i] / 20);
    const ph = (r.phase[i] * Math.PI) / 180 - 2 * Math.PI * src[i] * (r.delayMs / 1000);
    cre[i] = Number.isFinite(a) && Number.isFinite(ph) ? a * Math.cos(ph) : 0;
    cim[i] = Number.isFinite(a) && Number.isFinite(ph) ? a * Math.sin(ph) : 0;
  }
  for (let i = 0; i < n; i++) {
    if (same) {
      re[i] = cre[i];
      im[i] = cim[i];
      continue;
    }
    const f = freqs[i];
    let k = 0;
    while (k < src.length - 2 && src[k + 1] < f) k++;
    const t = Math.min(1, Math.max(0, Math.log(f / src[k]) / Math.log(src[k + 1] / src[k])));
    re[i] = cre[k] + (cre[k + 1] - cre[k]) * t;
    im[i] = cim[k] + (cim[k + 1] - cim[k]) * t;
  }
  return { re, im };
}
