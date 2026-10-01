/**
 * Remote-access wire protocol between the measurement host, the hub (electron/hub.cjs) and remote clients.
 *
 * Audio (host → remotes, binary): 16-byte header + channel-major float32 samples
 *   [0..8)  float64  absolute frame index of the first sample (host capture clock)
 *   [8..10) uint16   channel count (inputs + 1 generator channel, generator last)
 *   [10..12) uint16  samples per channel
 *   [12..16) reserved
 * Byte 12 of every host → remote binary message is its type: 0 = live audio, 1 = sweep result, 2 = analysis.
 * Analysis frame (host → remotes in host-processing mode, binary): [0..4) uint32 grid length n,
 *   [4..6) uint16 measurement count, [12] = 2, then per measurement float32 [index, tfReady, rtaBands, rtaFft,
 *   peakBands, peakFft, tfMag, tfPhase, tfCoh] (each array n long, bands at the grid's 1/48 octave, uncalibrated).
 * Sweep result (host → all, binary): [0..4) uint32 meta JSON length, [4..8) uint32 IR length, [12] = 1,
 *   then UTF-8 meta JSON (padded to 4 bytes) and the float32 circular impulse response.
 * Sweep playback (remote → host, binary): uint32 request id + float32 samples. The hub prefixes the sender id.
 * Song upload (remote → host, binary): uint32 0xFFFFFFFF, uint32 name length, UTF-8 name (padded to 4 bytes),
 *   then the file's bytes. The hub prefixes the sender id.
 *
 * Shared session state lives on the host: traces, sweep results, calibration and measurement setup are sent
 * to the host by any device and broadcast to all of them.
 */

import type { GeneratorConfig } from '../audio/protocol';
import type { MeasurementConfig, MicProfile } from '../state';
import type { MicCalibration } from '../dsp/calibration';
import type { Trace, TraceOp } from '../traces';
import type { Settings } from '../state';
import type { Averaging } from '../dsp/transfer';
import type { LfResolution } from '../dsp/decimate';
import type { PlaylistAction, PlaylistState } from '../audio/playlist';

/** The subset of settings that belongs to the measurement setup and is shared by every device. */
export function sharedOf(s: Settings): SharedSettings {
  return { splOffset: s.splOffset, splCalibrated: s.splCalibrated, micCal: s.micCal, tempC: s.tempC, measurements: s.measurements, mics: s.mics, tuning: tuningOf(s) };
}

/** Tuning display settings every device shows the same way: target curve, average curve, several-mic average. */
export const TUNING_KEYS = ['targetCurve', 'roomTargetCurve', 'targetTolerance', 'rtaAverageCurve', 'rtaAverageSmoothing', 'micAverage'] as const;
export type Tuning = Pick<Settings, (typeof TUNING_KEYS)[number]>;

export function tuningOf(s: Settings): Tuning {
  return { targetCurve: s.targetCurve, roomTargetCurve: s.roomTargetCurve, targetTolerance: s.targetTolerance, rtaAverageCurve: s.rtaAverageCurve, rtaAverageSmoothing: s.rtaAverageSmoothing, micAverage: s.micAverage };
}

export interface SharedSettings {
  splOffset: number;
  splCalibrated: boolean;
  micCal: MicCalibration | null;
  /** Measurement mics (older hosts don't send them). */
  mics?: MicProfile[];
  tempC: number;
  measurements: MeasurementConfig[];
  /** Target and average-curve settings (older versions don't send them). */
  tuning?: Tuning;
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
  /** The host's analysis settings (used by remotes whose analysis runs on the host). */
  analysis?: AnalysisSettings;
  /** Music generator playlist (position rounded to 0.5 s). */
  playlist?: PlaylistState;
}

export interface AnalysisSettings {
  rtaFft: number;
  rtaAveraging: Averaging;
  tfAveraging: Averaging;
  lfResolution?: LfResolution;
}

