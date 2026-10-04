import { TransferFunction, type TransferResult } from './dsp/transfer';
import { MultiSpectrum, RTA_RATE } from './dsp/spectrum';
import { findDelay, type DelayEstimate } from './dsp/delay';
import type { AudioEngine } from './audio/engine';
import type { MeasurementConfig, Settings } from './state';
import { gaussianSmooth, gridPpo, regroupBands, smoothTransfer } from './dsp/freq';
import type { AnalysisFrame } from './remote/protocol';

/** Which analyses to run this frame (remote devices skip what no visible view shows). */
export interface AnalysisNeeds {
  rta: boolean;
  tf: boolean;
}

/** Runtime state for one measurement (mic + reference pair): live transfer function and RTA. */
export class Measurement {
  /** New RTA spectra per second for every measurement (lowered by the battery saver). */
  static rtaRate = RTA_RATE;
  tf: TransferFunction;
  rta: MultiSpectrum;
  result: TransferResult;
  rtaOut: Float64Array;
  rtaPeakOut: Float64Array;
  /** Display copies with calibration and polarity applied. */
  mag: Float64Array;
  phase: Float64Array;
  lastDelay: DelayEstimate | null = null;
  frozen = false;
  /** True once the transfer function (local or from the host) has data. */
  tfReady = false;
  /** Latest analysis frame computed by the measurement host (remote devices in host-processing mode). */
  hostFrame: AnalysisFrame | null = null;
  hostFrameAt = 0;
  private hostKey = '';
  private paused = { rta: false, tf: false };
  /** What the display arrays were last computed from: recompute only when data or settings changed. */
  private tfKey = '';
  private rtaKey = '';
  private tfAt = 0;
  /** Increase whenever the displayed TF / RTA arrays change (views redraw only then). */
  tfShown = 0;
  rtaShown = 0;
  /** rtaOut holds a real spectrum (not the empty fill from before the first analysis, or after a reset). */
  hasRta = false;
  /** Long-term average of the RTA (power per grid point) for the average curve, and its bookkeeping. */
  private avgPow: Float64Array | null = null;
  private avgDb: Float64Array | null = null;
  private avgCount = 0;
  private avgAt = 0;
  private avgKey = '';
  /** Smoothing of the average curve (1/n octave, 0 = none), from the settings. */
  private avgSmoothing = 6;
  /**
   * Smooth motion: the displayed spectrum glides from the previous one (`glideFrom`) to the newest (`glideTo`)
   * over about the time between two spectra, instead of jumping 25 times a second on a 60 Hz screen.
   */
  private glideFrom: Float64Array | null = null;
  private glideTo: Float64Array | null = null;
  private glideAt = 0;
  private glideDur = 40;
  private lastSpectrumAt = 0;

  constructor(
    public cfg: MeasurementConfig,
    readonly fs: number,
    readonly grid: Float64Array,
    settings: Settings,
  ) {
    this.tf = new TransferFunction(fs, grid);
    this.rta = new MultiSpectrum(fs, settings.rtaFft, grid, settings.lfResolution, Measurement.rtaRate);
    const n = grid.length;
    this.result = { freqs: grid, mag: new Float64Array(n).fill(NaN), phase: new Float64Array(n).fill(NaN), coh: new Float64Array(n) };
    this.rtaOut = new Float64Array(n).fill(-200);
    this.rtaPeakOut = new Float64Array(n).fill(-200);
    this.mag = new Float64Array(n).fill(NaN);
    this.phase = new Float64Array(n).fill(NaN);
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.tfKey = '';
    this.rtaKey = '';
    this.tf.averaging = s.tfAveraging;
    this.rta.averaging = s.rtaAveraging;
    this.tf.setLfResolution(s.lfResolution);
    if (this.rta.size !== s.rtaFft || this.rta.lf !== s.lfResolution || this.rta.rate !== Measurement.rtaRate) {
      this.rta = new MultiSpectrum(this.fs, s.rtaFft, this.grid, s.lfResolution, Measurement.rtaRate);
      this.rta.averaging = s.rtaAveraging;
    }
  }

  reset(): void {
    this.tf.reset();
    this.rta.reset();
    this.tfReady = false;
    this.hasRta = false;
    this.tfKey = '';
    this.rtaKey = '';
    this.resetAverage();
  }

  process(engine: AudioEngine, needs: AnalysisNeeds = { rta: true, tf: true }): void {
    if (!this.cfg.enabled || this.frozen) return;
    const mic = engine.ring(this.cfg.mic);
    const ref = engine.ring(this.cfg.ref);
    if (!mic) return;
    // An analysis that was paused restarts its average so it doesn't show stale data
    if (!needs.rta) this.paused.rta = true;
    else {
      if (this.paused.rta) this.rta.reset();
      this.paused.rta = false;
      this.rta.process(mic);
    }
    if (!needs.tf) this.paused.tf = true;
    else if (ref) {
      if (this.paused.tf) this.tf.reset();
      this.paused.tf = false;
      this.tf.delay = Math.max(0, Math.round(this.cfg.delay));
      this.tf.process(ref, mic);
    }
  }

