import processorUrl from './processor.ts?worker&url';
import { RingBuffer } from '../dsp/ring';
import type { GeneratorConfig, ProcessorEvent, ProcessorMessage } from './protocol';
import { NativeAudio } from '../native/client';
import type { NativeOpenOptions, NativeStreamInfo } from '../native/protocol';

export interface EngineOptions {
  deviceId?: string;
  simulate: boolean;
  sampleRate?: number;
  /** Desktop app: open a native (ASIO) device instead of the browser's audio. */
  native?: NativeOpenOptions;
}

export interface ChannelLevel {
  peak: number;
  rms: number;
  clipped: boolean;
}

/** Index used for the internal (generator) reference channel. */
export const GEN_CHANNEL = -1;

const RING_SIZE = 1 << 21; // ≈ 43 s at 48 kHz

/**
 * Owns the AudioContext, the capture/generator worklet and one ring buffer per input channel plus the
 * generator ("internal reference") channel.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  inputs: RingBuffer[] = [];
  gen = new RingBuffer(RING_SIZE);
  levels: ChannelLevel[] = [];
  genLevel: ChannelLevel = { peak: 0, rms: 0, clipped: false };
  simulate = false;
  deviceLabel = '';
  protected listeners = new Set<(blocks: Float32Array[], gen: Float32Array) => void>();
  protected playWaiters = new Map<number, { start?: number; resolve: (r: { start: number; end: number }) => void }>();
  protected playId = 1;
  /** Native audio (desktop app, ASIO): the connection to the audio host and the open stream. */
  nativeLink: NativeAudio | null = null;
  nativeInfo: NativeStreamInfo | null = null;
  /** Called when a native stream is lost (driver removed, host process ended). */
  onNativeLost?: (reason: string) => void;

  get running(): boolean {
    if (this.nativeInfo) return true;
    return !!this.ctx && this.ctx.state === 'running';
  }

  get native(): NativeAudio {
    if (!this.nativeLink) {
      const link = new NativeAudio();
      link.onEvent = (ev) => this.nativeInfo && this.onEvent(ev);
      link.onLost = (reason) => {
        if (!this.nativeInfo) return;
        this.nativeInfo = null;
        this.onNativeLost?.(reason);
      };
      this.nativeLink = link;
    }
    return this.nativeLink;
  }

  /** True for a remote client that analyses audio streamed from a measurement host. */
  get isRemote(): boolean {
    return false;
  }

  /** Whether capture is active (audio keeps arriving). */
  protected get active(): boolean {
    return !!this.ctx || !!this.nativeInfo;
  }

  get sampleRate(): number {
    return this.nativeInfo?.sampleRate ?? this.ctx?.sampleRate ?? 48000;
  }

  get channelCount(): number {
    return this.inputs.length;
  }

  ring(channel: number): RingBuffer | null {
    if (channel === GEN_CHANNEL) return this.gen;
    return this.inputs[channel] ?? null;
  }

  onData(fn: (blocks: Float32Array[], gen: Float32Array) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  static async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  async start(opts: EngineOptions): Promise<void> {
    await this.stop();
    if (opts.native) return this.startNative(opts.native);
    this.simulate = opts.simulate;
    this.musicPos = null; // a new worklet starts without a song
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: opts.sampleRate });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(processorUrl);

    let channels = 2;
    if (!opts.simulate) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not allow audio input (needs HTTPS or localhost).');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 32 },
          sampleRate: opts.sampleRate ? { ideal: opts.sampleRate } : undefined,
        } as MediaTrackConstraints,
      });
      const track = this.stream.getAudioTracks()[0];
      const settings = track.getSettings();
      channels = Math.max(1, settings.channelCount ?? 2);
      this.deviceLabel = track.label || 'Audio input';
      this.source = ctx.createMediaStreamSource(this.stream);
    } else {
      this.deviceLabel = 'Virtual room (demo)';
    }

    const outChannels = Math.max(2, Math.min(ctx.destination.maxChannelCount || 2, 32));
    ctx.destination.channelCount = outChannels;
    ctx.destination.channelInterpretation = 'discrete';
    const node = new AudioWorkletNode(ctx, 'cal-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [outChannels],
      channelCount: channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    this.node = node;
    const nIn = opts.simulate ? 2 : channels;
    this.inputs = Array.from({ length: nIn }, () => new RingBuffer(RING_SIZE));
    this.levels = Array.from({ length: nIn }, () => ({ peak: 0, rms: 0, clipped: false }));
    this.gen.clear();
    node.port.onmessage = (e: MessageEvent<ProcessorEvent>) => this.onEvent(e.data);
    this.post({ type: 'simulate', enabled: opts.simulate });
    this.source?.connect(node);
    node.connect(ctx.destination);
    if (ctx.state !== 'running') await ctx.resume();
  }

  /** Open a native (ASIO) device through the desktop app's audio host. */
  private async startNative(opts: NativeOpenOptions): Promise<void> {
    this.simulate = false;
    this.musicPos = null;
    const info = await this.native.open(opts);
    this.inputs = Array.from({ length: info.inputs }, () => new RingBuffer(RING_SIZE));
    this.levels = Array.from({ length: info.inputs }, () => ({ peak: 0, rms: 0, clipped: false }));
    this.gen.clear();
    this.deviceLabel = opts.api === 'asio' ? `ASIO: ${info.name}` : info.name;
    this.nativeInfo = info;
  }

  get outputChannels(): number {
    if (this.nativeInfo) return this.nativeInfo.outputs;
    return this.ctx?.destination.channelCount ?? 2;
  }

  private onEvent(ev: ProcessorEvent): void {
    if (ev.type === 'data') {
      if (ev.music) this.musicPos = ev.music;
      this.ingest(ev.inputs, ev.gen);
      return;
    }
    if (ev.type === 'musicEnded') {
      this.onMusicEnded?.(ev.id);
      return;
    }
    const w = this.playWaiters.get(ev.id);
    if (!w) return;
    if (ev.type === 'playStarted') w.start = ev.frame;
    else {
      this.playWaiters.delete(ev.id);
      w.resolve({ start: w.start ?? ev.frame, end: ev.frame });
    }
  }

  /** Append one block per channel to the ring buffers, update levels and notify listeners. */
  protected ingest(inputs: Float32Array[], gen: Float32Array): void {
    // Every ring must advance by exactly one block per event so all channels stay sample-aligned
    // (the worklet can briefly deliver fewer channels, e.g. right after a configuration change)
    for (let c = 0; c < this.inputs.length; c++) {
      const block = inputs[c] ?? new Float32Array(gen.length);
      this.inputs[c].push(block);
      this.updateLevel(this.levels[c], block);
    }
    this.gen.push(gen);
    this.updateLevel(this.genLevel, gen);
    for (const l of this.listeners) l(inputs, gen);
  }

  protected updateLevel(l: ChannelLevel, block: Float32Array): void {
    let pk = 0;
    let ss = 0;
    for (let i = 0; i < block.length; i++) {
      const a = Math.abs(block[i]);
      if (a > pk) pk = a;
      ss += block[i] * block[i];
    }
    // Peak with ~1.5 s fall-back, RMS smoothed
    l.peak = Math.max(pk, l.peak * 0.93);
    l.rms = l.rms * 0.8 + Math.sqrt(ss / block.length) * 0.2;
    if (pk >= 0.999) l.clipped = true;
  }

  /** Music generator: playback position (samples) of the loaded track. */
  musicPos: { id: number; pos: number } | null = null;
  onMusicEnded?: (id: number) => void;

  /** Load a decoded, level-normalised mono track into the music generator (the buffer is transferred). */
  loadMusic(id: number, data: Float32Array | null, pos = 0): void {
    this.musicPos = data ? { id, pos } : null;
    if (this.nativeInfo) return this.nativeLink?.send({ type: 'music', id, data, pos });
    this.node?.port.postMessage({ type: 'music', id, data, pos } satisfies ProcessorMessage, data ? [data.buffer] : []);
  }

  seekMusic(pos: number): void {
    if (this.musicPos) this.musicPos = { ...this.musicPos, pos };
    this.post({ type: 'musicSeek', pos });
  }

  setGenerator(config: GeneratorConfig): void {
    this.post({ type: 'generator', config });
  }

  /**
   * Play a buffer through the generator path. Resolves with the absolute capture frames at which playback
   * started and ended, so the recording can be cut out of the ring buffers sample-accurately.
   */
  play(data: Float32Array): Promise<{ start: number; end: number }> {
    const id = this.playId++;
    return new Promise((resolve) => {
      this.playWaiters.set(id, { resolve });
      this.post({ type: 'play', id, data });
    });
  }

  stopPlayback(): void {
    this.post({ type: 'stopPlay' });
    for (const [, w] of this.playWaiters) w.resolve({ start: w.start ?? 0, end: w.start ?? 0 });
    this.playWaiters.clear();
  }

  /** Wait until the given absolute frame has been captured. */
  async waitForFrame(frame: number, signal?: { cancelled: boolean }): Promise<void> {
    while (this.gen.written < frame) {
      if (signal?.cancelled || !this.active) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  private post(m: ProcessorMessage): void {
    if (this.nativeInfo) this.nativeLink?.send(m);
    else this.node?.port.postMessage(m);
  }

  async stop(): Promise<void> {
    this.stopPlayback();
    if (this.nativeInfo) {
      this.nativeInfo = null;
      await this.nativeLink?.close();
    }
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.source = null;
  }
}
