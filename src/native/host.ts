/**
 * Native audio host: runs in an Electron utility process next to the native audio module (ASIO on Windows, Core Audio on macOS,
 * JACK / PipeWire and ALSA on Linux).
 * It generates the measurement signal (the same generator as the browser audio worklet), keeps the driver's
 * output supplied a little ahead, and streams the captured inputs together with the generator signal that was
 * actually played (the internal reference) to the app page in 1024-frame blocks, like the audio worklet does.
 *
 * Built to dist-electron/native-host.cjs (see vite.native.config.ts).
 */
import { GeneratorCore } from '../audio/gen-core';
import type { ProcessorEvent } from '../audio/protocol';
import type { NativeOpenOptions, NativeReply, NativeRequest, NativeStatus, NativeStreamInfo } from './protocol';

interface ReadResult {
  data: Float32Array;
  frames: number;
  played: number;
  consumed: number;
  silent: number;
  underruns: number;
  overruns: number;
  xruns: number;
  queued: number;
  /** Two devices: the servo's net correction (samples dropped − repeated) and the input frames so far. */
  drift?: number;
  inputFrames?: number;
}

interface Addon {
  apis(): string[];
  devices(api: string): unknown[];
  open(opts: Record<string, unknown>, notify: () => void): NativeStreamInfo;
  start(): void;
  close(): void;
  read(): ReadResult | null;
  write(a: Float32Array): number;
  setOutputs(ch: number[]): void;
  clearOutput(): void;
  controlPanel(): boolean;
  version: string;
}

interface PortLike {
  on(ev: 'message', fn: (e: { data: NativeRequest }) => void): void;
  on(ev: 'close', fn: () => void): void;
  postMessage(m: NativeReply): void;
  start(): void;
  close(): void;
}

declare const require: (id: string) => unknown;
declare function setImmediate(fn: () => void): unknown;
declare const process: {
  env: Record<string, string | undefined>;
  parentPort: { on(ev: 'message', fn: (e: { data: unknown; ports: PortLike[] }) => void): void };
};

const BLOCK = 1024;

let addon: Addon | null = null;
let loadError = '';
try {
  addon = require(process.env.CAL_NATIVE_ADDON ?? '') as Addon;
} catch (e) {
  loadError = String((e as Error)?.message ?? e);
}

let port: PortLike | null = null;

function send(m: NativeReply): void {
  port?.postMessage(m);
}

/** An open stream: generator, block assembly and bookkeeping. */
class Session {
  core: GeneratorCore;
  /** Generator samples produced so far (generation timeline). */
  generated = 0;
  /** Played frames of the next captured sample (capture timeline). */
  captured = 0;
  /** Silence the driver played so far (a generator sample g is played at frame g + silent). */
  silent = 0;
  private bufs: Float32Array[];
  private gen = new Float32Array(BLOCK);
  private fill = 0;
  private safety: number;
  private last: ReadResult | null = null;
  /** Two devices: (drift, input frames) at each status, for the clocks' drift over the last ten seconds. */
  private driftHistory: [number, number][] = [];
  private chunk = new Float32Array(2048);

  constructor(
    readonly info: NativeStreamInfo,
    safetyMs: number,
  ) {
    this.core = new GeneratorCore(info.sampleRate, (ev) => this.forward(ev), () => this.generated);
    this.bufs = Array.from({ length: info.inputs }, () => new Float32Array(BLOCK));
    this.safety = this.safetyFrames(safetyMs);
  }

  safetyFrames(ms: number): number {
    // At least two driver buffers plus the host's timer granularity
    return Math.max(Math.round((ms / 1000) * this.info.sampleRate), 2 * this.info.bufferFrames + Math.round(0.01 * this.info.sampleRate));
  }

  setSafety(ms: number): void {
    this.safety = this.safetyFrames(ms);
  }

  /** Generator events happen in the generation timeline: move them to the capture timeline. */
  private forward(ev: ProcessorEvent): void {
    if (ev.type === 'playStarted' || ev.type === 'playEnded') send({ t: 'ev', ev: { ...ev, frame: ev.frame + this.silent } });
    else send({ t: 'ev', ev });
  }

  /** Top the driver's generator supply up to the safety margin. */
  supply(queued: number): void {
    let need = this.safety - queued;
    if (!addon) return;
    // Samples the driver didn't take last time go first: the generator already moved past them, so dropping
    // them would skip part of a sweep and shift its timing
    if (this.carry) {
      const accepted = addon.write(this.carry);
      this.generated += accepted;
      need -= accepted;
      if (accepted < this.carry.length) {
        this.carry = this.carry.slice(accepted);
        return;
      }
      this.carry = null;
    }
    while (need > 0) {
      const n = Math.min(need, this.chunk.length);
      const c = n === this.chunk.length ? this.chunk : this.chunk.subarray(0, n);
      for (let i = 0; i < n; i++) c[i] = this.core.next(this.generated + i);
      const accepted = addon.write(c);
      this.generated += accepted;
      need -= n;
      if (accepted < n) {
        this.carry = c.slice(accepted);
        break;
      }
    }
  }

