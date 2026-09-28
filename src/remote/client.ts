import { AudioEngine, type EngineOptions } from '../audio/engine';
import { RingBuffer } from '../dsp/ring';
import type { GeneratorConfig } from '../audio/protocol';
import { decodeAudio, decodeSweep, binaryType, BIN_SWEEP, type HostStatus, type HubMessage, type RemoteCommand, type SweepMeta, type SweepProgress } from './protocol';
import type { Trace } from '../traces';

const RING_SIZE = 1 << 21;

export type RemoteState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Audio engine for remote browsers: instead of capturing locally it receives the measurement host's
 * sample-aligned audio stream over the network and feeds the same ring buffers, so every analysis view and
 * meter runs on the remote device exactly as on the host. Generator changes and sweep playback are sent to
 * the host, which plays them through its audio interface.
 */
export class RemoteEngine extends AudioEngine {
  ws: WebSocket | null = null;
  status: HostStatus | null = null;
  state: RemoteState = 'disconnected';
  allowControl = true;
  hostConnected = false;
  /** Audio blocks the hub had to drop recently because the network could not keep up. */
  droppedBlocks = 0;
  lastError = '';
  onStatus?: (s: HostStatus) => void;
  onChange?: () => void;
  /** Shared session state published by the host. */
  onTraces?: (traces: Trace[]) => void;
  onSweep?: (meta: SweepMeta, ir: Float64Array) => void;
  onSweepProgress?: (p: SweepProgress) => void;
  private closing = false;

  constructor(private pinProvider: () => string, private clientName: () => string) {
    super();
  }

  override get running(): boolean {
    return this.state === 'connected' && !!this.status?.running;
  }

  override get isRemote(): boolean {
    return true;
  }

  protected override get active(): boolean {
    return this.state === 'connected';
  }

  override get sampleRate(): number {
    return this.status?.sampleRate ?? 48000;
  }

  override get outputChannels(): number {
    return this.status?.outputChannels ?? 2;
  }

