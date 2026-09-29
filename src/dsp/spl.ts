import { WeightingFilter, type Weighting } from './weighting';

export interface SplReading {
  /** Time-weighted level (Fast or Slow) in dB. */
  level: number;
  fast: number;
  slow: number;
  leq: number;
  /** Maximum time-weighted (fast) level since reset. */
  max: number;
  /** Unweighted peak (Z) since the last reading. */
  peak: number;
  peakHold: number;
  /** Seconds integrated in Leq. */
  duration: number;
}

/**
 * Sound level meter operating on raw samples. `offsetDb` maps dBFS to dB SPL (from calibration);
 * with no calibration the readings are in dBFS (full-scale sine = 0 dB, i.e. RMS referenced +3 dB).
 */
export class SplMeter {
  private filter: WeightingFilter;
  private buf = new Float64Array(0);
  private fastMs = 0;
  private slowMs = 0;
  private leqSum = 0;
  private leqCount = 0;
  private maxFast = -Infinity;
  private peakSinceRead = 0;
  private peakHoldLin = 0;
  /** Energy integrated since the meter was created (never reset by the user), for logging. */
  private totalSum = 0;
  private totalCount = 0;
  private maxSinceTake = -Infinity;
  private readonly aFast: number;
  private readonly aSlow: number;
  offsetDb = 0;

  constructor(
    readonly fs: number,
    weighting: Weighting = 'A',
  ) {
    this.filter = new WeightingFilter(weighting, fs);
    this.aFast = 1 - Math.exp(-1 / (0.125 * fs));
    this.aSlow = 1 - Math.exp(-1 / (1.0 * fs));
  }

  get weighting(): Weighting {
    return this.filter.weighting;
  }

  setWeighting(w: Weighting): void {
    if (w !== this.filter.weighting) {
      this.filter = new WeightingFilter(w, this.fs);
      this.resetLeq();
    }
  }

  process(block: ArrayLike<number>): void {
    const n = block.length;
    if (this.buf.length < n) this.buf = new Float64Array(n);
    const y = this.buf;
    this.filter.process(block, y);
    let fast = this.fastMs;
    let slow = this.slowMs;
    let sum = 0;
    let peak = this.peakSinceRead;
    const aF = this.aFast;
    const aS = this.aSlow;
    for (let i = 0; i < n; i++) {
      const s = y[i] * y[i];
      fast += aF * (s - fast);
      slow += aS * (s - slow);
      sum += s;
      const a = Math.abs(block[i]);
      if (a > peak) peak = a;
    }
    this.fastMs = fast;
    this.slowMs = slow;
    this.leqSum += sum;
    this.leqCount += n;
    this.totalSum += sum;
    this.totalCount += n;
    this.peakSinceRead = peak;
    if (peak > this.peakHoldLin) this.peakHoldLin = peak;
    // Mean-square*2 → sine referenced dBFS
    const fastDb = this.toDb(fast);
    if (fastDb > this.maxFast && this.leqCount > this.fs * 0.25) this.maxFast = fastDb;
    if (fastDb > this.maxSinceTake && this.totalCount > this.fs * 0.25) this.maxSinceTake = fastDb;
  }

  /** Energy integrated since the meter was created: the logger takes differences for exact interval Leq. */
  integrator(): { sum: number; count: number } {
    return { sum: this.totalSum, count: this.totalCount };
  }

  /** Level (dB, calibrated) of a mean-square value. */
  levelOf(meanSquare: number): number {
    return this.toDb(meanSquare);
  }

  /** Highest Fast level since the last call (−∞ if none). */
  takeMax(): number {
    const m = this.maxSinceTake;
    this.maxSinceTake = -Infinity;
    return m;
  }

  private toDb(ms: number): number {
    return 10 * Math.log10(Math.max(ms * 2, 1e-20)) + this.offsetDb;
  }

  read(mode: 'fast' | 'slow' = 'fast'): SplReading {
    const peak = 20 * Math.log10(Math.max(this.peakSinceRead, 1e-10)) + this.offsetDb;
    this.peakSinceRead = 0;
    const fast = this.toDb(this.fastMs);
    const slow = this.toDb(this.slowMs);
    return {
      level: mode === 'fast' ? fast : slow,
      fast,
      slow,
      leq: this.leqCount ? this.toDb(this.leqSum / this.leqCount) : -Infinity,
      max: this.maxFast,
      peak,
      peakHold: 20 * Math.log10(Math.max(this.peakHoldLin, 1e-10)) + this.offsetDb,
      duration: this.leqCount / this.fs,
    };
  }

  resetLeq(): void {
    this.leqSum = 0;
    this.leqCount = 0;
    this.maxFast = -Infinity;
    this.peakHoldLin = 0;
  }
}
