/**
 * Analysis worker: the live spectrum (RTA) and transfer function analyzers run here, off the main thread, so
 * drawing never waits for FFTs and FFTs never wait for drawing. The main thread sends every audio block of
 * the channels in use; the worker sends back finished analysis frames, in the same form the measurement host
 * sends to remote devices.
 */
import { MultiSpectrum } from '../dsp/spectrum';
import { TransferFunction } from '../dsp/transfer';
import { RingBuffer } from '../dsp/ring';
import { energyTimeCurve } from '../dsp/acoustics';
import type { FromWorker, ToWorker, WorkerConfig, WorkerFrame, WorkerMeasurement } from './protocol';

/** The worker's global scope (the project's TypeScript setup has the DOM types, not the worker ones). */
const scope = self as unknown as { postMessage(msg: FromWorker, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };

/** ≈ 22 s at 48 kHz: room for the longest analysis window plus the reference delay. */
const RING = 1 << 20;

interface Analyzer {
  m: WorkerMeasurement;
  rta: MultiSpectrum;
  tf: TransferFunction;
  bufs: Float64Array[];
  sentRta: number;
  sentTf: number;
  tfAt: number;
}

let cfg: WorkerConfig | null = null;
const rings = new Map<number, RingBuffer>();
const analyzers = new Map<string, Analyzer>();
/** The measurement whose impulse response the Impulse tab shows, and when it was last sent. */
let impulseFor: { id: string; pre: number } | null = null;
let impulseAt = 0;

/** The impulse response from the averaged transfer function (the same window the main thread would use). */
function sendImpulse(a: Analyzer): void {
  if (!cfg || !a.tf.ready) return;
  const { ir, fs, t0 } = a.tf.impulseResponse(1, impulseFor!.pre);
  const etc = energyTimeCurve(ir);
  const out = { id: a.m.id, resets: a.m.resets, epoch: cfg.epoch, fs, pre: t0, ir: Float32Array.from(ir), etc: Float32Array.from(etc) };
  scope.postMessage({ t: 'impulse', impulse: out }, [out.ir.buffer, out.etc.buffer]);
}

function configure(next: WorkerConfig): void {
  const prev = cfg;
  cfg = next;
  const restart = !prev || prev.epoch !== next.epoch || prev.fs !== next.fs || prev.grid.length !== next.grid.length;
  if (restart) {
    rings.clear();
    analyzers.clear();
  }
  const ids = new Set(next.measurements.map((m) => m.id));
  for (const id of [...analyzers.keys()]) if (!ids.has(id)) analyzers.delete(id);
  for (const m of next.measurements) {
    let a = analyzers.get(m.id);
    const rebuild = !a || a.rta.size !== next.rtaFft || a.rta.lf !== next.lfResolution || a.rta.rate !== next.rate;
    if (!a || rebuild) {
      const tf = a?.tf ?? new TransferFunction(next.fs, next.grid);
      a = { m, rta: new MultiSpectrum(next.fs, next.rtaFft, next.grid, next.lfResolution, next.rate), tf, bufs: Array.from({ length: 7 }, () => new Float64Array(next.grid.length)), sentRta: -1, sentTf: -1, tfAt: 0 };
      analyzers.set(m.id, a);
    }
    // A reset on the main thread, or a different input: start the averages again
    if (a.m.resets !== m.resets || a.m.mic !== m.mic || a.m.ref !== m.ref) {
      a.rta.reset();
      a.tf.reset();
    }
    a.m = m;
    a.rta.averaging = next.rtaAveraging;
    a.tf.averaging = next.tfAveraging;
    a.tf.setLfResolution(next.lfResolution);
    a.tf.delay = Math.max(0, Math.round(m.delay));
  }
}

function ring(ch: number): RingBuffer {
  let r = rings.get(ch);
  if (!r) rings.set(ch, (r = new RingBuffer(RING)));
  return r;
}

function audio(channels: number[], blocks: Float32Array[]): void {
  if (!cfg) return;
  const t0 = performance.now();
  channels.forEach((ch, i) => ring(ch).push(blocks[i]));
  if (cfg.paused) return;
  const frames: WorkerFrame[] = [];
  const now = performance.now();
  for (const a of analyzers.values()) {
    if (!a.m.enabled) continue;
    const mic = rings.get(a.m.mic);
    const ref = rings.get(a.m.ref);
    if (!mic) continue;
    a.rta.process(mic);
    if (ref) a.tf.process(ref, mic);
    // Send when there is a new spectrum, or a new transfer function (at most ~30 a second: the short TF windows
    // update far more often than anyone can see)
    const newRta = a.rta.version !== a.sentRta;
    const newTf = a.tf.version !== a.sentTf && now - a.tfAt >= 33;
    if (!newRta && !newTf) continue;
    a.sentRta = a.rta.version;
    if (newTf) {
      a.sentTf = a.tf.version;
      a.tfAt = now;
    }
    const [rb, rf, pb, pf, mag, phase, coh] = a.bufs;
    const rtaReady = a.rta.main.hasData;
    // Only what changed is computed again (the rest of the frame repeats the last values)
    if (rtaReady && newRta) {
      a.rta.render(48, 'avg', rb);
      a.rta.render(0, 'avg', rf);
      a.rta.render(48, 'peak', pb);
      a.rta.render(0, 'peak', pf);
    }
    const tfReady = a.tf.ready;
    if (tfReady && newTf) a.tf.result(48, { freqs: cfg.grid, mag, phase, coh });
    frames.push({
      id: a.m.id,
      resets: a.m.resets,
      epoch: cfg.epoch,
      tfReady,
      rtaReady,
      arrays: a.bufs.map((b) => Float32Array.from(b)),
      rtaVersion: a.rta.version,
      tfVersion: a.tf.version,
      busyMs: 0,
    });
  }
  // Impulse response for the Impulse tab, about 8 times a second (three long FFTs: kept off the main thread)
  if (impulseFor && now - impulseAt >= 120) {
    const a = analyzers.get(impulseFor.id);
    if (a?.m.enabled) {
      impulseAt = now;
      sendImpulse(a);
    }
  }
  if (!frames.length) return;
  const busy = performance.now() - t0;
  for (const f of frames) f.busyMs = busy;
  const msg: FromWorker = { t: 'frames', frames };
  scope.postMessage(msg, frames.flatMap((f) => f.arrays.map((a) => a.buffer)));
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const msg = e.data;
    if (msg.t === 'config') configure(msg.config);
    else if (msg.t === 'audio') audio(msg.channels, msg.blocks);
    else if (msg.t === 'impulse') impulseFor = msg.id ? { id: msg.id, pre: msg.pre } : null;
  } catch (err) {
    const out: FromWorker = { t: 'error', message: err instanceof Error ? err.message : String(err) };
    scope.postMessage(out);
  }
};
