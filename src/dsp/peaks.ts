/** The three ranges the spectrum's peak highlights cover. */
export const PEAK_RANGES = [
  { id: 'low', label: 'Low', from: 20, to: 250 },
  { id: 'mid', label: 'Mid', from: 250, to: 4000 },
  { id: 'high', label: 'High', from: 4000, to: 20000 },
] as const;

export interface RangePeak {
  range: (typeof PEAK_RANGES)[number];
  f: number;
  level: number;
  /** A real local maximum; false when the range has none and this is just its highest point (e.g. a slope). */
  isPeak: boolean;
}

/**
 * The highest peak in each range: the highest local maximum (higher than everything within ±1/6 octave), so
 * a curve that merely rises into the range edge doesn't count. Falls back to the highest point when the range
 * has no local maximum.
 */
export function rangePeaks(freqs: ArrayLike<number>, values: ArrayLike<number>, ranges = PEAK_RANGES): RangePeak[] {
  const out: RangePeak[] = [];
  const n = Math.min(freqs.length, values.length);
  const k = Math.pow(2, 1 / 6);
  for (const range of ranges) {
    let best = -1;
    let top = -1;
    for (let i = 0; i < n; i++) {
      const f = freqs[i];
      const v = values[i];
      if (f < range.from || f >= range.to || !Number.isFinite(v) || v <= -190) continue;
      if (top < 0 || v > values[top]) top = i;
      // Near the ends of the curve there is no telling whether it is a peak: one side can't be seen
      let isPeak = f / k >= freqs[0] && f * k <= freqs[n - 1];
      for (let j = i - 1; j >= 0 && freqs[j] >= f / k; j--) if (values[j] >= v) isPeak = false;
      for (let j = i + 1; isPeak && j < n && freqs[j] <= f * k; j++) if (values[j] > v) isPeak = false;
      if (isPeak && (best < 0 || v > values[best])) best = i;
    }
    const i = best >= 0 ? best : top;
    if (i >= 0) out.push({ range, f: freqs[i], level: values[i], isPeak: best >= 0 });
  }
  return out;
}
