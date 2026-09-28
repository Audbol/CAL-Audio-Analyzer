import { FFT } from './fft';
import { getWindow } from './windows';
import { BandMap, PrefixSum, rangeSum } from './bands';
import type { Smoothing } from './freq';
import type { RingBuffer } from './ring';

/** Averaging: number of frames in an exponential average, or 0 for infinite (cumulative) averaging. */
export type Averaging = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 0;

export interface TransferResult {
  freqs: Float64Array;
  /** Magnitude in dB (mic relative to reference). */
  mag: Float64Array;
  /** Wrapped phase in degrees. */
  phase: Float64Array;
  /** Magnitude-squared coherence 0..1. */
  coh: Float64Array;
}

interface WindowState {
  size: number;
  hop: number;
  fLo: number;
  fHi: number;
  /** Absolute sample index (on the measurement channel) of the next frame end to process. */
  nextEnd: number;
  frames: number;
  gxx: Float64Array;
  gyy: Float64Array;
  gxyRe: Float64Array;
  gxyIm: Float64Array;
  xr: Float64Array;
  xi: Float64Array;
  yr: Float64Array;
  maps: Map<number, BandMap>;
}

/**
 * Multi-time-window dual-channel FFT transfer function.
 * Each FFT size covers one frequency band so resolution is roughly constant per octave, with long windows at
 * low frequencies and short windows at high frequencies (constant-Q style, like Smaart/OSM "MTW").
 */
export class TransferFunction {
  private windows: WindowState[] = [];
  private prefix = new PrefixSum();
  private tmp = new Float64Array(0);
  averaging: Averaging = 8;
  /** Delay applied to the reference channel, in samples. */
  delay = 0;

  constructor(
    readonly fs: number,
    readonly grid: Float64Array,
  ) {
    // Base sizes for 48 kHz; scaled for other rates so time windows stay similar
    const scale = Math.max(1, Math.round(fs / 48000));
    const base = [32768, 16384, 8192, 4096, 2048, 1024].map((s) => s * scale);
    const cross = [0, 180, 360, 720, 1440, 2880, Infinity];
    this.windows = base.map((size, i) => {
      const bins = size / 2 + 1;
      return {
        size,
        hop: size / 4,
        fLo: cross[i],
        fHi: cross[i + 1],
        nextEnd: -1,
        frames: 0,
        maps: new Map(),
        gxx: new Float64Array(bins),
        gyy: new Float64Array(bins),
        gxyRe: new Float64Array(bins),
        gxyIm: new Float64Array(bins),
        xr: new Float64Array(size),
        xi: new Float64Array(size),
        yr: new Float64Array(size),
      };
    });
  }

  reset(): void {
    for (const w of this.windows) {
      w.frames = 0;
      w.nextEnd = -1;
      w.gxx.fill(0);
      w.gyy.fill(0);
      w.gxyRe.fill(0);
      w.gxyIm.fill(0);
    }
  }

  /** Largest time window in samples (for delay/IR estimation). */
  get maxSize(): number {
    return this.windows[0].size;
  }

  /**
   * Consume all new data available in the ring buffers.
   * `maxFramesPerWindow` bounds the work done per call (keeps the UI responsive).
   */
  process(ref: RingBuffer, mic: RingBuffer, maxFramesPerWindow = 8): void {
    const head = Math.min(ref.written, mic.written);
    for (const w of this.windows) {
      if (w.nextEnd < 0 || head - w.nextEnd > w.size * 4) {
        // (Re)start close to the head – never try to catch up on stale data
        w.nextEnd = Math.max(w.size + this.delay, head - w.size);
      }
      let count = 0;
      while (w.nextEnd <= head && count < maxFramesPerWindow) {
        this.frame(w, ref, mic, w.nextEnd);
        w.nextEnd += w.hop;
        count++;
      }
    }
  }