  /** Connect to the hub (the page's own origin) and wait for the host's audio to be running. */
  override async start(_opts?: EngineOptions): Promise<void> {
    await this.stop();
    this.closing = false;
    this.state = 'connecting';
    this.onChange?.();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws?role=remote&pin=${encodeURIComponent(this.pinProvider())}&name=${encodeURIComponent(this.clientName())}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const fail = (msg: string) => {
        this.state = 'error';
        this.lastError = msg;
        this.onChange?.();
        reject(new Error(msg));
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return this.onAudio(e.data as ArrayBuffer);
        const msg = JSON.parse(e.data) as HubMessage;
        this.onMessage(msg);
        if (msg.t === 'welcome') {
          this.state = 'connected';
          this.onChange?.();
          resolve();
        }
      };
      ws.onclose = (e) => {
        const wasConnected = this.state === 'connected';
        this.ws = null;
        this.status = null;
        if (this.closing) {
          this.state = 'disconnected';
          this.onChange?.();
          return;
        }
        if (!wasConnected) return fail(e.code === 4001 ? 'Wrong PIN' : e.reason || 'Could not connect to the measurement host');
        this.state = 'error';
        this.lastError = e.reason || 'Connection to the measurement host was lost';
        this.onChange?.();
      };
      ws.onerror = () => undefined;
    });
    // Wait for the first status; ask the host to start its audio if it is stopped
    await this.waitFor(() => !!this.status, 4000);
    if (this.status && !this.status.running && this.allowControl) {
      this.sendLegacy({ t: 'cmd', cmd: 'start' });
      await this.waitFor(() => !!this.status?.running, 10000);
    }
  }

  private async waitFor(cond: () => boolean, ms: number): Promise<void> {
    const t0 = performance.now();
    while (!cond() && performance.now() - t0 < ms && this.state === 'connected') await new Promise((r) => setTimeout(r, 50));
  }

  private onMessage(msg: HubMessage): void {
    switch (msg.t) {
      case 'traces':
        this.onTraces?.(msg.traces);
        return;
      case 'sweepProgress':
        this.onSweepProgress?.(msg);
        return;
      case 'welcome':
        this.allowControl = msg.allowControl;
        this.hostConnected = msg.hostConnected;
        break;
      case 'status':
        this.hostConnected = true;
        if (!this.status || this.status.channels !== msg.channels) this.resetRings(msg.channels);
        this.status = msg;
        this.deviceLabel = `${msg.deviceLabel} (remote host)`;
        this.simulate = msg.simulate;
        this.onStatus?.(msg);
        break;
      case 'host':
        this.hostConnected = msg.connected;
        if (!msg.connected) this.status = null;
        break;
      case 'control':
        this.allowControl = msg.allowControl;
        break;
      case 'dropped':
        this.droppedBlocks += msg.blocks;
        break;
      case 'error':
        this.lastError = msg.message;
        break;
      case 'event':
        if (msg.ev.type === 'played') {
          const w = this.playWaiters.get(msg.ev.id);
          if (w) {
            this.playWaiters.delete(msg.ev.id);
            w.resolve({ start: msg.ev.start, end: msg.ev.end });
          }
        }
        break;
    }
    this.onChange?.();
  }

  private resetRings(nCh: number): void {
    this.inputs = Array.from({ length: nCh }, () => new RingBuffer(RING_SIZE));
    this.levels = Array.from({ length: nCh }, () => ({ peak: 0, rms: 0, clipped: false }));
    this.gen = new RingBuffer(RING_SIZE);
  }

  /** Live audio from the host: keep the local rings aligned to the host's absolute frame clock. */
  private onAudio(buf: ArrayBuffer): void {
    if (binaryType(buf) === BIN_SWEEP) {
      const { meta, ir } = decodeSweep(buf);
      this.onSweep?.(meta, ir);
      return;
    }
    const { frame, inputs, gen } = decodeAudio(buf);
    if (inputs.length !== this.inputs.length) this.resetRings(inputs.length);
    const head = this.gen.written;
    if (head === 0 || frame < head || frame - head > RING_SIZE / 2) {
      // First block, host restart or a long gap: re-anchor the rings at the host's frame index
      for (const r of [...this.inputs, this.gen]) {
        r.clear();
        r.written = frame;
      }
    } else if (frame > head) {
      // Blocks dropped by a slow network: fill with silence so every channel stays sample-aligned
      const gap = new Float32Array(frame - head);
      for (const r of [...this.inputs, this.gen]) r.push(gap);
    }
    this.ingest(inputs, gen);
  }

  /** Send a command to the measurement host. Returns false when not connected. */
  send(msg: RemoteCommand): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private sendLegacy(msg: RemoteCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  override setGenerator(config: GeneratorConfig): void {
    this.sendLegacy({ t: 'cmd', cmd: 'setGenerator', config });
  }

  /** Sweep playback happens on the host; the result carries host frame indices, which match our rings. */
  override play(data: Float32Array): Promise<{ start: number; end: number }> {
    const id = this.playId++;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to the measurement host'));
      if (!this.allowControl) return reject(new Error('Remote control is disabled on the host'));
      this.playWaiters.set(id, { resolve });
      const buf = new ArrayBuffer(4 + data.length * 4);
      new DataView(buf).setUint32(0, id, true);
      new Float32Array(buf, 4).set(data);
      this.ws.send(buf);
    });
  }

  override stopPlayback(): void {
    this.sendLegacy({ t: 'cmd', cmd: 'stopPlay' });
    for (const [, w] of this.playWaiters) w.resolve({ start: 0, end: 0 });
    this.playWaiters.clear();
  }

  override async stop(): Promise<void> {
    this.closing = true;
    for (const [, w] of this.playWaiters) w.resolve({ start: 0, end: 0 });
    this.playWaiters.clear();
    this.ws?.close(1000, 'Client disconnected');
    this.ws = null;
    this.status = null;
    this.state = 'disconnected';
  }
}
