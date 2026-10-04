import type { App } from '../app';
import type { FromWorker, ToWorker, WorkerConfig } from './protocol';
import AnalysisWorker from './worker.ts?worker';

/**
 * Runs the live analysis (spectrum and transfer function) in a background thread. Every audio block of the
 * channels in use goes to the worker; its frames reach each measurement as `hostFrame`, the same way remote
 * devices show the measurement host's analysis. While no frames arrive (starting up, or the worker failed) the
 * main thread analyses as before, so the display never stops.
 */
export class AnalysisWorkerClient {
  private worker: Worker | null = null;
  private failed = false;
  private epoch = 0;
  private cfgKey = '';
  private channels: number[] = [];
  private unsub: (() => void) | null = null;
  /** Frames received and the worker's recent processing time per audio block (ms), for the status line. */
  frames = 0;
  busyMs = 0;

  constructor(private readonly app: App) {}

  /** In use: background analysis is on, available, and this is the computer that measures. */
  get active(): boolean {
    return !!this.worker && !this.failed;
  }

  /** Audio (re)started: new ring buffers, new analyzers. */
  restart(): void {
    this.epoch++;
    this.cfgKey = '';
    this.unsub?.();
    this.unsub = null;
    if (!this.wanted()) return this.stop();
    if (!this.worker && !this.failed) this.create();
    if (!this.worker) return;
    this.unsub = this.app.engine.onData((blocks, gen) => this.send(blocks, gen));
    this.sync();
  }

  private wanted(): boolean {
    return !this.app.remote && this.app.settings.analysisThread !== 'main' && typeof Worker !== 'undefined';
  }

  private create(): void {
    try {
      const w = new AnalysisWorker();
      w.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
      w.onerror = (e) => this.fail(e.message || 'the background analysis stopped');
      this.worker = w;
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.stop();
    console.warn('Background analysis unavailable:', reason);
    this.app.toast('Background analysis is not available here: the analysis runs on the main thread.', 'info');
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.worker?.terminate();
    this.worker = null;
    for (const m of this.app.measurements) m.hostFrame = null;
  }

  /** Switch background analysis on or off (Tools → Display & performance). */
  setEnabled(on: boolean): void {
    this.failed = false;
    if (!on) return this.stop();
    if (this.app.engine.running) this.restart();
  }

  /** Send the configuration when it changed (called every frame: the key is cheap to build). */
  sync(): void {
    const w = this.worker;
    if (!w) return;
    const a = this.app;
    const s = a.settings;
    const ms = a.measurements.map((m) => ({ id: m.cfg.id, mic: m.cfg.mic, ref: m.cfg.ref, delay: Math.max(0, Math.round(m.cfg.delay)), enabled: m.cfg.enabled, resets: m.resets }));
    const rate = a.rtaRate();
    const key = `${this.epoch}|${a.busy}|${a.fs}|${a.grid.length}|${s.rtaFft}|${s.lfResolution}|${s.rtaAveraging}|${s.tfAveraging}|${rate}|${JSON.stringify(ms)}`;
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    this.channels = [...new Set(ms.filter((m) => m.enabled).flatMap((m) => [m.mic, m.ref]))];
    const config: WorkerConfig = { fs: a.fs, grid: a.grid, epoch: this.epoch, rtaFft: s.rtaFft, lfResolution: s.lfResolution, rtaAveraging: s.rtaAveraging, tfAveraging: s.tfAveraging, rate, paused: a.busy, measurements: ms };
    this.post({ t: 'config', config });
  }

  private send(blocks: Float32Array[], gen: Float32Array): void {
    if (!this.worker || !this.channels.length) return;
    const n = gen.length;
    // Copies: the main thread keeps its own (sweeps, delay finder, SPL meter and remote devices read them)
    const out = this.channels.map((ch) => (ch < 0 ? gen.slice() : (blocks[ch]?.slice() ?? new Float32Array(n))));
    this.post({ t: 'audio', channels: this.channels, blocks: out }, out.map((b) => b.buffer));
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    try {
      this.worker?.postMessage(msg, transfer);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private receive(msg: FromWorker): void {
    if (msg.t === 'error') return this.fail(msg.message);
    const now = performance.now();
    for (const f of msg.frames) {
      const m = this.app.measurements.find((x) => x.cfg.id === f.id);
      // Frames computed before a reset or an audio restart are stale
      if (!m || f.epoch !== this.epoch || f.resets !== m.resets) continue;
      const [rtaBands, rtaFft, peakBands, peakFft, mag, phase, coh] = f.arrays;
      m.hostFrame = { index: 0, tfReady: f.tfReady, rtaReady: f.rtaReady, rtaBands, rtaFft, peakBands, peakFft, mag, phase, coh };
      m.hostFrameAt = now;
      m.workerVersions = { rta: f.rtaVersion, tf: f.tfVersion };
      this.frames++;
      this.busyMs = 0.9 * this.busyMs + 0.1 * f.busyMs;
    }
  }
}