  /** Update display arrays. `cal` is a per-grid-point correction in dB (mic calibration). */
  render(s: Settings, cal: Float64Array | null): void {
    if (!this.cfg.enabled) return;
    if (this.tf.ready && !this.frozen && !this.paused.tf) {
      // New frames arrive ~6–25 times a second, the display refreshes more often: skip unchanged work
      const key = `${this.tf.version}|${s.tfSmoothing}|${this.cfg.invert}|${calId(cal)}`;
      // The short windows deliver new frames ~190 times a second: refresh the display at up to 30 Hz
      const now = performance.now();
      if (key !== this.tfKey && (now - this.tfAt >= 33 || this.tfKey === '')) {
        this.tfAt = now;
        this.tfKey = key;
        this.tf.result(s.tfSmoothing, this.result);
        this.renderDisplay(s, cal);
        this.tfShown++;
      }
      this.tfReady = true;
    }
    // A just-reset analyzer has no spectrum yet (it would read as −300 dB): keep showing nothing new until it has
    if (!this.frozen && !this.paused.rta && this.rta.main.hasData) {
      const key = `${this.rta.version}|${s.rtaSmoothing}|${s.peakHold}|${calId(cal)}`;
      if (key !== this.rtaKey) {
        // Only a new spectrum glides; a changed setting (smoothing, calibration) shows at once
        const fresh = this.rtaKey.split('|')[0] !== key.split('|')[0] && this.rtaKey.slice(this.rtaKey.indexOf('|')) === key.slice(key.indexOf('|'));
        this.rtaKey = key;
        const to = this.glideTarget();
        this.rta.render(s.rtaSmoothing, 'avg', to);
        if (s.peakHold) this.rta.render(s.rtaSmoothing, 'peak', this.rtaPeakOut);
        if (cal) for (let i = 0; i < this.grid.length; i++) {
          to[i] += cal[i];
          this.rtaPeakOut[i] += cal[i];
        }
        this.startGlide(s, fresh && this.hasRta);
        this.hasRta = true;
        this.updateAverage(s, cal, to);
      }
    }
    this.stepGlide();
  }

  /** The array the newest spectrum is written to (the display array itself when not gliding). */
  private glideTarget(): Float64Array {
    return (this.glideTo ??= new Float64Array(this.grid.length));
  }

  /** A new spectrum is in `glideTo`: glide to it from what is shown now, or jump (stepped, first, changed). */
  private startGlide(s: Settings, glide: boolean): void {
    const now = performance.now();
    // Glide over the time between spectra (measured), so the curve arrives as the next one comes in
    if (this.lastSpectrumAt) this.glideDur = Math.min(150, Math.max(16, 0.7 * this.glideDur + 0.3 * (now - this.lastSpectrumAt)));
    this.lastSpectrumAt = now;
    if (!glide || s.rtaMotion === 'stepped') {
      this.rtaOut.set(this.glideTo!);
      this.glideFrom = null;
      this.rtaShown++;
      return;
    }
    (this.glideFrom ??= new Float64Array(this.grid.length)).set(this.rtaOut);
    this.glideAt = now;
  }

  /** Move the displayed spectrum along its glide (called every drawn frame). */
  private stepGlide(): void {
    const from = this.glideFrom;
    const to = this.glideTo;
    if (!from || !to) return;
    const t = Math.min(1, (performance.now() - this.glideAt) / this.glideDur);
    // Ease out: most of the way early, so the curve feels immediate
    const k = 1 - (1 - t) * (1 - t);
    const out = this.rtaOut;
    for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * k;
    this.rtaShown++;
    if (t >= 1) this.glideFrom = null;
  }

  /** Display arrays from the TF result (calibration and polarity applied). */
  private renderDisplay(_s: Settings, cal: Float64Array | null): void {
    const r = this.result;
    for (let i = 0; i < this.grid.length; i++) {
      this.mag[i] = r.mag[i] + (cal ? cal[i] : 0);
      let p = r.phase[i] + (this.cfg.invert ? 180 : 0);
      if (p > 180) p -= 360;
      this.phase[i] = p;
    }
  }

  /**
   * Average curve: exponential average (in power) of the displayed RTA with the time constant set in the
   * settings, or cumulative for "all". Restarts when the resolution or the mic calibration changes.
   */
  private updateAverage(s: Settings, cal: Float64Array | null, y: Float64Array = this.rtaOut): void {
    const secs = s.rtaAverageCurve;
    if (this.avgSmoothing !== s.rtaAverageSmoothing) {
      this.avgSmoothing = s.rtaAverageSmoothing;
      this.avgDb = null;
    }
    if (!secs) {
      this.avgPow = null;
      return;
    }
    const key = `${s.rtaSmoothing}|${calId(cal)}`;
    if (!this.avgPow || key !== this.avgKey) {
      this.avgPow = new Float64Array(this.grid.length);
      this.avgCount = 0;
      this.avgKey = key;
    }
    const now = performance.now();
    const dt = this.avgCount ? (now - this.avgAt) / 1000 : 0;
    this.avgAt = now;
    this.avgCount++;
    const a = Math.max(1 / this.avgCount, secs > 0 ? 1 - Math.exp(-dt / secs) : 0);
    const p = this.avgPow;
    for (let i = 0; i < p.length; i++) p[i] += a * (Math.pow(10, y[i] / 10) - p[i]);
    this.avgDb = null;
  }

