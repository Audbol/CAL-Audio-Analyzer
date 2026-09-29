/**
 * AudioWorklet processor: signal generator + sample-accurate capture.
 * The generated signal is also delivered back as an "internal reference" channel aligned with the inputs,
 * so transfer function measurements work even without a hardware loopback.
 */
import { VirtualRoom } from './simulator';
import { GeneratorCore } from './gen-core';
import type { ProcessorMessage, ProcessorEvent } from './protocol';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

const BLOCK = 1024;

class CalProcessor extends AudioWorkletProcessor {
  private core: GeneratorCore;
  private sim: VirtualRoom | null = null;
  private simInputs = 2;
  private frame = 0;
  private bufs: Float32Array[] = [];
  private genBuf = new Float32Array(BLOCK);
  private fill = 0;

  constructor() {
    super();
    this.core = new GeneratorCore(sampleRate, (ev) => this.post(ev), () => this.frame + this.fill);
    this.port.onmessage = (e: MessageEvent<ProcessorMessage>) => this.onMessage(e.data);
  }

  private onMessage(m: ProcessorMessage): void {
    if (this.core.onMessage(m)) return;
    if (m.type === 'simulate') this.sim = m.enabled ? new VirtualRoom(sampleRate, m.distance ?? 4.3, m.rt60 ?? 0.75) : null;
  }

  private post(ev: ProcessorEvent, transfer: Transferable[] = []): void {
    this.port.postMessage(ev, transfer);
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
    const outMask = this.core.gen.outputs;
    for (let i = 0; i < n; i++) {
      const g = this.core.next(this.frame + this.fill);
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
    this.post({ type: 'data', frame: this.frame, inputs, gen, music: this.core.musicState() }, [...inputs.map((b) => b.buffer), gen.buffer]);
    this.frame += BLOCK;
    this.bufs = inputs.map(() => new Float32Array(BLOCK));
    this.genBuf = new Float32Array(BLOCK);
    this.fill = 0;
  }
}

registerProcessor('cal-processor', CalProcessor);
