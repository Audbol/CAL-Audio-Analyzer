import { FFT } from './fft';
import { getWindow } from './windows';
import { BandMap, rangeSum } from './bands';
import type { Smoothing } from './freq';
import type { RingBuffer } from './ring';
import { DecimatedRing, decimationFactor, type LfResolution } from './decimate';
import { XFADE, blendAt } from './spectrum';

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
  /** The analysis window (looked up once: the lookup builds a string key). */
  win: Float64Array;
  /** Sample rate of the data this window analyses (lower for the decimated bass windows). */
  fs: number;
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
  /** Prefix sums of gxx, gyy, gxyRe, gxyIm (for band sums) and the frame count they were built at. */
  pxx: Float64Array;
  pyy: Float64Array;
  pre: Float64Array;
  pim: Float64Array;
  prefixAt: number;
}

/**
 * Multi-time-window dual-channel FFT transfer function.
 * Each FFT size covers one frequency band so resolution is roughly constant per octave, with long windows at
 * low frequencies and short windows at high frequencies (constant-Q style multi-time-window analysis).
 */
export class TransferFunction {
  private windows: WindowState[] = [];
  averaging: Averaging = 8;
  /** Delay applied to the reference channel, in samples. */
  delay = 0;
  /** Extra long bass windows on decimated data (see LfResolution). */
  private lowWindows: WindowState[] = [];
  private decRef: DecimatedRing | null = null;
  private decMic: DecimatedRing | null = null;
  lf: LfResolution = 'standard';
  /** Changes whenever the averaged data changes (new frame or reset): lets callers skip recomputing. */
  version = 0;

  constructor(
    readonly fs: number,
    readonly grid: Float64Array,
  ) {
    // Base sizes for 48 kHz; scaled for other rates so time windows stay similar
    const scale = Math.max(1, Math.round(fs / 48000));
    const base = [32768, 16384, 8192, 4096, 2048, 1024].map((s) => s * scale);
    const cross = [0, 180, 360, 720, 1440, 2880, Infinity];
    // The 16k/32k windows (bass) use 75% overlap so they update often; the short windows already deliver
    // 12–95 frames a second at 50% overlap (plenty for the display) at half the processing cost
    this.windows = base.map((size, i) => newWindow(size, fs, cross[i], cross[i + 1], i < 2 ? size / 4 : size / 2));
  }

  /**
   * Bass resolution: `high` adds a window of 64k (at 48 kHz, ≈ 1.4 s) below 90 Hz; `max` also a 128k window
   * (≈ 2.7 s) below 45 Hz. They run on a decimated copy of both channels, so they cost only a few percent.
   */
  setLfResolution(lf: LfResolution): void {
    if (lf === this.lf && (lf === 'standard' || this.lowWindows.length)) return;
    this.lf = lf;
    const scale = Math.max(1, Math.round(this.fs / 48000));
    const d = decimationFactor(this.fs);
    const fsd = this.fs / d;
    const specs = lf === 'max' ? [[131072, 0, 45], [65536, 45, 90]] : lf === 'high' ? [[65536, 0, 90]] : [];
    // Heavily overlapped frames at the same rate as the 32k window, so the bass is as up to date as the rest
    const hop = Math.max(32, Math.round(this.windows[0].hop / d));
    this.lowWindows = specs.map(([size, lo, hi]) => newWindow((size * scale) / d, fsd, lo, hi, hop));
    this.windows[0].fLo = specs.length ? 90 : 0;
    this.decRef = specs.length ? new DecimatedRing(this.fs, d, this.delay) : null;
    this.decMic = specs.length ? new DecimatedRing(this.fs, d) : null;
  }

  reset(): void {
    this.decRef?.reset();
    this.decMic?.reset();
    for (const w of [...this.windows, ...this.lowWindows]) resetWindow(w);
    this.version++;
  }

  /** Largest time window in samples (for delay/IR estimation). */
  get maxSize(): number {
    return this.windows[0].size;
  }

