import { FFT } from './fft';
import { getWindow, powerSum, coherentGain, type WindowType } from './windows';
import { BandMap, PrefixSum, rangeSum } from './bands';
import type { Smoothing } from './freq';
import type { RingBuffer } from './ring';
import type { Averaging } from './transfer';

/**
 * Single-channel real-time spectrum (RTA). Levels are in dBFS where a full-scale sine reads 0 dBFS.
 * With fractional-octave banding, each point is the total power inside the band (true RTA behaviour, so pink
 * noise reads flat). Without banding, each point is the per-bin sine-referenced amplitude (FFT spectrum).
 */
export class SpectrumAnalyzer {
  readonly bins: number;
  readonly power: Float64Array;
  peak: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private frames = 0;
  private nextEnd = -1;
  private map?: BandMap;
  private prefix = new PrefixSum();
  averaging: Averaging = 4;
  window: WindowType = 'hann';

  constructor(
    readonly fs: number,
    readonly size: number,
    readonly grid: Float64Array,
  ) {
    this.bins = size / 2 + 1;
    this.power = new Float64Array(this.bins);
    this.peak = new Float64Array(this.bins);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  reset(): void {
    this.power.fill(0);
    this.peak.fill(0);
    this.frames = 0;
    this.nextEnd = -1;
  }

  resetPeak(): void {
    this.peak.fill(0);
  }

  /** Process new data (hop = size/2). Returns the number of frames processed. */
  process(ring: RingBuffer, maxFrames = 6): number {
    const head = ring.written;
    const hop = this.size / 2;
    if (this.nextEnd < 0 || head - this.nextEnd > this.size * 4) this.nextEnd = Math.max(this.size, head);
    let count = 0;
    while (this.nextEnd <= head && count < maxFrames) {
      this.frame(ring, this.nextEnd);
      this.nextEnd += hop;
      count++;
    }
    return count;
  }

  /** Last single-frame (un-averaged) power, used by the spectrogram. */
  private last?: Float64Array;

  get instantaneous(): Float64Array {
    return this.last ?? this.power;
  }

  private frame(ring: RingBuffer, end: number): void {
    const n = this.size;
    const w = getWindow(this.window, n);
    ring.read(end - n, n, this.re);
    for (let i = 0; i < n; i++) this.re[i] *= w[i];
    this.im.fill(0);
    FFT.get(n).forward(this.re, this.im);
    // Normalise so that the sum of one-sided bin powers equals mean-square*2 (i.e. sine peak² reference)
    const norm = (2 * 2) / (n * powerSum(w));
    this.frames++;
    const a = this.averaging === 0 ? 1 / this.frames : Math.max(1 / this.averaging, 1 / this.frames);
    const b = 1 - a;
    if (!this.last) this.last = new Float64Array(this.bins);
    for (let k = 0; k < this.bins; k++) {
      const p = (this.re[k] * this.re[k] + this.im[k] * this.im[k]) * norm * (k === 0 || k === n / 2 ? 0.5 : 1);
      this.last[k] = p;
      this.power[k] = b * this.power[k] + a * p;
      if (this.power[k] > this.peak[k]) this.peak[k] = this.power[k];
    }
  }

  /**
   * Render onto the display grid. fraction 0 = narrowband spectrum (sine-referenced per-bin amplitude),
   * otherwise fractional octave band power.
   */
  render(fraction: Smoothing, src: 'avg' | 'peak' | 'inst', out: Float64Array): Float64Array {
    const g = this.grid;
    if (!this.map || this.map.fraction !== fraction) this.map = new BandMap(g, this.size, this.fs, fraction);
    const data = src === 'peak' ? this.peak : src === 'inst' ? this.instantaneous : this.power;
    const p = this.prefix.build(data, this.bins);
    const { lo, hi } = this.map;
    if (fraction === 0) {
      // Per-bin: convert the band-power normalisation to a sine-amplitude reading
      const w = getWindow(this.window, this.size);
      const cg = coherentGain(w);
      const enbwBins = powerSum(w) / (this.size * cg * cg);
      // Peak-pick the bins under each display point so tonal components keep their true level
      for (let i = 0; i < g.length; i++) {
        let m = 0;
        for (let k = lo[i]; k <= hi[i]; k++) if (data[k] > m) m = data[k];
        out[i] = 10 * Math.log10(Math.max(m * enbwBins, 1e-30));
      }
    } else {
      for (let i = 0; i < g.length; i++) {
        let s = rangeSum(p, lo[i], hi[i]);
        // Bands narrower than one bin: scale by fractional coverage so pink noise still reads correctly
        const df = this.fs / this.size;
        const f = g[i];
        const bw = f * (Math.pow(2, 1 / (2 * fraction)) - Math.pow(2, -1 / (2 * fraction)));
        const coveredBins = hi[i] - lo[i] + 1;
        if (bw < coveredBins * df) s *= bw / (coveredBins * df);
        out[i] = 10 * Math.log10(Math.max(s, 1e-30));
      }
    }
    return out;
  }

  /** Total broadband level (dBFS, sine referenced) from the averaged spectrum. */
  totalLevel(): number {
    let s = 0;
    for (let k = 1; k < this.bins; k++) s += this.power[k];
    return 10 * Math.log10(Math.max(s, 1e-30));
  }
}
