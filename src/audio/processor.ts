/**
 * AudioWorklet processor: signal generator + sample-accurate capture.
 * The generated signal is also delivered back as an "internal reference" channel aligned with the inputs,
 * so transfer function measurements work even without a hardware loopback.
 */
import { PinkNoise, WhiteNoise } from './noise';
import { VirtualRoom } from './simulator';
import type { GeneratorConfig, ProcessorMessage, ProcessorEvent } from './protocol';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

const BLOCK = 1024;
const PINK_RMS = 0.193;
const WHITE_RMS = 0.577;

class CalProcessor extends AudioWorkletProcessor {
  private gen: GeneratorConfig = { type: 'off', level: -18, freq: 1000, outputs: [0, 1], polarity: 1 };
  private pink = new PinkNoise();
  private white = new WhiteNoise();
  private phase = 0;
  private gain = 0;
  private targetGain = 0;
  private sim: VirtualRoom | null = null;
  private simInputs = 2;
  private playback: { data: Float32Array; pos: number; id: number } | null = null;
  private frame = 0;
  private bufs: Float32Array[] = [];
  private genBuf = new Float32Array(BLOCK);
  private fill = 0;
  private sweepPos = 0;
  private sweepCache: Float32Array | null = null;
  private sweepKey = '';
  private music: { data: Float32Array; pos: number; id: number } | null = null;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ProcessorMessage>) => this.onMessage(e.data);
  }

  private onMessage(m: ProcessorMessage): void {
    switch (m.type) {
      case 'generator':
        this.gen = m.config;
        this.targetGain = m.config.type === 'off' ? 0 : Math.pow(10, m.config.level / 20);
        break;
      case 'simulate':
        this.sim = m.enabled ? new VirtualRoom(sampleRate, m.distance ?? 4.3, m.rt60 ?? 0.75) : null;
        break;
      case 'play':
        this.playback = { data: m.data, pos: 0, id: m.id };
        this.post({ type: 'playStarted', id: m.id, frame: this.frame + this.fill });
        break;
      case 'stopPlay':
        this.playback = null;
        break;
      case 'music':
        this.music = m.data ? { data: m.data, pos: Math.max(0, Math.min(m.pos ?? 0, m.data.length)), id: m.id } : null;
        break;
      case 'musicSeek':
        if (this.music) this.music.pos = Math.max(0, Math.min(Math.round(m.pos), this.music.data.length));
        break;
    }
  }

  private post(ev: ProcessorEvent, transfer: Transferable[] = []): void {
    this.port.postMessage(ev, transfer);
  }

  /** Continuous periodic log sweep (for live transfer function measurement with sweeps). */
  private sweepSample(): number {
    const dur = 1.0;
    const key = `${sampleRate}`;
    if (!this.sweepCache || this.sweepKey !== key) {
      const n = Math.round(dur * sampleRate);
      const f1 = 20;
      const f2 = Math.min(20000, sampleRate / 2.2);
      const L = dur / Math.log(f2 / f1);
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const g = i < 480 ? i / 480 : i > n - 480 ? (n - i) / 480 : 1;
        buf[i] = g * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
      }
      this.sweepCache = buf;
      this.sweepKey = key;
    }
    const v = this.sweepCache[this.sweepPos];
    this.sweepPos = (this.sweepPos + 1) % this.sweepCache.length;
    return v;
  }

  private nextGen(): number {
    const pb = this.playback;
    if (pb) {
      const v = pb.pos < pb.data.length ? pb.data[pb.pos] : 0;
      pb.pos++;
      if (pb.pos >= pb.data.length) {
        this.post({ type: 'playEnded', id: pb.id, frame: this.frame + this.fill });
        this.playback = null;
      }
      return v;
    }
    // Smooth level changes (≈10 ms) to avoid clicks
    this.gain += (this.targetGain - this.gain) * 0.002;
    if (this.gain < 1e-6 && this.targetGain === 0) return 0;
    let v = 0;
    switch (this.gen.type) {
      case 'pink':
        v = (this.pink.next() / PINK_RMS) * Math.SQRT1_2;
        break;
      case 'white':
        v = (this.white.next() / WHITE_RMS) * Math.SQRT1_2;
        break;
      case 'sine':
        this.phase += (2 * Math.PI * this.gen.freq) / sampleRate;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
        v = Math.sin(this.phase);
        break;
      case 'sweep':
        v = this.sweepSample();
        break;
      case 'music': {
        // Advances only while the generator is on, so switching it off pauses the track
        const mu = this.music;
        if (!mu) break;
        if (mu.pos < mu.data.length) v = mu.data[mu.pos++];
        if (mu.pos === mu.data.length) {
          mu.pos++;
          this.post({ type: 'musicEnded', id: mu.id });
        }
        break;
      }
      default:
        v = 0;
    }
    const out = v * this.gain * this.gen.polarity;
    return out > 1 ? 1 : out < -1 ? -1 : out;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const n = output[0]?.length ?? input[0]?.length ?? 128;
    const nIn = this.sim ? this.simInputs : Math.max(input.length, 1);
    if (this.bufs.length !== nIn) {
      this.bufs = Array.from({ length: nIn }, () => new Float32Array(BLOCK));
      this.fill = 0;
    }
    const outMask = this.gen.outputs;
    for (let i = 0; i < n; i++) {
      const g = this.nextGen();
      for (let c = 0; c < output.length; c++) output[c][i] = outMask.includes(c) && !this.sim ? g : 0;
      this.genBuf[this.fill] = g;
      if (this.sim) {
        this.bufs[0][this.fill] = this.sim.process(g);
        this.bufs[1][this.fill] = g; // simulated hardware loopback
      } else {
        for (let c = 0; c < nIn; c++) this.bufs[c][this.fill] = input[c] ? input[c][i] : 0;
      }
      this.fill++;
      if (this.fill === BLOCK) this.flush();
    }
    return true;
  }

  private flush(): void {
    const inputs = this.bufs;
    const gen = this.genBuf;
    const music = this.music ? { id: this.music.id, pos: Math.min(this.music.pos, this.music.data.length) } : undefined;
    this.post({ type: 'data', frame: this.frame, inputs, gen, music }, [...inputs.map((b) => b.buffer), gen.buffer]);
    this.frame += BLOCK;
    this.bufs = inputs.map(() => new Float32Array(BLOCK));
    this.genBuf = new Float32Array(BLOCK);
    this.fill = 0;
  }
}

registerProcessor('cal-processor', CalProcessor);
