/** Message types exchanged between the main thread and the audio worklet. */

export type GeneratorType = 'off' | 'pink' | 'white' | 'sine' | 'sweep';

export interface GeneratorConfig {
  type: GeneratorType;
  /** Level in dBFS (sine-peak referenced; noise has the same RMS as a sine of that level). */
  level: number;
  freq: number;
  /** Output channel indices that carry the signal. */
  outputs: number[];
  polarity: 1 | -1;
}

export type ProcessorMessage =
  | { type: 'generator'; config: GeneratorConfig }
  | { type: 'simulate'; enabled: boolean; distance?: number; rt60?: number }
  | { type: 'play'; id: number; data: Float32Array }
  | { type: 'stopPlay' };

export type ProcessorEvent =
  | { type: 'data'; frame: number; inputs: Float32Array[]; gen: Float32Array }
  | { type: 'playStarted'; id: number; frame: number }
  | { type: 'playEnded'; id: number; frame: number };