  /** The average curve in dB (same units as rtaOut), or null when off / no data yet. */
  averageDb(): Float64Array | null {
    if (!this.avgPow || !this.avgCount) return null;
    if (!this.avgDb) {
      // Smoothed with a bell-shaped window so the curve reads like the overall tonal balance, without steps
      const pow = gaussianSmooth(this.grid, this.avgPow, this.avgSmoothing);
      this.avgDb = Float64Array.from(pow, (v) => 10 * Math.log10(Math.max(v, 1e-30)));
    }
    return this.avgDb;
  }

  /** RTA updates in the current average (0 after a reset). */
  get averageFrames(): number {
    return this.avgPow ? this.avgCount : 0;
  }

  /** Start the average curve again. */
  resetAverage(): void {
    this.avgPow = null;
    this.avgDb = null;
    this.avgCount = 0;
    this.rtaShown++;
  }

  /** Remote devices: build the display arrays from the host's analysis frame, at this device's smoothing. */
  renderHost(s: Settings, cal: Float64Array | null): void {
    const f = this.hostFrame;
    if (!this.cfg.enabled || !f || this.frozen) return;
    const ppo = gridPpo(this.grid);
    const rta = (bands: Float32Array, fft: Float32Array, out: Float64Array) => {
      if (s.rtaSmoothing === 0) out.set(fft);
      else regroupBands(bands, ppo, s.rtaSmoothing, out);
      if (cal) for (let i = 0; i < out.length; i++) out[i] += cal[i];
    };
    // Host frames arrive ~10 times a second; the display refreshes more often
    const key = `${this.hostFrameAt}|${s.rtaSmoothing}|${s.tfSmoothing}|${s.peakHold}|${this.cfg.invert}|${calId(cal)}`;
    const prev = this.hostKey;
    if (key === prev) return this.stepGlide();
    this.hostKey = key;
    // Frames sent while the host's analyzer had just been reset carry no spectrum (all ≈ −300 dB): skip them,
    // or they'd be drawn (and fitted to) as real data, and a calibration offset lifts them into view. (Real
    // digital silence is data and is shown.)
    if (f.rtaReady) {
      const fresh = prev !== '' && prev.slice(prev.indexOf('|')) === key.slice(key.indexOf('|'));
      const to = this.glideTarget();
      rta(f.rtaBands, f.rtaFft, to);
      if (s.peakHold) rta(f.peakBands, f.peakFft, this.rtaPeakOut);
      // Host frames come ~10–25 times a second: gliding between them matters most here
      this.startGlide(s, fresh && this.hasRta);
      this.hasRta = true;
      // The average curve is built on this device from each new host frame
      this.updateAverage(s, cal, to);
    }
    this.tfReady = f.tfReady;
    if (f.tfReady) {
      smoothTransfer(f.mag, f.phase, f.coh, ppo, s.tfSmoothing || 48, this.result.mag, this.result.phase, this.result.coh);
      this.renderDisplay(s, cal);
      this.tfShown++;
    }
    this.stepGlide();
  }

  /** Host: uncalibrated fine-resolution arrays for remote devices (see encodeAnalysis). */
  hostArrays(bufs: Float64Array[]): { tfReady: boolean; rtaReady: boolean; arrays: Float64Array[] } {
    const [rb, rf, pb, pf, mag, phase, coh] = bufs;
    this.rta.render(48, 'avg', rb);
    this.rta.render(0, 'avg', rf);
    this.rta.render(48, 'peak', pb);
    this.rta.render(0, 'peak', pf);
    const ready = this.tf.ready;
    if (ready) this.tf.result(48, { freqs: this.grid, mag, phase, coh });
    return { tfReady: ready, rtaReady: this.rta.main.hasData, arrays: bufs };
  }

  /** Measure the reference→mic delay from the most recent ~1.4 s of audio. */
  findDelay(engine: AudioEngine, seconds = 1.4): DelayEstimate | null {
    const mic = engine.ring(this.cfg.mic);
    const ref = engine.ring(this.cfg.ref);
    if (!mic || !ref) return null;
    const n = Math.min(1 << Math.ceil(Math.log2(seconds * this.fs)), mic.capacity / 2);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const head = Math.min(mic.written, ref.written);
    // Use a reference window that starts earlier so delays up to half the window are captured
    ref.read(head - n, n, x);
    mic.read(head - n, n, y);
    const est = findDelay(x, y, this.fs, Math.floor(n * 0.75));
    this.lastDelay = est;
    return est;
  }
}

const calIds = new WeakMap<Float64Array, number>();
let nextCalId = 1;

/** Identity of a calibration curve (a new array whenever the calibration changes). */
function calId(cal: Float64Array | null): number {
  if (!cal) return 0;
  let id = calIds.get(cal);
  if (!id) calIds.set(cal, (id = nextCalId++));
  return id;
}