  /**
   * Consume all new data available in the ring buffers.
   * `maxFramesPerWindow` bounds the work done per call (keeps the UI responsive).
   */
  process(ref: RingBuffer, mic: RingBuffer, maxFramesPerWindow = 8, onlyWindow?: number): void {
    const head = Math.min(ref.written, mic.written);
    // One window only (e.g. for the impulse response while the full analysis runs elsewhere)
    if (onlyWindow !== undefined) {
      const w = this.windows[Math.min(onlyWindow, this.windows.length - 1)];
      return this.run(w, ref, mic, head, this.delay, maxFramesPerWindow);
    }
    for (const w of this.windows) this.run(w, ref, mic, head, this.delay, maxFramesPerWindow);
    if (!this.lowWindows.length || !this.decRef || !this.decMic) return;
    // Bass windows: the reference delay is applied before decimation, so it stays sample-exact
    if (this.decRef.offset !== this.delay) {
      this.decRef.offset = this.delay;
      this.decRef.reset();
      this.decMic.reset();
      for (const w of this.lowWindows) resetWindow(w);
      this.version++;
    }
    this.decRef.update(ref);
    this.decMic.update(mic);
    const dHead = Math.min(this.decRef.ring.written, this.decMic.ring.written);
    for (const w of this.lowWindows) this.run(w, this.decRef.ring, this.decMic.ring, dHead, 0, maxFramesPerWindow);
  }

  private run(w: WindowState, ref: RingBuffer, mic: RingBuffer, head: number, delay: number, maxFrames: number): void {
    if (w.nextEnd < 0 || head - w.nextEnd > w.size * 4 || w.nextEnd - head > w.size * 4) {
      // (Re)start close to the head – never try to catch up on stale data, and never use samples from before
      // the stream began (they read as silence and would pull the average down)
      w.nextEnd = Math.max(w.size + delay + ref.start, w.size + mic.start, head - w.size);
    }
    let count = 0;
    while (w.nextEnd <= head && count < maxFrames) {
      this.frame(w, ref, mic, w.nextEnd, delay);
      w.nextEnd += w.hop;
      count++;
    }
  }

