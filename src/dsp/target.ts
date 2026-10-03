import { TARGETS } from './eq';

/** Frequency range used to level the target to the measurement (the ear's most sensitive, least room-affected range). */
export const LEVEL_RANGE: [number, number] = [250, 4000];

/**
 * The target shape on a frequency grid (dB, 0 at 1 kHz for built-ins; a trace is normalised to its own 1 kHz
 * level). Returns null for 'off' or an unknown target.
 */
export function targetShape(id: string, freqs: ArrayLike<number>, trace?: { freqs: number[]; mag: number[] } | null): Float64Array | null {
  if (!id || id === 'off') return null;
  if (id.startsWith('trace:')) {
    if (!trace || trace.freqs.length < 2) return null;
    const at = (f: number) => interpLog(trace.freqs, trace.mag, f);
    const ref = at(1000);
    return Float64Array.from(freqs, (f) => at(f) - ref);
  }
  const t = TARGETS.find((x) => x.id === id);
  if (!t) return null;
  return Float64Array.from(freqs, (f) => t.at(f));
}

/**
 * Level that puts the target on the measurement: the (coherence-weighted) mean difference over LEVEL_RANGE.
 * Returns null without usable data.
 */
export function targetLevel(freqs: ArrayLike<number>, data: ArrayLike<number>, shape: ArrayLike<number>, weight?: ArrayLike<number> | null): number | null {
  let s = 0;
  let w = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < LEVEL_RANGE[0] || f > LEVEL_RANGE[1] || !Number.isFinite(data[i]) || data[i] < -190) continue;
    const k = weight ? Math.max(0, weight[i]) : 1;
    s += k * (data[i] - shape[i]);
    w += k;
  }
  return w > 1e-6 ? s / w : null;
}

/** Deviation from the target (data − levelled target) summary over a range: RMS and the share within tolerance. */
export function targetDeviation(
  freqs: ArrayLike<number>,
  data: ArrayLike<number>,
  target: ArrayLike<number>,
  tolerance: number,
  fMin = 40,
  fMax = 16000,
): { rms: number; within: number; worst: { f: number; dev: number } } | null {
  let sq = 0;
  let n = 0;
  let inside = 0;
  let worst = { f: 0, dev: 0 };
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f < fMin || f > fMax || !Number.isFinite(data[i]) || data[i] < -190) continue;
    const d = data[i] - target[i];
    sq += d * d;
    n++;
    if (Math.abs(d) <= tolerance) inside++;
    if (Math.abs(d) > Math.abs(worst.dev)) worst = { f, dev: d };
  }
  return n ? { rms: Math.sqrt(sq / n), within: inside / n, worst } : null;
}

export function interpLog(x: ArrayLike<number>, y: ArrayLike<number>, xi: number): number {
  const n = x.length;
  if (xi <= x[0]) return y[0];
  if (xi >= x[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (x[m] <= xi) lo = m;
    else hi = m;
  }
  const t = Math.log(xi / x[lo]) / Math.log(x[hi] / x[lo]);
  return y[lo] + (y[hi] - y[lo]) * t;
}
