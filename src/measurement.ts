import { TransferFunction, type TransferResult } from './dsp/transfer';
import { SpectrumAnalyzer } from './dsp/spectrum';
import { findDelay, type DelayEstimate } from './dsp/delay';
import type { AudioEngine } from './audio/engine';
import type { MeasurementConfig, Settings } from './state';

/** Runtime state for one measurement (mic + reference pair): live transfer function and RTA. */
export class Measurement {
  tf: TransferFunction;
  rta: SpectrumAnalyzer;
  result: TransferResult;
  rtaOut: Float64Array;
  rtaPeakOut: Float64Array;
  /** Display copies with calibration and polarity applied. */
  mag: Float64Array;
  phase: Float64Array;
  lastDelay: DelayEstimate | null = null;
  frozen = false;

  constructor(
    public cfg: MeasurementConfig,
    readonly fs: number,
    readonly grid: Float64Array,
    settings: Settings,
  ) {
    this.tf = new TransferFunction(fs, grid);
    this.rta = new SpectrumAnalyzer(fs, settings.rtaFft, grid);
    const n = grid.length;
    this.result = { freqs: grid, mag: new Float64Array(n).fill(NaN), phase: new Float64Array(n).fill(NaN), coh: new Float64Array(n) };
    this.rtaOut = new Float64Array(n).fill(-200);
    this.rtaPeakOut = new Float64Array(n).fill(-200);
    this.mag = new Float64Array(n).fill(NaN);
    this.phase = new Float64Array(n).fill(NaN);
    this.applySettings(settings);
  }

  applySettings(s: Settings): void {
    this.tf.averaging = s.tfAveraging;
    this.rta.averaging = s.rtaAveraging;
    if (this.rta.size !== s.rtaFft) {
      this.rta = new SpectrumAnalyzer(this.fs, s.rtaFft, this.grid);
      this.rta.averaging = s.rtaAveraging;
    }
  }

  reset(): void {
    this.tf.reset();
    this.rta.reset();
  }

  process(engine: AudioEngine): void {
    if (!this.cfg.enabled || this.frozen) return;
    const mic = engine.ring(this.cfg.mic);
    const ref = engine.ring(this.cfg.ref);
    if (!mic) return;
    this.rta.process(mic);
    if (ref) {
      this.tf.delay = Math.max(0, Math.round(this.cfg.delay));
      this.tf.process(ref, mic);
    }
  }

  /** Update display arrays. `cal` is a per-grid-point correction in dB (mic calibration). */
  render(s: Settings, cal: Float64Array | null): void {
    if (!this.cfg.enabled) return;
    if (this.tf.ready && !this.frozen) this.tf.result(s.tfSmoothing, this.result);
    const r = this.result;
    for (let i = 0; i < this.grid.length; i++) {
      this.mag[i] = r.mag[i] + (cal ? cal[i] : 0);
      let p = r.phase[i] + (this.cfg.invert ? 180 : 0);
      if (p > 180) p -= 360;
      this.phase[i] = p;
    }
    if (!this.frozen) {
      this.rta.render(s.rtaSmoothing, 'avg', this.rtaOut);
      if (s.peakHold) this.rta.render(s.rtaSmoothing, 'peak', this.rtaPeakOut);
      if (cal) for (let i = 0; i < this.grid.length; i++) {
        this.rtaOut[i] += cal[i];
        this.rtaPeakOut[i] += cal[i];
      }
    }
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
