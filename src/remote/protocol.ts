/**
 * Remote-access wire protocol between the measurement host, the hub (electron/hub.cjs) and remote clients.
 *
 * Audio (host → remotes, binary): 16-byte header + channel-major float32 samples
 *   [0..8)  float64  absolute frame index of the first sample (host capture clock)
 *   [8..10) uint16   channel count (inputs + 1 generator channel, generator last)
 *   [10..12) uint16  samples per channel
 *   [12..16) reserved
 * Sweep playback (remote → host, binary): uint32 request id + float32 samples. The hub prefixes the sender id.
 */

import type { GeneratorConfig } from '../audio/protocol';
import type { MeasurementConfig } from '../state';
import type { MicCalibration } from '../dsp/calibration';

export interface SharedSettings {
  splOffset: number;
  splCalibrated: boolean;
  micCal: MicCalibration | null;
  tempC: number;
  measurements: MeasurementConfig[];
}

export interface HostStatus {
  t: 'status';
  running: boolean;
  sampleRate: number;
  channels: number;
  outputChannels: number;
  deviceLabel: string;
  simulate: boolean;
  generator: GeneratorConfig;
  shared: SharedSettings;
  busy: boolean;
}

export interface HubInfo {
  t: 'hub';
  port: number;
  pin: string;
  allowControl: boolean;
  urls: { url: string; iface: string }[];
  hostname: string;
  clients: { id: number; name: string; address: string; since: number }[];
}

export type RemoteCommand =
  | { t: 'cmd'; cmd: 'hello' }
  | { t: 'cmd'; cmd: 'setGenerator'; config: GeneratorConfig }
  | { t: 'cmd'; cmd: 'start' }
  | { t: 'cmd'; cmd: 'stopPlay' };

export type HubMessage =
  | HostStatus
  | HubInfo
  | { t: 'welcome'; id: number; allowControl: boolean; hostConnected: boolean }
  | { t: 'host'; connected: boolean }
  | { t: 'control'; allowControl: boolean }
  | { t: 'error'; message: string }
  | { t: 'dropped'; blocks: number }
  | { t: 'event'; to: number; ev: { type: 'played'; id: number; start: number; end: number } }
  | (RemoteCommand & { from: number });

export const AUDIO_HEADER = 16;

export function encodeAudio(frame: number, inputs: Float32Array[], gen: Float32Array): ArrayBuffer {
  const len = gen.length;
  const nCh = inputs.length + 1;
  const buf = new ArrayBuffer(AUDIO_HEADER + nCh * len * 4);
  const dv = new DataView(buf);
  dv.setFloat64(0, frame, true);
  dv.setUint16(8, nCh, true);
  dv.setUint16(10, len, true);
  const f = new Float32Array(buf, AUDIO_HEADER);
  inputs.forEach((b, c) => f.set(b.length === len ? b : b.subarray(0, len), c * len));
  f.set(gen, inputs.length * len);
  return buf;
}

export function decodeAudio(buf: ArrayBuffer): { frame: number; inputs: Float32Array[]; gen: Float32Array } {
  const dv = new DataView(buf);
  const frame = dv.getFloat64(0, true);
  const nCh = dv.getUint16(8, true);
  const len = dv.getUint16(10, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) chans.push(new Float32Array(buf, AUDIO_HEADER + c * len * 4, len));
  const gen = chans.pop()!;
  return { frame, inputs: chans, gen };
}