  private frame(w: WindowState, ref: RingBuffer, mic: RingBuffer, end: number, delay: number): void {
    const n = w.size;
    const win = w.win;
    const { xr, xi, yr } = w;
    ref.read(end - n - delay, n, xr);
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
    // Averaging is specified in frames at 75% overlap; windows with larger hops weight each frame more so
    // the averaging time stays the same
    const k = w.hop / (w.size / 4);
    const a = this.averaging === 0 ? 1 / w.frames : Math.max(k === 1 ? 1 / this.averaging : 1 - Math.pow(1 - 1 / this.averaging, k), 1 / w.frames);
    const b = 1 - a;
    this.version++;
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

  /** One window has data (see `process(…, onlyWindow)`). */
  windowReady(index: number): boolean {
    return (this.windows[Math.min(index, this.windows.length - 1)]?.frames ?? 0) > 0;
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
    // Bass windows join once they have data; until then the next window covers their range
    const segs: { lo: number; hi: number; w: WindowState; k: number }[] = [];
    let pendingLo: number | null = null;
    for (const w of [...this.lowWindows, ...this.windows]) {
      if (w.frames === 0 && this.lowWindows.includes(w)) {
        pendingLo ??= w.fLo;
        continue;
      }
      segs.push({ lo: pendingLo ?? w.fLo, hi: w.fHi, w, k: segs.length });
      pendingLo = null;
    }
    // Each window's H (real, imaginary) and coherence over its range plus the blend zones
    while (this.segBufs.length < segs.length * 3) this.segBufs.push(new Float64Array(n));
    for (const sg of segs) {
      const w = sg.w;
      let map = w.maps.get(fraction);
      if (!map) w.maps.set(fraction, (map = new BandMap(g, w.size, w.fs, fraction)));
      // Prefix sums only change with new frames: rebuild them then, not on every call
      if (w.prefixAt !== w.frames) {
        prefixSum(w.gxx, w.pxx);
        prefixSum(w.gyy, w.pyy);
        prefixSum(w.gxyRe, w.pre);
        prefixSum(w.gxyIm, w.pim);
        w.prefixAt = w.frames;
      }
      const { pxx, pyy, pre, pim } = w;
      const { lo, hi } = map;
      const [hr, hi2, hc] = [this.segBufs[sg.k * 3], this.segBufs[sg.k * 3 + 1], this.segBufs[sg.k * 3 + 2]];
      const f0 = sg.lo / XFADE;
      const f1 = sg.hi * XFADE;
      for (let i = 0; i < n; i++) {
        const f = g[i];
        if (f < f0 || f >= f1) continue;
        const sxx = rangeSum(pxx, lo[i], hi[i]);
        const syy = rangeSum(pyy, lo[i], hi[i]);
        const sr = rangeSum(pre, lo[i], hi[i]);
        const si = rangeSum(pim, lo[i], hi[i]);
        const d = Math.max(sxx, 1e-40);
        // H = Gxy / Gxx
        hr[i] = sr / d;
        hi2[i] = si / d;
        hc[i] = sxx > 0 && syy > 0 ? Math.min(1, (sr * sr + si * si) / (sxx * syy)) : 0;
      }
    }
    for (let i = 0; i < n; i++) {
      const bl = blendAt(segs, g[i]);
      if (!bl) continue;
      const A = bl.a.k * 3;
      const B = bl.b.k * 3;
      const wa = bl.w;
      const wb = 1 - wa;
      const [ar, ai] = [this.segBufs[A][i], this.segBufs[A + 1][i]];
      const [br, bi] = [this.segBufs[B][i], this.segBufs[B + 1][i]];
      // Blend level in dB and phase as a direction, so windows that disagree slightly never cancel
      const ma = Math.max(ar * ar + ai * ai, 1e-40);
      const mb = Math.max(br * br + bi * bi, 1e-40);
      res.mag[i] = wa * 10 * Math.log10(ma) + wb * 10 * Math.log10(mb);
      const ua = wa / Math.sqrt(ma);
      const ub = wb / Math.sqrt(mb);
      res.phase[i] = (Math.atan2(ai * ua + bi * ub, ar * ua + br * ub) * 180) / Math.PI;
      res.coh[i] = wa * this.segBufs[A + 2][i] + wb * this.segBufs[B + 2][i];
    }
    return res;
  }

  private segBufs: Float64Array[] = [];

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

function newWindow(size: number, fs: number, fLo: number, fHi: number, hop = size / 4): WindowState {
  const bins = size / 2 + 1;
  return {
    size,
    fs,
    hop,
    fLo,
    fHi,
    nextEnd: -1,
    frames: 0,
    win: getWindow('hann', size),
    maps: new Map(),
    pxx: new Float64Array(bins + 1),
    pyy: new Float64Array(bins + 1),
    pre: new Float64Array(bins + 1),
    pim: new Float64Array(bins + 1),
    prefixAt: -1,
    gxx: new Float64Array(bins),
    gyy: new Float64Array(bins),
    gxyRe: new Float64Array(bins),
    gxyIm: new Float64Array(bins),
    xr: new Float64Array(size),
    xi: new Float64Array(size),
    yr: new Float64Array(size),
  };
}

function prefixSum(v: Float64Array, out: Float64Array): void {
  let s = 0;
  out[0] = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    out[i + 1] = s;
  }
}

function resetWindow(w: WindowState): void {
  w.frames = 0;
  w.prefixAt = -1;
  w.nextEnd = -1;
  w.gxx.fill(0);
  w.gyy.fill(0);
  w.gxyRe.fill(0);
  w.gxyIm.fill(0);
}
