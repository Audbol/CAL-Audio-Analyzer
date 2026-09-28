/**
 * Remote-access wire protocol between the measurement host, the hub (electron/hub.cjs) and remote clients.
 *
 * Audio (host → remotes, binary): 16-byte header + channel-major float32 samples
 *   [0..8)  float64  absolute frame index of the first sample (host capture clock)
 *   [8..10) uint16   channel count (inputs + 1 generator channel, generator last)
 *   [10..12) uint16  samples per channel
 *   [12..16) reserved
 * Byte 12 of every host → remote binary message is its type: 0 = live audio, 1 = sweep result.
 * Sweep result (host → all, binary): [0..4) uint32 meta JSON length, [4..8) uint32 IR length, [12] = 1,
 *   then UTF-8 meta JSON (padded to 4 bytes) and the float32 circular impulse response.
 * Sweep playback (remote → host, binary): uint32 request id + float32 samples. The hub prefixes the sender id.
 *
 * Shared session state lives on the host: traces, sweep results, calibration and measurement setup are sent
 * to the host by any device and broadcast to all of them.
 */

import type { GeneratorConfig } from '../audio/protocol';
import type { MeasurementConfig } from '../state';
import type { MicCalibration } from '../dsp/calibration';
import type { Trace, TraceOp } from '../traces';
import type { Settings } from '../state';

/** The subset of settings that belongs to the measurement setup and is shared by every device. */
export function sharedOf(s: Settings): SharedSettings {
  return { splOffset: s.splOffset, splCalibrated: s.splCalibrated, micCal: s.micCal, tempC: s.tempC, measurements: s.measurements };
}

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

export interface SweepRequest {
  duration: number;
  level: number;
  repeats: number;
  f1: number;
  f2: number;
  measIdx: number;
}

export type RemoteCommand =
  | { t: 'cmd'; cmd: 'hello' }
  | { t: 'cmd'; cmd: 'setGenerator'; config: GeneratorConfig }
  | { t: 'cmd'; cmd: 'start' }
  | { t: 'cmd'; cmd: 'stopPlay' }
  | { t: 'cmd'; cmd: 'sweep'; opts: SweepRequest }
  | { t: 'cmd'; cmd: 'sweepCancel' }
  | { t: 'cmd'; cmd: 'traces'; ops: TraceOp[] }
  | { t: 'cmd'; cmd: 'setShared'; shared: SharedSettings };

export interface SweepProgress {
  t: 'sweepProgress';
  running: boolean;
  frac: number;
  text: string;
}

export interface SweepMeta {
  spec: { fs: number; f1: number; f2: number; duration: number; amplitude: number };
  peak: number;
  fs: number;
  channel: number;
  when: number;
  by: string;
}

export type HubMessage =
  | HostStatus
  | HubInfo
  | { t: 'welcome'; id: number; allowControl: boolean; hostConnected: boolean }
  | { t: 'host'; connected: boolean }
  | { t: 'control'; allowControl: boolean }
  | { t: 'error'; message: string }
  | { t: 'dropped'; blocks: number }
  | { t: 'traces'; traces: Trace[] }
  | SweepProgress
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

export const BIN_AUDIO = 0;
export const BIN_SWEEP = 1;

export function binaryType(buf: ArrayBuffer): number {
  return buf.byteLength > 12 ? new DataView(buf).getUint8(12) : -1;
}

export function encodeSweep(meta: SweepMeta, ir: ArrayLike<number>): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const jsonLen = Math.ceil(json.length / 4) * 4;
  const buf = new ArrayBuffer(AUDIO_HEADER + jsonLen + ir.length * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, json.length, true);
  dv.setUint32(4, ir.length, true);
  dv.setUint8(12, BIN_SWEEP);
  new Uint8Array(buf, AUDIO_HEADER, json.length).set(json);
  new Float32Array(buf, AUDIO_HEADER + jsonLen, ir.length).set(ir);
  return buf;
}

export function decodeSweep(buf: ArrayBuffer): { meta: SweepMeta; ir: Float64Array } {
  const dv = new DataView(buf);
  const jl = dv.getUint32(0, true);
  const irLen = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, AUDIO_HEADER, jl))) as SweepMeta;
  const off = AUDIO_HEADER + Math.ceil(jl / 4) * 4;
  return { meta, ir: Float64Array.from(new Float32Array(buf, off, irLen)) };
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
