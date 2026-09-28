import type { Smoothing } from './freq';

/**
 * Precomputed mapping from a log-frequency display grid to FFT bin ranges, for a given FFT size and
 * fractional-octave smoothing width. Averages are computed with prefix sums: O(bins + grid).
 */
export class BandMap {
  readonly lo: Int32Array;
  readonly hi: Int32Array;

  constructor(
    readonly grid: Float64Array,
    readonly fftSize: number,
    readonly fs: number,
    readonly fraction: Smoothing,
  ) {
    const n = grid.length;
    this.lo = new Int32Array(n);
    this.hi = new Int32Array(n);
    const df = fs / fftSize;
    const maxBin = fftSize / 2;
    const gridStep = n > 1 ? Math.log2(grid[1] / grid[0]) : 1 / 48;
    const width = fraction > 0 ? Math.max(1 / fraction, gridStep) : gridStep;
    const half = Math.pow(2, width / 2);
    for (let i = 0; i < n; i++) {
      const f = grid[i];
      let a = Math.ceil(f / half / df);
      let b = Math.floor((f * half) / df);
      if (b < a) {
        // Band narrower than a bin: use the nearest bin
        a = b = Math.round(f / df);
      }
      this.lo[i] = Math.min(Math.max(a, 1), maxBin);
      this.hi[i] = Math.min(Math.max(b, 1), maxBin);
    }
  }
}

/** Prefix-sum helper reused across frames. */
export class PrefixSum {
  private buf = new Float64Array(0);

  build(values: ArrayLike<number>, n: number): Float64Array {
    if (this.buf.length !== n + 1) this.buf = new Float64Array(n + 1);
    const p = this.buf;
    p[0] = 0;
    for (let i = 0; i < n; i++) p[i + 1] = p[i] + values[i];
    return p;
  }
}

export function rangeSum(prefix: Float64Array, lo: number, hi: number): number {
  return prefix[hi + 1] - prefix[lo];
}
