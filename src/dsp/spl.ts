import { WeightingFilter, type Weighting } from './weighting';
import { ThirdOctaveBank, thirdOctaveCentres } from './octave-bank';

const LOG_CENTRES = thirdOctaveCentres(25, 16000);

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

/** One logging interval, measured sample-exactly by the meter. */
export interface SplRow {
  /** Samples in the row. */
  samples: number;
  leq: number;
  /** Highest Fast level in the row. */
  max: number;
  weighting: Weighting;
  /** Unweighted third-octave band Leq (dB) at `bandCentres`, or null without the band filters. */
  bands: number[] | null;
}

/** 10 points per second of Fast level and 100 ms Leq, recorded by the meter itself (2 minutes). */
const HISTORY_RATE = 10;
const HISTORY_LEN = 120 * HISTORY_RATE;

/**
 * Sound level meter operating on raw samples. `offsetDb` maps dBFS to dB SPL (from calibration);
 * with no calibration the readings are in dBFS (full-scale sine = 0 dB, i.e. RMS referenced +3 dB).
 *
 * Everything here is computed from the samples, never from the display: time weighting and Lmax per sample,
 * the history every 100 ms of audio, and logging rows cut at exact sample boundaries (with third-octave band
 * levels from a filter bank), so results don't depend on how often or how smoothly the screen updates.
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
  private readonly aFast: number;
  private readonly aSlow: number;
  /** Samples processed since the meter was created. */
  samples = 0;
  offsetDb = 0;
  // History ring
  private histFast = new Float32Array(HISTORY_LEN);
  private histLeq = new Float32Array(HISTORY_LEN);
  private histCount = 0;
  private histStep: number;
  private histLeft: number;
  private histSum = 0;
  // Logging rows
  private rowLen = 0;
  private rowLeft = 0;
  private rowSum = 0;
  private rowCount = 0;
  private rowMaxMs = 0;
  private onRow: ((r: SplRow) => void) | null = null;
  private bank: ThirdOctaveBank | null = null;

  constructor(
    readonly fs: number,
    weighting: Weighting = 'A',
  ) {
    this.filter = new WeightingFilter(weighting, fs);
    this.aFast = 1 - Math.exp(-1 / (0.125 * fs));
    this.aSlow = 1 - Math.exp(-1 / (1.0 * fs));
    this.histStep = Math.round(fs / HISTORY_RATE);
    this.histLeft = this.histStep;
  }

  get weighting(): Weighting {
    return this.filter.weighting;
  }

  /** Centres of the logging bands (rows always carry all of them; NaN where the sample rate can't measure). */
  get bandCentres(): number[] {
    return LOG_CENTRES;
  }

  setWeighting(w: Weighting): void {
    if (w === this.filter.weighting) return;
    // A logging row never mixes weightings: finish the current one first
    if (this.onRow && this.rowCount) this.emitRow();
    this.filter = new WeightingFilter(w, this.fs);
    this.resetLeq();
  }

  /**
   * Start logging rows of `seconds` (exact to the sample); `onRow` is called from the audio path as each row
   * completes. Third-octave band levels are measured alongside.
   */
  startRows(seconds: number, onRow: (r: SplRow) => void): void {
    this.rowLen = Math.max(1, Math.round(seconds * this.fs));
    this.rowLeft = this.rowLen;
    this.rowSum = 0;
    this.rowCount = 0;
    this.rowMaxMs = 0;
    this.onRow = onRow;
    this.bank = new ThirdOctaveBank(this.fs);
  }

  /** Stop logging; the unfinished row is delivered if it has at least 0.1 s. */
  stopRows(): void {
    if (this.onRow && this.rowCount >= this.fs * 0.1) this.emitRow();
    this.onRow = null;
    this.bank = null;
  }

  get logging(): boolean {
    return !!this.onRow;
  }

  /** The unfinished row so far (for rolling levels), or null. */
  partialRow(): { samples: number; leq: number } | null {
    return this.onRow && this.rowCount ? { samples: this.rowCount, leq: this.toDb(this.rowSum / this.rowCount) } : null;
  }

  private emitRow(): void {
    const n = this.rowCount;
    // Always the full band list: bands above the sample rate's range (e.g. at 32 kHz) are NaN
    const e = this.bank?.take();
    const bands = e ? LOG_CENTRES.map((_, k) => (k < e.length ? this.toDb(e[k] / n) : NaN)) : null;
    const row: SplRow = { samples: n, leq: this.toDb(this.rowSum / n), max: this.toDb(this.rowMaxMs), weighting: this.filter.weighting, bands };
    this.rowSum = 0;
    this.rowCount = 0;
    this.rowMaxMs = 0;
    this.rowLeft = this.rowLen;
    this.onRow?.(row);
  }

  process(block: ArrayLike<number>): void {
    const n = block.length;
    if (this.buf.length < n) this.buf = new Float64Array(n);
    const y = this.buf;
    this.filter.process(block, y);
    let fast = this.fastMs;
    let slow = this.slowMs;
    let peak = this.peakSinceRead;
    const aF = this.aFast;
    const aS = this.aSlow;
    // The first quarter second after start settles the time weighting: no Lmax from it
    const settle = this.fs * 0.25;
    let i = 0;
    while (i < n) {
      // Up to the next history point or row boundary, whichever comes first
      const end = Math.min(n, i + this.histLeft, this.onRow ? i + this.rowLeft : n);
      let sum = 0;
      let maxMs = 0;
      for (let k = i; k < end; k++) {
        const s = y[k] * y[k];
        fast += aF * (s - fast);
        slow += aS * (s - slow);
        sum += s;
        if (fast > maxMs) maxMs = fast;
        const a = Math.abs(block[k]);
        if (a > peak) peak = a;
      }
      const len = end - i;
      if (this.bank) this.bank.process(block, i, end);
      this.samples += len;
      this.leqSum += sum;
      this.leqCount += len;
      if (this.samples > settle) {
        const mdb = this.toDb(maxMs);
        if (mdb > this.maxFast && this.leqCount > settle) this.maxFast = mdb;
        if (maxMs > this.rowMaxMs) this.rowMaxMs = maxMs;
      }
      // History: Fast level at the point and the Leq of the last 100 ms
      this.histSum += sum;
      this.histLeft -= len;
      if (this.histLeft === 0) {
        const j = this.histCount % HISTORY_LEN;
        this.histFast[j] = this.toDb(fast);
        this.histLeq[j] = this.toDb(this.histSum / this.histStep);
        this.histCount++;
        this.histSum = 0;
        this.histLeft = this.histStep;
      }
      if (this.onRow) {
        this.rowSum += sum;
        this.rowCount += len;
        this.rowLeft -= len;
        if (this.rowLeft === 0) this.emitRow();
      }
      i = end;
    }
    this.fastMs = fast;
    this.slowMs = slow;
    this.peakSinceRead = peak;
    if (peak > this.peakHoldLin) this.peakHoldLin = peak;
  }

  /**
   * The recorded history, oldest first: `t` in seconds relative to now (≤ 0), Fast level and 100 ms Leq.
   * Levels are stored with the calibration of the moment.
   */
  history(): { t: number[]; fast: number[]; leq: number[] } {
    const n = Math.min(this.histCount, HISTORY_LEN);
    const t: number[] = [];
    const fast: number[] = [];
    const leq: number[] = [];
    for (let k = 0; k < n; k++) {
      const idx = this.histCount - n + k;
      t.push((idx + 1 - this.histCount) / HISTORY_RATE);
      fast.push(this.histFast[idx % HISTORY_LEN]);
      leq.push(this.histLeq[idx % HISTORY_LEN]);
    }
    return { t, fast, leq };
  }

  /** Number of history points recorded so far (changes 10 times per second of audio). */
  get historyCount(): number {
    return this.histCount;
  }

  /** Level (dB, calibrated) of a mean-square value. */
  levelOf(meanSquare: number): number {
    return this.toDb(meanSquare);
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