  private frame(w: WindowState, ref: RingBuffer, mic: RingBuffer, end: number): void {
    const n = w.size;
    const win = getWindow('hann', n);
    const { xr, xi, yr } = w;
    ref.read(end - n - this.delay, n, xr);
    mic.read(end - n, n, yr);
    for (let i = 0; i < n; i++) {
      xr[i] *= win[i];
      yr[i] *= win[i];
    }
    // Two real signals in one complex FFT: z = x + j·y, then X[k] = (Z[k] + Z*[N−k]) / 2, Y[k] = (Z[k] − Z*[N−k]) / 2j
    // (half the work of two transforms, which matters on phones and older remote devices)
    xi.set(yr);
    FFT.get(n).forward(xr, xi);
    const bins = n / 2 + 1;
    w.frames++;
    const a = this.averaging === 0 ? 1 / w.frames : Math.max(1 / this.averaging, 1 / w.frames);
    const b = 1 - a;
    const { gxx, gyy, gxyRe, gxyIm } = w;
    for (let k = 0; k < bins; k++) {
      const m = k === 0 ? 0 : n - k;
      const zr = xr[k];
      const zi = xi[k];
      const cr = xr[m];
      const ci = -xi[m];
      const ar = 0.5 * (zr + cr);
      const ai = 0.5 * (zi + ci);
      const br = 0.5 * (zi - ci);
      const bi = -0.5 * (zr - cr);
      gxx[k] = b * gxx[k] + a * (ar * ar + ai * ai);
      gyy[k] = b * gyy[k] + a * (br * br + bi * bi);
      // Gxy = conj(X) * Y
      gxyRe[k] = b * gxyRe[k] + a * (ar * br + ai * bi);
      gxyIm[k] = b * gxyIm[k] + a * (ar * bi - ai * br);
    }
  }

  /** True once every window has at least one averaged frame. */
  get ready(): boolean {
    return this.windows.every((w) => w.frames > 0);
  }

  /** Produce smoothed magnitude / phase / coherence on the display grid. */
  result(fraction: Smoothing, out?: TransferResult): TransferResult {
    const g = this.grid;
    const n = g.length;
    const res: TransferResult = out ?? {
      freqs: g,
      mag: new Float64Array(n),
      phase: new Float64Array(n),
      coh: new Float64Array(n),
    };
    if (this.tmp.length < n) this.tmp = new Float64Array(n);
    for (const w of this.windows) {
      let map = w.maps.get(fraction);
      if (!map) w.maps.set(fraction, (map = new BandMap(g, w.size, this.fs, fraction)));
      const bins = w.size / 2 + 1;
      const pxx = this.prefix.build(w.gxx, bins).slice();
      const pyy = this.prefix.build(w.gyy, bins).slice();
      const pre = this.prefix.build(w.gxyRe, bins).slice();
      const pim = this.prefix.build(w.gxyIm, bins);
      const { lo, hi } = map;
      for (let i = 0; i < n; i++) {
        const f = g[i];
        if (f < w.fLo || f >= w.fHi) continue;
        const sxx = rangeSum(pxx, lo[i], hi[i]);
        const syy = rangeSum(pyy, lo[i], hi[i]);
        const sr = rangeSum(pre, lo[i], hi[i]);
        const si = rangeSum(pim, lo[i], hi[i]);
        const cross = sr * sr + si * si;
        res.mag[i] = 10 * Math.log10(Math.max(cross, 1e-40) / Math.max(sxx * sxx, 1e-40));
        // Phase of H = Gxy/Gxx equals phase of Gxy (Gxx is real)
        res.phase[i] = (Math.atan2(si, sr) * 180) / Math.PI;
        res.coh[i] = sxx > 0 && syy > 0 ? Math.min(1, cross / (sxx * syy)) : 0;
      }
    }
    return res;
  }

  /**
   * Impulse response estimate from the averaged cross spectrum of the given window index
   * (default: 16k window ≈ 340 ms at 48 kHz). Returned IR is circularly shifted so t=0 sits at `pre` samples.
   */
  impulseResponse(windowIndex = 1, pre = 256): { ir: Float64Array; fs: number; t0: number } {
    const w = this.windows[Math.min(windowIndex, this.windows.length - 1)];
    const n = w.size;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const bins = n / 2;
    for (let k = 0; k <= bins; k++) {
      const d = w.gxx[k];
      const hr = d > 0 ? w.gxyRe[k] / d : 0;
      const hi = d > 0 ? w.gxyIm[k] / d : 0;
      re[k] = hr;
      im[k] = hi;
      if (k > 0 && k < bins) {
        re[n - k] = hr;
        im[n - k] = -hi;
      }
    }
    FFT.get(n).inverse(re, im);
    const ir = new Float64Array(n);
    for (let i = 0; i < n; i++) ir[(i + pre) % n] = re[i];
    return { ir, fs: this.fs, t0: pre };
  }
}
