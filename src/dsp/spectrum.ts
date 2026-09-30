import { FFT } from './fft';
import { windowStats, type WindowType } from './windows';
import { BandMap, PrefixSum, rangeSum } from './bands';
import type { Smoothing } from './freq';
import type { RingBuffer } from './ring';
import { DecimatedRing, decimationFactor, type LfResolution } from './decimate';
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
  /** Windowed input frame. */
  private buf: Float64Array;
  /** Spectrum of the current frame (bins 0…n/2). */
  private sr: Float64Array;
  private si: Float64Array;
  private frames = 0;
  private nextEnd = -1;
  private maps = new Map<number, BandMap>();
  /** Prefix sums per data source, rebuilt only when the data changed (see `version`). */
  private prefixes = new Map<string, { at: number; p: PrefixSum }>();
  /** Changes whenever the averaged data changes (new frame or reset). */
  version = 0;
  averaging: Averaging = 4;
  window: WindowType = 'hann';

  /** Averaging is defined per `avgHop` samples, whatever the frame spacing (see `frame`). */
  private readonly avgScale: number;

  constructor(
    readonly fs: number,
    readonly size: number,
    readonly grid: Float64Array,
    /** Samples between frames (default: 50% overlap). */
    readonly hop = size / 2,
    /**
     * Frame spacing the averaging count refers to (default: 50% overlap). With more overlapped frames the
     * display updates more often while "Avg 4" still averages over the same time.
     */
    avgHop = size / 2,
  ) {
    this.avgScale = Math.max(1, avgHop / hop);
    this.bins = size / 2 + 1;
    this.power = new Float64Array(this.bins);
    this.peak = new Float64Array(this.bins);
    this.buf = new Float64Array(size);
    this.sr = new Float64Array(this.bins);
    this.si = new Float64Array(this.bins);
  }

  reset(): void {
    this.power.fill(0);
    this.peak.fill(0);
    this.frames = 0;
    this.nextEnd = -1;
    this.version++;
  }

  resetPeak(): void {
    this.peak.fill(0);
    this.version++;
  }

  /** Process new data, one frame per hop. Returns the number of frames processed. */
  process(ring: RingBuffer, maxFrames = 12): number {
    const head = ring.written;
    const hop = this.hop;
    // (Re)start at the head, never on data from before the stream began (that would read as silence)
    if (this.nextEnd < 0 || head - this.nextEnd > this.size * 4 || this.nextEnd - head > this.size * 4) this.nextEnd = Math.max(ring.start + this.size, head);
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

  get hasData(): boolean {
    return this.frames > 0;
  }

  get instantaneous(): Float64Array {
    return this.last ?? this.power;
  }

  private frame(ring: RingBuffer, end: number): void {
    const n = this.size;
    const { w, powerSum } = windowStats(this.window, n);
    const x = this.buf;
    ring.read(end - n, n, x);
    for (let i = 0; i < n; i++) x[i] *= w[i];
    // Real-input transform: bins 0…n/2 into (sr, si)
    const sr = this.sr;
    const si = this.si;
    FFT.get(n).forwardReal(x, sr, si);
    // Normalise so that the sum of one-sided bin powers equals mean-square*2 (i.e. sine peak² reference)
    const norm = (2 * 2) / (n * powerSum);
    this.frames++;
    this.version++;
    const a = this.averaging === 0 ? 1 / this.frames : Math.max(1 / (this.averaging * this.avgScale), 1 / this.frames);
    const b = 1 - a;
    const last = (this.last ??= new Float64Array(this.bins));
    const power = this.power;
    const peak = this.peak;
    const bins = this.bins;
    for (let k = 0; k < bins; k++) {
      const p = (sr[k] * sr[k] + si[k] * si[k]) * norm * (k === 0 || k === bins - 1 ? 0.5 : 1);
      last[k] = p;
      const v = b * power[k] + a * p;
      power[k] = v;
      if (v > peak[k]) peak[k] = v;
    }
  }

  /**
   * Render onto the display grid. fraction 0 = narrowband spectrum (sine-referenced per-bin amplitude),
   * otherwise fractional octave band power.
   */
  render(fraction: Smoothing, src: 'avg' | 'peak' | 'inst', out: Float64Array, fLo = 0, fHi = Infinity): Float64Array {
    const g = this.grid;
    let map = this.maps.get(fraction);
    if (!map) this.maps.set(fraction, (map = new BandMap(g, this.size, this.fs, fraction)));
    const data = src === 'peak' ? this.peak : src === 'inst' ? this.instantaneous : this.power;
    const { lo, hi } = map;
    if (fraction === 0) {
      // Per-bin: convert the band-power normalisation to a sine-amplitude reading
      const { powerSum, coherentGain: cg } = windowStats(this.window, this.size);
      const enbwBins = powerSum / (this.size * cg * cg);
      // Peak-pick the bins under each display point so tonal components keep their true level
      for (let i = 0; i < g.length; i++) {
        if (g[i] < fLo || g[i] >= fHi) continue;
        let m = 0;
        for (let k = lo[i]; k <= hi[i]; k++) if (data[k] > m) m = data[k];
        out[i] = 10 * Math.log10(Math.max(m * enbwBins, 1e-30));
      }
    } else {
      let cached = this.prefixes.get(src);
      if (!cached) this.prefixes.set(src, (cached = { at: -1, p: new PrefixSum() }));
      if (cached.at !== this.version) {
        cached.p.build(data, this.bins);
        cached.at = this.version;
      }
      const p = cached.p.values;
      for (let i = 0; i < g.length; i++) {
        if (g[i] < fLo || g[i] >= fHi) continue;
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

/**
 * RTA with optional extra-long analysis windows for the bass (see LfResolution): the main FFT covers everything,
 * and below 160 Hz longer windows computed on a decimated copy of the signal take over, so low-frequency detail
 * improves 4–8× while the mids and highs keep their fast response. The bass windows update as often as the main
 * FFT (heavily overlapped frames, cheap on the decimated signal), so the bass doesn't lag behind, and neighbouring
 * windows are blended over a third of an octave so there is no step where one takes over from the other.
 */
/** Target number of new RTA spectra per second. */
export const RTA_RATE = 25;

export class MultiSpectrum {
  readonly main: SpectrumAnalyzer;
  private low: { sa: SpectrumAnalyzer; fLo: number; fHi: number }[] = [];
  private dec: DecimatedRing | null = null;
  private avg: Averaging = 4;
  private tmp: Float64Array[] = [];

  constructor(
    readonly fs: number,
    readonly size: number,
    readonly grid: Float64Array,
    readonly lf: LfResolution = 'standard',
    /** New spectra per second (battery saver: fewer). */
    readonly rate = RTA_RATE,
  ) {
    // About 25 new spectra per second (a 50%-overlap 16k FFT gives only 6): smooth, responsive display; the
    // averaging still refers to 50%-overlap frames, so "Avg 4" means the same averaging time as before
    const hop = Math.min(size / 2, Math.max(256, Math.round(fs / rate)));
    this.main = new SpectrumAnalyzer(fs, size, grid, hop);
    const scale = Math.max(1, Math.round(fs / 48000));
    const specs = lf === 'max' ? [[131072, 0, 80], [65536, 80, 160]] : lf === 'high' ? [[65536, 0, 160]] : [];
    const d = decimationFactor(fs);
    // Only windows longer than the main FFT add detail
    const useful = specs.filter(([eq]) => eq * scale > size);
    if (!useful.length) return;
    this.dec = new DecimatedRing(fs, d);
    const lowHop = Math.max(32, Math.round(this.main.hop / d)); // same frame rate as the main FFT
    // …and the same averaging time as the main FFT
    const avgHop = size / 2 / d;
    this.low = useful.map(([eq, fLo, fHi]) => ({ sa: new SpectrumAnalyzer(fs / d, (eq * scale) / d, grid, lowHop, avgHop), fLo, fHi }));
    // If only the longest window is dropped, the next one covers down to 0 Hz
    this.low[0].fLo = 0;
  }

  get averaging(): Averaging {
    return this.avg;
  }

  /** Changes whenever any of the analyzers' data changes. */
  get version(): number {
    let v = this.main.version;
    for (const l of this.low) v += l.sa.version;
    return v;
  }

  set averaging(a: Averaging) {
    this.avg = a;
    this.main.averaging = a;
    for (const l of this.low) l.sa.averaging = a;
  }

  reset(): void {
    this.main.reset();
    this.dec?.reset();
    for (const l of this.low) l.sa.reset();
  }

  process(ring: RingBuffer): void {
    this.main.process(ring);
    if (!this.dec) return;
    this.dec.update(ring);
    for (const l of this.low) l.sa.process(this.dec.ring, 64);
  }

  render(fraction: Smoothing, src: 'avg' | 'peak', out: Float64Array): Float64Array {
    this.main.render(fraction, src, out);
    // Bass windows join once they have data (a 128k window needs ≈ 2.7 s for its first frame)
    const segs: { lo: number; hi: number; v: Float64Array }[] = [];
    let pendingLo: number | null = null;
    this.low.forEach((l, k) => {
      if (!l.sa.hasData) {
        pendingLo ??= l.fLo;
        return;
      }
      const lo = pendingLo ?? l.fLo;
      pendingLo = null;
      const v = (this.tmp[k] ??= new Float64Array(this.grid.length));
      l.sa.render(fraction, src, v, lo / XFADE, l.fHi * XFADE);
      segs.push({ lo, hi: l.fHi, v });
    });
    if (!segs.length) return out;
    segs.push({ lo: pendingLo ?? segs[segs.length - 1].hi, hi: Infinity, v: out });
    const g = this.grid;
    const res = this.tmp[this.low.length] ?? (this.tmp[this.low.length] = new Float64Array(g.length));
    for (let i = 0; i < g.length; i++) {
      const b = blendAt(segs, g[i]);
      if (!b) {
        res[i] = out[i];
        continue;
      }
      // Blend band powers (linear), so levels stay correct through the transition
      const p = b.w * Math.pow(10, b.a.v[i] / 10) + (1 - b.w) * Math.pow(10, b.b.v[i] / 10);
      res[i] = 10 * Math.log10(Math.max(p, 1e-30));
    }
    out.set(res);
    return out;
  }
}

/** Half-width of the blend between neighbouring analysis windows (1/6 octave each side). */
export const XFADE = Math.pow(2, 1 / 6);

/**
 * Where two frequency segments meet, a smooth blend over ±1/6 octave: returns the two segments and the weight
 * of the first, or null inside a segment (or outside all of them).
 */
export function blendAt<T extends { lo: number; hi: number }>(segs: T[], f: number): { a: T; b: T; w: number } | null {
  for (let k = 0; k < segs.length - 1; k++) {
    const edge = segs[k].hi;
    if (f >= edge / XFADE && f < edge * XFADE) {
      const t = (Math.log2(f / edge) + 1 / 6) * 3; // 0 … 1 across the transition
      const w = 1 - t * t * (3 - 2 * t); // smoothstep
      return { a: segs[k], b: segs[k + 1], w };
    }
  }
  for (const s of segs) if (f >= s.lo && f < s.hi) return { a: s, b: s, w: 1 };
  return null;
}
