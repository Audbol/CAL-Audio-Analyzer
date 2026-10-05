import type { Averaging } from '../dsp/transfer';
import type { LfResolution } from '../dsp/decimate';

/** One measurement as the analysis worker needs it. */
export interface WorkerMeasurement {
  id: string;
  mic: number;
  ref: number;
  /** Reference delay compensation in samples. */
  delay: number;
  enabled: boolean;
  /** Changes when the main thread resets this measurement's averages. */
  resets: number;
}

export interface WorkerConfig {
  fs: number;
  grid: Float64Array;
  /** Changes when audio restarts (the ring buffers start again). */
  epoch: number;
  rtaFft: number;
  lfResolution: LfResolution;
  rtaAveraging: Averaging;
  tfAveraging: Averaging;
  /** New spectra per second. */
  rate: number;
  /** A sweep is running: keep the audio, don't analyse it (the live display keeps its pre-sweep state). */
  paused: boolean;
  measurements: WorkerMeasurement[];
}

export type ToWorker =
  | { t: 'config'; config: WorkerConfig }
  /** One audio block per channel the measurements use (channel numbers as in the engine, −1 = generator). */
  | { t: 'audio'; channels: number[]; blocks: Float32Array[] }
  /** The Impulse tab shows this measurement (null: none): send its impulse response ~8 times a second. */
  | { t: 'impulse'; id: string | null; pre: number };

/** A measurement's impulse response (linear, peak-normalised later) and its energy-time curve (dB). */
export interface WorkerImpulse {
  id: string;
  resets: number;
  epoch: number;
  fs: number;
  /** Samples before time zero. */
  pre: number;
  ir: Float32Array;
  etc: Float32Array;
}

/** The analysis of one measurement, in the format remote devices get from the host (see AnalysisFrame). */
export interface WorkerFrame {
  id: string;
  resets: number;
  epoch: number;
  tfReady: boolean;
  rtaReady: boolean;
  /** RTA (1/48-octave bands, then narrow FFT on the grid), peak hold (same), TF magnitude, phase, coherence. */
  arrays: Float32Array[];
  /** Analyzer frame counters (for tests and diagnostics). */
  rtaVersion: number;
  tfVersion: number;
  /** Time the worker spent on its last audio message (ms). */
  busyMs: number;
}

export type FromWorker = { t: 'frames'; frames: WorkerFrame[] } | { t: 'impulse'; impulse: WorkerImpulse } | { t: 'error'; message: string };