  /** Generated samples waiting for room in the driver's output buffer. */
  private carry: Float32Array | null = null;

  /** Read what the driver captured, pass it on in blocks and keep the generator supplied. */
  pump(): void {
    if (!addon) return;
    const r = addon.read();
    if (!r) return;
    this.last = r;
    this.silent = r.silent;
    const nIn = this.info.inputs;
    const stride = nIn + 1;
    const d = r.data;
    for (let i = 0; i < r.frames; i++) {
      const o = i * stride;
      for (let c = 0; c < nIn; c++) this.bufs[c][this.fill] = d[o + c];
      this.gen[this.fill] = d[o + nIn];
      if (++this.fill === BLOCK) this.flush();
    }
    this.supply(r.queued);
  }

  private flush(): void {
    send({ t: 'ev', ev: { type: 'data', frame: this.captured, inputs: this.bufs, gen: this.gen, music: this.core.musicState() } });
    this.captured += BLOCK;
    this.bufs = this.bufs.map(() => new Float32Array(BLOCK));
    this.gen = new Float32Array(BLOCK);
    this.fill = 0;
  }

  status(): NativeStatus {
    const r = this.last;
    const st: NativeStatus = { underruns: r?.underruns ?? 0, overruns: r?.overruns ?? 0, xruns: r?.xruns ?? 0, queuedMs: r ? (r.queued / this.info.sampleRate) * 1000 : 0 };
    // (The first two seconds are left out: the queue between the devices settles then.)
    if (this.info.split && r?.inputFrames !== undefined && r.inputFrames > 2 * this.info.sampleRate) {
      const h = this.driftHistory;
      h.push([r.drift ?? 0, r.inputFrames]);
      // Status every 0.5 s: ten seconds back
      if (h.length > 21) h.shift();
      const [d0, f0] = h[0];
      if (h.length >= 6 && r.inputFrames > f0) st.driftPpm = (((r.drift ?? 0) - d0) / (r.inputFrames - f0)) * 1e6;
    }
    return st;
  }
}

let session: Session | null = null;
let pumpScheduled = false;
let timer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

function schedulePump(): void {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setImmediate(() => {
    pumpScheduled = false;
    try {
      session?.pump();
    } catch (e) {
      send({ t: 'error', message: String((e as Error)?.message ?? e) });
    }
  });
}

function closeSession(): void {
  if (timer) clearInterval(timer);
  if (statusTimer) clearInterval(statusTimer);
  timer = statusTimer = null;
  session = null;
  try {
    addon?.close();
  } catch {
    /* already closed */
  }
}

function open(opts: NativeOpenOptions): NativeStreamInfo {
  if (!addon) throw new Error(loadError || 'Native audio is not available');
  closeSession();
  const info = addon.open(
    { api: opts.api, device: opts.device, outputDevice: opts.outputDevice ?? opts.device, sampleRate: opts.sampleRate, bufferFrames: opts.bufferFrames, inputs: opts.inputs, outputs: opts.outputs },
    schedulePump,
  );
  const s = new Session(info, opts.safetyMs);
  session = s;
  addon.setOutputs(s.core.gen.outputs);
  s.supply(0);
  try {
    addon.start();
  } catch (e) {
    // Not started: nothing stays open (the module has closed the streams)
    closeSession();
    throw e;
  }
  // The driver wakes the pump after every buffer; the timer is a fallback
  timer = setInterval(schedulePump, 10);
  statusTimer = setInterval(() => session && send({ t: 'status', status: session.status() }), 500);
  return info;
}

function handle(m: NativeRequest): void {
  const reply = (id: number, fn: () => unknown) => {
    try {
      send({ t: 'reply', id, ok: true, result: fn() });
    } catch (e) {
      send({ t: 'reply', id, ok: false, error: String((e as Error)?.message ?? e) });
    }
  };
  switch (m.t) {
    case 'devices':
      return reply(m.id, () => (addon ? addon.devices(m.api) : []));
    case 'open':
      return reply(m.id, () => open(m.opts));
    case 'close':
      return reply(m.id, () => closeSession());
    case 'panel':
      return reply(m.id, () => addon?.controlPanel() ?? false);
    case 'safety':
      session?.setSafety(m.ms);
      return;
    case 'msg': {
      const s = session;
      if (!s) return;
      if (m.m.type === 'generator') addon?.setOutputs(m.m.config.outputs);
      s.core.onMessage(m.m);
      return;
    }
  }
}

process.parentPort.on('message', (e) => {
  const p = e.ports?.[0];
  if (!p) return;
  // A new page connection (e.g. after a reload) replaces the previous one; its stream is closed
  closeSession();
  port?.close();
  port = p;
  p.on('message', (ev) => handle(ev.data));
  p.on('close', () => {
    if (port === p) {
      closeSession();
      port = null;
    }
  });
  p.start();
  send({ t: 'hello', apis: addon ? addon.apis() : [], version: addon?.version ?? '', error: loadError || undefined });
});
