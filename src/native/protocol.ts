/** Messages between the app page and the native audio host (desktop app: ASIO, Core Audio, JACK / PipeWire, ALSA). */
import type { ProcessorEvent, ProcessorMessage } from '../audio/protocol';

export interface NativeDevice {
  id: number;
  name: string;
  inputs: number;
  outputs: number;
  sampleRates: number[];
  preferredRate: number;
}

export interface NativeOpenOptions {
  api: string;
  device: number;
  sampleRate: number;
  /** Driver buffer size (frames); 0 = the driver's own setting. */
  bufferFrames: number;
  /** Channels to open; 0 = all. */
  inputs: number;
  outputs: number;
  /** Generator signal kept ready ahead of the driver (ms): more survives longer hiccups. */
  safetyMs: number;
}

export interface NativeStreamInfo {
  name: string;
  sampleRate: number;
  bufferFrames: number;
  inputs: number;
  outputs: number;
  /** Driver-reported latency (frames). */
  latency: number;
}

export interface NativeStatus {
  underruns: number;
  overruns: number;
  xruns: number;
  /** Generator signal ready ahead of the driver (ms). */
  queuedMs: number;
}

export type NativeRequest =
  | { t: 'devices'; id: number; api: string }
  | { t: 'open'; id: number; opts: NativeOpenOptions }
  | { t: 'close'; id: number }
  | { t: 'panel'; id: number }
  | { t: 'safety'; ms: number }
  | { t: 'msg'; m: ProcessorMessage };

export type NativeReply =
  | { t: 'hello'; apis: string[]; version: string; error?: string }
  | { t: 'reply'; id: number; ok: boolean; result?: unknown; error?: string }
  | { t: 'ev'; ev: ProcessorEvent }
  | { t: 'status'; status: NativeStatus }
  | { t: 'error'; message: string };
