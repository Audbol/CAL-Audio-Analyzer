import type { App } from '../app';
import { decodeUpload, UPLOAD_MARKER, encodeAudio, encodeSweep, encodeAnalysis, sharedOf, type HostStatus, type HubInfo, type HubMessage, type SweepMeta } from './protocol';

/** Desktop bridge exposed by electron/preload.cjs. */
export interface DesktopBridge {
  platform: string;
  server: {
    start(opts: { port: number; pin: string; allowControl: boolean }): Promise<{ port: number; token: string }>;
    stop(): Promise<boolean>;
    info(): Promise<unknown>;
  };
  window?: { pin(name: string, on: boolean): Promise<boolean> };
  /** Native audio (ASIO), desktop app on Windows. */
  nativeAudio?: { available(): Promise<boolean>; connect(): void };
}

/** Injected into index.html by the hub when the page is served by it. */
export interface HubPageInfo {
  role: 'host' | 'remote';
  port?: number;
  token?: string;
}

export function desktopBridge(): DesktopBridge | null {
  return (window as unknown as { calDesktop?: DesktopBridge }).calDesktop ?? null;
}

export function hubPageInfo(): HubPageInfo | null {
  return (window as unknown as { CAL_HUB?: HubPageInfo }).CAL_HUB ?? null;
}

/**
 * The measurement host's link to the remote-access hub: streams live audio and status to connected remotes
 * and executes their commands (generator, sweep playback, starting audio) through the normal app paths.
 */
export class HostLink {
  private ws: WebSocket | null = null;
  info: HubInfo | null = null;
  connected = false;
  private lastStatus = '';
  private statusTimer = 0;
  private unsubscribe: (() => void) | null = null;
  private closing = false;
  onChange?: () => void;

  constructor(private app: App) {}

  get clients(): HubInfo['clients'] {
    return this.info?.clients ?? [];
  }

