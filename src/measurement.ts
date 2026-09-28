import { TransferFunction, type TransferResult } from './dsp/transfer';
import { MultiSpectrum } from './dsp/spectrum';
import { findDelay, type DelayEstimate } from './dsp/delay';
import type { AudioEngine } from './audio/engine';
import type { MeasurementConfig, Settings } from './state';
import { gridPpo, regroupBands, smoothTransfer } from './dsp/freq';
import type { AnalysisFrame } from './remote/protocol';

/** Which analyses to run this frame (remote devices skip what no visible view shows). */
export interface AnalysisNeeds {
  rta: boolean;
  tf: boolean;
}

/** Runtime state for one measurement (mic + reference pair): live transfer function and RTA. */
export class Measurement {
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

  constructor(
    public cfg: MeasurementConfig,
    readonly fs: number,
    readonly grid: Float64Array,
    settings: Settings,
  ) {
    this.tf = new TransferFunction(fs, grid);
    this.rta = new MultiSpectrum(fs, settings.rtaFft, grid, settings.lfResolution);
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
    if (this.rta.size !== s.rtaFft || this.rta.lf !== s.lfResolution) {
      this.rta = new MultiSpectrum(this.fs, s.rtaFft, this.grid, s.lfResolution);
      this.rta.averaging = s.rtaAveraging;
    }
  }

  reset(): void {
    this.tf.reset();
    this.rta.reset();
    this.tfReady = false;
    this.tfKey = '';
    this.rtaKey = '';
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
    if (!this.frozen && !this.paused.rta) {
      const key = `${this.rta.version}|${s.rtaSmoothing}|${s.peakHold}|${calId(cal)}`;
      if (key !== this.rtaKey) {
        this.rtaKey = key;
        this.rta.render(s.rtaSmoothing, 'avg', this.rtaOut);
        if (s.peakHold) this.rta.render(s.rtaSmoothing, 'peak', this.rtaPeakOut);
        if (cal) for (let i = 0; i < this.grid.length; i++) {
          this.rtaOut[i] += cal[i];
          this.rtaPeakOut[i] += cal[i];
        }
        this.rtaShown++;
      }
    }
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
    if (key === this.hostKey) return;
    this.hostKey = key;
    rta(f.rtaBands, f.rtaFft, this.rtaOut);
    if (s.peakHold) rta(f.peakBands, f.peakFft, this.rtaPeakOut);
    this.rtaShown++;
    this.tfReady = f.tfReady;
    if (f.tfReady) {
      smoothTransfer(f.mag, f.phase, f.coh, ppo, s.tfSmoothing || 48, this.result.mag, this.result.phase, this.result.coh);
      this.renderDisplay(s, cal);
      this.tfShown++;
    }
  }

  /** Host: uncalibrated fine-resolution arrays for remote devices (see encodeAnalysis). */
  hostArrays(bufs: Float64Array[]): { tfReady: boolean; arrays: Float64Array[] } {
    const [rb, rf, pb, pf, mag, phase, coh] = bufs;
    this.rta.render(48, 'avg', rb);
    this.rta.render(0, 'avg', rf);
    this.rta.render(48, 'peak', pb);
    this.rta.render(0, 'peak', pf);
    const ready = this.tf.ready;
    if (ready) this.tf.result(48, { freqs: this.grid, mag, phase, coh });
    return { tfReady: ready, arrays: bufs };
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