export interface HubInfo {
  t: 'hub';
  port: number;
  pin: string;
  allowControl: boolean;
  urls: { url: string; iface: string }[];
  hostname: string;
  clients: { id: number; name: string; address: string; since: number; analysis?: boolean }[];
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
  | { t: 'cmd'; cmd: 'setShared'; shared: SharedSettings }
  | { t: 'cmd'; cmd: 'setAnalysis'; analysis: AnalysisSettings }
  | { t: 'cmd'; cmd: 'playlist'; a: PlaylistAction };

/** Remote → hub: what this device wants streamed. */
export interface RemotePrefs {
  t: 'prefs';
  /** Receive analysis frames computed by the host (host-processing mode). */
  analysis: boolean;
}

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
  | { t: 'event'; to: number; ev: { type: 'played'; id: number; start: number; end: number } | { type: 'playFailed'; id: number; message: string } }
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

export const BIN_ANALYSIS = 2;
/** Arrays per measurement in an analysis frame (after the index and tfReady values). */
export const ANALYSIS_ARRAYS = 7;

export interface AnalysisFrame {
  index: number;
  tfReady: boolean;
  /** The host's spectrum analyzer has data (false right after a reset: its arrays are then empty). */
  rtaReady: boolean;
  rtaBands: Float32Array;
  rtaFft: Float32Array;
  peakBands: Float32Array;
  peakFft: Float32Array;
  mag: Float32Array;
  phase: Float32Array;
  coh: Float32Array;
}

/**
 * The flags value carries tfReady and rtaReady so that older versions still read tfReady as `value > 0`:
 * 0 / 1 = TF not ready / ready with the spectrum ready (all that older hosts send); −1 / 2 = the same with the
 * spectrum not ready yet.
 */
function flagsOf(tfReady: boolean, rtaReady: boolean): number {
  return rtaReady ? (tfReady ? 1 : 0) : tfReady ? 2 : -1;
}

export function encodeAnalysis(n: number, items: { index: number; tfReady: boolean; rtaReady?: boolean; arrays: ArrayLike<number>[] }[]): ArrayBuffer {
  const per = 2 + ANALYSIS_ARRAYS * n;
  const buf = new ArrayBuffer(AUDIO_HEADER + items.length * per * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, n, true);
  dv.setUint16(4, items.length, true);
  dv.setUint8(12, BIN_ANALYSIS);
  const f = new Float32Array(buf, AUDIO_HEADER);
  items.forEach((it, j) => {
    const o = j * per;
    f[o] = it.index;
    f[o + 1] = flagsOf(it.tfReady, it.rtaReady ?? true);
    it.arrays.forEach((a, k) => f.set(a, o + 2 + k * n));
  });
  return buf;
}

export function decodeAnalysis(buf: ArrayBuffer): AnalysisFrame[] {
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const count = dv.getUint16(4, true);
  const per = 2 + ANALYSIS_ARRAYS * n;
  const f = new Float32Array(buf, AUDIO_HEADER, count * per);
  const out: AnalysisFrame[] = [];
  for (let j = 0; j < count; j++) {
    const o = j * per;
    const arr = (k: number) => f.subarray(o + 2 + k * n, o + 2 + (k + 1) * n);
    const flags = f[o + 1];
    out.push({ index: f[o], tfReady: flags > 0, rtaReady: flags === 0 || flags === 1, rtaBands: arr(0), rtaFft: arr(1), peakBands: arr(2), peakFft: arr(3), mag: arr(4), phase: arr(5), coh: arr(6) });
  }
  return out;
}

export const UPLOAD_MARKER = 0xffffffff;

export async function encodeUpload(file: File): Promise<ArrayBuffer> {
  const name = new TextEncoder().encode(file.name.slice(0, 200));
  const nl = Math.ceil(name.length / 4) * 4;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const buf = new ArrayBuffer(8 + nl + bytes.length);
  const dv = new DataView(buf);
  dv.setUint32(0, UPLOAD_MARKER, true);
  dv.setUint32(4, name.length, true);
  new Uint8Array(buf, 8, name.length).set(name);
  new Uint8Array(buf, 8 + nl).set(bytes);
  return buf;
}

/** Decode an upload (without the hub's sender prefix). */
export function decodeUpload(buf: ArrayBuffer): File {
  const dv = new DataView(buf);
  const len = dv.getUint32(4, true);
  const name = new TextDecoder().decode(new Uint8Array(buf, 8, len));
  const off = 8 + Math.ceil(len / 4) * 4;
  return new File([buf.slice(off)], name);
}