  connect(port: number, token: string): Promise<void> {
    this.disconnect();
    this.closing = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=host&token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this.lastStatus = '';
        this.sendStatus();
        this.statusTimer = window.setInterval(() => this.sendStatus(), 400);
        // 20 analysis frames per second to the remote devices (the host computes ~25)
        this.analysisTimer = window.setInterval(() => this.sendAnalysis(), 50);
        this.unsubscribe = this.app.engine.onData((blocks, gen) => this.sendAudio(blocks, gen));
        // Publish the shared session state (traces, last sweep) for devices that connect
        this.sendTraces();
        this.app.republishSweep();
        this.onChange?.();
        resolve();
      };
      ws.onerror = () => reject(new Error('Could not connect to the remote-access server'));
      ws.onclose = () => {
        this.cleanup();
        if (!this.closing) this.app.toast('Remote-access server connection closed', 'warn');
        this.onChange?.();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') this.onMessage(JSON.parse(e.data) as HubMessage);
        else this.onPlayRequest(e.data as ArrayBuffer);
      };
    });
  }

  disconnect(): void {
    this.closing = true;
    this.ws?.close(1000);
    this.cleanup();
  }

  private cleanup(): void {
    clearInterval(this.statusTimer);
    clearInterval(this.analysisTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ws = null;
    this.connected = false;
    this.info = null;
  }

  /** Change PIN / control permission on the running server. */
  configure(opts: { pin?: string; allowControl?: boolean }): void {
    this.send({ t: 'config', ...opts });
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private tracesTimer = 0;
  private analysisTimer = 0;
  private analysisBufs: Float64Array[][] = [];

  /** Host processing: send the live analysis (~10 per second) to the devices that asked for it. */
  private sendAnalysis(): void {
    const a = this.app;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 2 * 1024 * 1024) return;
    if (!a.engine.running || !this.clients.some((c) => c.analysis)) return;
    const n = a.grid.length;
    const items: { index: number; tfReady: boolean; arrays: Float64Array[] }[] = [];
    a.measurements.forEach((m, i) => {
      if (!m.cfg.enabled) return;
      const bufs = (this.analysisBufs[i] ??= Array.from({ length: 7 }, () => new Float64Array(n)));
      if (bufs[0].length !== n) this.analysisBufs[i] = Array.from({ length: 7 }, () => new Float64Array(n));
      const r = m.hostArrays(this.analysisBufs[i]);
      items.push({ index: i, tfReady: r.tfReady, arrays: r.arrays });
    });
    this.ws.send(encodeAnalysis(n, items));
  }

  /** Broadcast the shared trace list (debounced). */
  sendTraces(): void {
    clearTimeout(this.tracesTimer);
    this.tracesTimer = window.setTimeout(() => this.send({ t: 'traces', traces: this.app.traces.traces }), 60);
  }

  /** Broadcast a sweep measurement result to every device. */
  sendSweep(meta: SweepMeta, ir: ArrayLike<number>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeSweep(meta, ir));
  }

  sendSweepProgress(running: boolean, frac: number, text: string): void {
    this.send({ t: 'sweepProgress', running, frac, text });
  }

  private status(): HostStatus {
    const a = this.app;
    const s = a.settings;
    return {
      t: 'status',
      running: a.engine.running,
      sampleRate: a.engine.sampleRate,
      channels: a.engine.channelCount,
      outputChannels: a.engine.outputChannels,
      deviceLabel: a.engine.deviceLabel,
      simulate: a.engine.simulate,
      generator: s.generator,
      shared: sharedOf(s),
      busy: a.busy,
      analysis: { rtaFft: s.rtaFft, rtaAveraging: s.rtaAveraging, tfAveraging: s.tfAveraging, lfResolution: s.lfResolution },
      playlist: this.playlistState(),
    };
  }

  private playlistState() {
    const p = this.app.playlist.state();
    return { ...p, pos: Math.round(p.pos * 2) / 2 };
  }

  private sendStatus(): void {
    const json = JSON.stringify(this.status());
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(json);
  }

  private sendAudio(blocks: Float32Array[], gen: Float32Array): void {
    // Only stream while someone is listening (and keep the socket from backing up)
    if (!this.clients.length || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 8 * 1024 * 1024) return;
    const frame = this.app.engine.gen.written - gen.length;
    const inputs = Array.from({ length: this.app.engine.channelCount }, (_, c) => blocks[c] ?? new Float32Array(gen.length));
    this.ws.send(encodeAudio(frame, inputs, gen));
  }

  private onMessage(msg: HubMessage): void {
    switch (msg.t) {
      case 'hub': {
        const before = this.info?.clients.length ?? 0;
        this.info = msg;
        if (msg.clients.length > before) this.app.toast(`Remote client connected (${msg.clients[msg.clients.length - 1].address})`, 'ok');
        this.lastStatus = '';
        this.sendStatus();
        this.onChange?.();
        break;
      }
      case 'cmd':
        this.onCommand(msg);
        break;
    }
  }

  private onCommand(msg: Extract<HubMessage, { t: 'cmd' }>): void {
    const app = this.app;
    switch (msg.cmd) {
      case 'hello':
        this.lastStatus = '';
        this.sendStatus();
        break;
      case 'setGenerator':
        app.setGenerator(msg.config);
        app.renderGenControls();
        break;
      case 'start':
        if (!app.engine.running) app.start();
        break;
      case 'stopPlay':
        app.engine.stopPlayback();
        break;
      case 'sweep':
        app.runSweep(msg.opts, remoteName(this.info, msg.from));
        break;
      case 'sweepCancel':
        app.cancelSweep();
        break;
      case 'traces':
        for (const op of msg.ops) app.traces.apply(op);
        break;
      case 'setShared':
        app.applyShared(msg.shared);
        break;
      case 'playlist':
        app.playlist.act(msg.a);
        break;
      case 'setAnalysis':
        Object.assign(app.settings, { rtaFft: msg.analysis.rtaFft, rtaAveraging: msg.analysis.rtaAveraging, tfAveraging: msg.analysis.tfAveraging, lfResolution: msg.analysis.lfResolution ?? app.settings.lfResolution });
        app.applyAnalysisSettings();
        break;
    }
  }

  /** Sweep playback requested by a remote: [uint32 client][uint32 request id][float32 samples]. */
  private async onPlayRequest(buf: ArrayBuffer): Promise<void> {
    const dv = new DataView(buf);
    const from = dv.getUint32(0, true);
    const id = dv.getUint32(4, true);
    if (id === UPLOAD_MARKER) {
      const file = decodeUpload(buf.slice(4));
      await this.app.playlist.addFiles([file]);
      this.app.toast(`Song “${file.name}” added by ${remoteName(this.info, from)}`, 'info');
      return;
    }
    const data = new Float32Array(buf.slice(8));
    const app = this.app;
    if (!app.engine.running) await app.start();
    const wasGen = app.settings.generator.type;
    if (wasGen !== 'off') app.engine.setGenerator({ ...app.settings.generator, type: 'off' });
    app.busy = true;
    app.toast('Playing a sweep requested by a remote client', 'info');
    try {
      const r = await app.engine.play(data);
      this.send({ t: 'event', to: from, ev: { type: 'played', id, start: r.start, end: r.end } });
    } finally {
      app.busy = false;
      if (wasGen !== 'off') app.engine.setGenerator(app.settings.generator);
    }
  }
}

function remoteName(info: HubInfo | null, id: number): string {
  const c = info?.clients.find((x) => x.id === id);
  return c ? `${c.name} (${c.address})` : 'a remote device';
}
