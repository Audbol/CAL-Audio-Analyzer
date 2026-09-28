import { AudioEngine, GEN_CHANNEL } from './audio/engine';
import type { GeneratorType } from './audio/protocol';
import { logGrid, SMOOTHING_OPTIONS } from './dsp/freq';
import { calCorrection } from './dsp/calibration';
import { SplMeter, type SplReading } from './dsp/spl';
import { speedOfSound } from './dsp/delay';
import { Measurement, type AnalysisNeeds } from './measurement';
import { loadSettings, saveSettings, PALETTE, refLabel, type Settings, type ViewId, type MeasurementConfig } from './state';
import { TraceStore, traceToCsv, parseTraceText, download, type Trace } from './traces';
import { h, clear, icon, select } from './ui/dom';
import { SpectrumView } from './views/spectrum';
import { TransferView } from './views/transfer';
import { SpectrogramView } from './views/spectrogram';
import { ImpulseView } from './views/impulse';
import { RoomView } from './views/room';
import { EqView } from './views/eq';
import { SplView } from './views/spl';
import { ToolsView } from './views/tools';
import { showWizard, showHelp, showRemoteConnect } from './ui/dialogs';
import { applyChartTheme } from './ui/theme';
import { Dock } from './ui/dock';
import { Plot } from './ui/plot';
import { Playlist, RemotePlaylist, type PlaylistApi } from './audio/playlist';
import { MusicControls, showPlaylist } from './ui/music';
import { RemoteEngine } from './remote/client';
import { HostLink, desktopBridge, hubPageInfo } from './remote/host';
import { sharedOf, type HostStatus, type RemoteCommand, type SharedSettings, type SweepMeta, type SweepRequest } from './remote/protocol';

export interface View {
  id: ViewId;
  title: string;
  icon: Parameters<typeof icon>[0];
  el: HTMLElement;
  /** Draw the view. `detachedOnly`: the view is not active; update only panels detached into other windows. */
  tick(detachedOnly?: boolean): void;
  show?(): void;
  hide?(): void;
  /** Force a redraw on the next tick (e.g. after a theme change). */
  invalidate?(): void;
  /** True if any of the view's panels is detached into its own window. */
  hasDetached?(): boolean;
  /** Live analyses the view displays (remote devices only compute what is on screen). */
  needs?: Partial<AnalysisNeeds> & { tfLocal?: boolean };
}

export interface Hint {
  level: 'info' | 'warn' | 'ok';
  text: string;
  action?: { label: string; run: () => void };
}

export class App {
  settings: Settings = loadSettings();
  /** Set when this page was served by the remote-access hub (see electron/hub.cjs). */
  readonly hubPage = hubPageInfo();
  /** Remote client: analyses audio streamed from a measurement host instead of a local audio device. */
  readonly remote = this.hubPage?.role === 'remote';
  engine: AudioEngine = this.remote ? new RemoteEngine(() => this.remotePin, () => remoteClientName()) : new AudioEngine();
  /** Host side of remote access (present while the server is running). */
  hostLink: HostLink | null = null;
  remotePin = new URLSearchParams(location.search).get('pin') ?? sessionStorage.getItem('cal-remote-pin') ?? '';
  private splUnsub: (() => void) | null = null;
  private sharedApplied = '';
  private remoteBadge = h('button', { class: 'remote-badge', style: 'display:none' });
  traces = new TraceStore();
  /** Music generator playlist: stored and played on the measurement computer, mirrored on remote devices. */
  playlist: PlaylistApi = this.remote
    ? new RemotePlaylist(
        (a) => this.sendToHost({ t: 'cmd', cmd: 'playlist', a }),
        (f) => (this.engine as RemoteEngine).uploadFile(f),
        () => this.settings.generator.type === 'music' && this.engine.running,
      )
    : new Playlist(() => this.engine, this.settings.playlist, () => this.save());
  private musicCtl: MusicControls | null = null;
  grid = logGrid(20, 20000, 48);
  measurements: Measurement[] = [];
  spl: SplMeter = new SplMeter(48000, this.settings.splWeighting);
  splReading: SplReading | null = null;
  cal: Float64Array | null = null;
  views: View[] = [];
  private active!: View;
  private root: HTMLElement;
  private viewHost!: HTMLElement;
  private tabs!: HTMLElement;
  private sidebarMeas!: HTMLElement;
  private sidebarTraces!: HTMLElement;
  private hintsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private metersEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private genBtn!: HTMLButtonElement;
  private splMini!: HTMLElement;
  private sourceSel!: HTMLSelectElement;
  private genControls!: HTMLElement;
  private selectedTraces = new Set<string>();
  private lastHints = '';
  private frameTimes: number[] = [];
  private starting = false;
  private themeBtn = h('button', { class: 'btn icon-btn theme-btn', onclick: () => this.toggleTheme() });
  private lastMode: boolean | null = null;
  /** Set while a sweep measurement owns the generator; live analysis pauses so averages stay clean. */
  busy = false;

  constructor(root: HTMLElement) {
    this.root = root;
    const desk = desktopBridge();
    if (desk?.window) {
      const bridge = desk.window;
      Dock.pinWindow = (name, on) => bridge.pin(name, on);
      Dock.restoreDetached = true;
    }
    if (this.settings.graphQuality === 'fast') Plot.maxDpr = 1;
    this.applyTheme();
    this.updateCal();
    this.build();
    if (this.playlist instanceof Playlist) {
      const pl = this.playlist;
      pl.init();
      this.engine.onMusicEnded = (key) => pl.ended(key);
    }
    this.playlist.onChange(() => this.musicCtl?.update());
    this.traces.onChange(() => {
      this.renderTraces();
      this.hostLink?.sendTraces();
    });
    this.scheduleFrame();
    setInterval(() => this.updateHints(), 700);
    this.bindKeys();
    if (this.remote) this.initRemoteClient();
    else {
      if (!this.settings.wizardDone) setTimeout(() => showWizard(this), 200);
      this.initRemoteHost();
    }
  }

  get fs(): number {
    return this.engine.sampleRate;
  }

  save(): void {
    saveSettings(this.settings);
    if (this.remote) this.pushShared();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Shared session state (host-authoritative: remotes send changes to the host, which broadcasts them)

  /** Remote client: send a command to the measurement host. False when not connected. */
  sendToHost(msg: RemoteCommand): boolean {
    return this.remote ? (this.engine as RemoteEngine).send(msg) : false;
  }

  /** Remote client: send calibration / measurement setup changes made on this device to the host. */
  private pushShared(): void {
    if (!this.sharedApplied) return; // not yet synchronised with the host
    const shared = JSON.stringify(sharedOf(this.settings));
    if (shared === this.sharedApplied) return;
    if (this.sendToHost({ t: 'cmd', cmd: 'setShared', shared: sharedOf(this.settings) })) this.sharedApplied = shared;
  }

  /** Host: apply measurement setup changes sent by a remote device. */
  applyShared(shared: SharedSettings): void {
    const s = this.settings;
    const measChanged = JSON.stringify(s.measurements) !== JSON.stringify(shared.measurements);
    if (s.splOffset !== shared.splOffset) this.spl.resetLeq();
    s.splOffset = shared.splOffset;
    s.splCalibrated = shared.splCalibrated;
    s.micCal = shared.micCal;
    s.tempC = shared.tempC;
    if (measChanged) {
      s.measurements = JSON.parse(JSON.stringify(shared.measurements));
      if (this.engine.running) this.rebuildMeasurements();
    }
    this.spl.offsetDb = s.splOffset;
    this.updateCal();
    this.renderMeasurements();
    this.save();
  }

  private lastSweep: { meta: SweepMeta; ir: ArrayLike<number> } | null = null;

  /** Host: publish a finished sweep measurement to every connected device. */
  shareSweep(meta: SweepMeta, ir: ArrayLike<number>): void {
    this.lastSweep = { meta, ir };
    this.hostLink?.sendSweep(meta, ir);
  }

  republishSweep(): void {
    if (this.lastSweep) this.hostLink?.sendSweep(this.lastSweep.meta, this.lastSweep.ir);
  }

  private get roomView(): RoomView {
    return this.views.find((v) => v.id === 'room') as RoomView;
  }

  /** Host: run a sweep requested by a remote device. */
  runSweep(opts: SweepRequest, by: string): void {
    this.roomView.measureWith(opts, by);
  }

  cancelSweep(): void {
    this.roomView.cancel();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Engine control

  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.startBtn.disabled = true;
    const modeChanged = !this.remote && this.lastMode !== null && this.lastMode !== this.settings.simulate;
    try {
      await this.engine.start({ simulate: this.settings.simulate, deviceId: this.settings.deviceId || undefined });
      this.lastMode = this.settings.simulate;
      if (this.remote) {
        const st = (this.engine as RemoteEngine).status;
        if (st) this.adoptHost(st, true);
      }
      const nCh = this.engine.channelCount;
      if (modeChanged) {
        // The demo room provides a loopback on In 2; real setups most often start with the internal reference
        for (const m of this.settings.measurements) {
          m.ref = this.settings.simulate ? 1 : GEN_CHANNEL;
          m.mic = 0;
          m.delay = 0;
        }
        if (!this.settings.simulate) this.toast('Reference set to the internal generator. Use In 2 instead if you have a hardware loopback.', 'info');
      }
      // Make channel assignments valid for this device
      for (const m of this.settings.measurements) {
        if (m.mic >= nCh) m.mic = 0;
        if (m.ref !== GEN_CHANNEL && (m.ref >= nCh || m.ref === m.mic)) m.ref = nCh > 1 && !this.settings.simulate ? GEN_CHANNEL : nCh > 1 ? 1 : GEN_CHANNEL;
      }
      if (this.settings.splChannel >= nCh) this.settings.splChannel = 0;
      this.rebuildMeasurements();
      this.spl = new SplMeter(this.fs, this.settings.splWeighting);
      this.spl.offsetDb = this.settings.splOffset;
      this.splUnsub?.();
      this.splUnsub = this.engine.onData((blocks) => {
        const b = blocks[this.settings.splChannel];
        if (b) this.spl.process(b);
      });
      if (this.remote) {
        this.toast(this.engine.running ? `Connected to the measurement host · ${this.fs / 1000} kHz · ${nCh} input channel${nCh > 1 ? 's' : ''}` : 'Connected. Audio on the measurement host is stopped.', 'ok');
      } else {
        this.engine.setGenerator(this.settings.generator);
        this.toast(`Audio running · ${this.engine.deviceLabel} · ${this.fs / 1000} kHz · ${nCh} input channel${nCh > 1 ? 's' : ''}`, 'ok');
      }
      this.refreshDevices();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.engine.stop();
      if (this.remote) {
        const eng = this.engine as RemoteEngine;
        eng.state = 'error';
        eng.lastError = msg;
        if (msg === 'Wrong PIN') showRemoteConnect(this, 'Wrong PIN. Check the PIN shown on the host (Tools → Remote access).');
        else if (!this.autoReconnecting) this.toast(`Could not reach the measurement host: ${msg}. Retrying…`, 'warn');
        this.scheduleReconnect();
        this.renderTopState();
      } else this.toast(`Could not start audio: ${msg}`, 'warn');
    } finally {
      this.starting = false;
      this.startBtn.disabled = false;
      this.renderTopState();
      this.renderMeasurements();
    }
  }

  async stop(): Promise<void> {
    await this.engine.stop();
    this.renderTopState();
  }

  async toggleEngine(): Promise<void> {
    if (this.remote) {
      // Remote: the button connects / disconnects from the host (the host's audio keeps running)
      if ((this.engine as RemoteEngine).state === 'connected') {
        this.userDisconnected = true;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = 0;
        await this.stop();
      } else {
        this.userDisconnected = false;
        this.reconnectDelay = 1500;
        await this.start();
      }
      return;
    }
    if (this.engine.running) await this.stop();
    else await this.start();
  }

  rebuildMeasurements(): void {
    this.measurements = this.settings.measurements.map((c) => new Measurement(c, this.fs, this.grid, this.settings));
  }

  applyAnalysisSettings(): void {
    for (const m of this.measurements) m.applySettings(this.settings);
    this.save();
    const s = this.settings;
    if (this.hostProcessing) this.sendToHost({ t: 'cmd', cmd: 'setAnalysis', analysis: { rtaFft: s.rtaFft, rtaAveraging: s.rtaAveraging, tfAveraging: s.tfAveraging, lfResolution: s.lfResolution } });
  }

  /** Remote device whose live analysis is computed by the measurement host. */
  get hostProcessing(): boolean {
    return this.remote && this.settings.remoteProcessing === 'host';
  }

  processingMode(): 'host' | 'device' | 'local' {
    return this.remote ? this.settings.remoteProcessing : 'local';
  }

  setProcessing(mode: 'host' | 'device'): void {
    this.settings.remoteProcessing = mode;
    this.save();
    if (!this.remote) return;
    (this.engine as RemoteEngine).setWantAnalysis(mode === 'host');
    for (const m of this.measurements) {
      m.hostFrame = null;
      m.reset();
    }
    this.renderTopState();
  }

  /** Graph pixel-ratio limit (lower = faster drawing on slow devices). */
  setGraphQuality(maxDpr: number): void {
    Plot.setMaxDpr(maxDpr);
  }

  setGraphQualityMode(mode: Settings['graphQuality']): void {
    this.settings.graphQuality = mode;
    this.save();
    this.slowSince = 0;
    this.setGraphQuality(mode === 'fast' ? 1 : 2);
  }

  private lastFrameAt = 0;
  private frameGaps: number[] = [];
  private slowSince = 0;

  /** Auto graph quality: when the display rate stays low, draw graphs at a lower resolution. */
  private adaptQuality(now: number): void {
    if (this.lastFrameAt) this.frameGaps.push(now - this.lastFrameAt);
    this.lastFrameAt = now;
    if (this.frameGaps.length > 30) this.frameGaps.shift();
    if (this.settings.graphQuality !== 'auto' || Plot.maxDpr <= 1 || this.frameGaps.length < 30 || document.hidden) return;
    const gap = this.frameGaps.reduce((a, b) => a + b, 0) / this.frameGaps.length;
    // Below ~20 frames per second for 3 s: step the resolution down (2 → 1.5 → 1)
    if (gap < 50 || gap > 1000) {
      this.slowSince = 0;
      return;
    }
    this.slowSince ||= now;
    if (now - this.slowSince > 3000) {
      this.setGraphQuality(Plot.maxDpr > 1.5 ? 1.5 : 1);
      this.slowSince = 0;
      this.frameGaps = [];
    }
  }

  /** What the visible views (active tab and detached panels) need computed this frame. */
  private analysisNeeds(): AnalysisNeeds & { tfLocal: boolean } {
    // The measurement host computes everything: remote devices in host-processing mode rely on it
    if (!this.remote) return { rta: true, tf: true, tfLocal: true };
    const n = { rta: false, tf: false, tfLocal: false };
    for (const v of this.views) {
      if (v !== this.active && !v.hasDetached?.()) continue;
      n.rta ||= !!v.needs?.rta;
      n.tf ||= !!v.needs?.tf;
      n.tfLocal ||= !!v.needs?.tfLocal;
    }
    return n;
  }

  /** Set a toolbar control that mirrors a setting (after the value changed elsewhere, e.g. on the host). */
  private syncSettingControls(): void {
    const s = this.settings as unknown as Record<string, unknown>;
    for (const el of this.root.querySelectorAll<HTMLSelectElement>('select[data-setting]')) {
      const v = String(s[el.dataset.setting!]);
      if (el.value !== v) el.value = v;
    }
  }

  resetAverages(): void {
    for (const m of this.measurements) m.reset();
    this.toast('Averages reset');
  }

  updateCal(): void {
    const cal = this.settings.micCal;
    this.cal = cal ? Float64Array.from(this.grid, (f) => calCorrection(cal, f)) : null;
  }

  setGenerator(patch: Partial<Settings['generator']>): void {
    if (this.remote && !(this.engine as RemoteEngine).allowControl) {
      this.toast('The host has disabled remote control of the generator.', 'warn');
      this.renderGenControls();
      return;
    }
    Object.assign(this.settings.generator, patch);
    this.engine.setGenerator(this.settings.generator);
    this.save();
    this.renderTopState();
  }

  toggleGenerator(): void {
    const g = this.settings.generator;
    if (g.type === 'off') this.setGenerator({ type: (this.lastGenType ?? 'pink') as GeneratorType });
    else {
      this.lastGenType = g.type;
      this.setGenerator({ type: 'off' });
    }
    this.renderGenControls();
  }
  private lastGenType: GeneratorType | null = null;

  findDelay(m: Measurement): void {
    if (!this.engine.running) return this.toast('Start the audio engine first', 'warn');
    if (this.settings.generator.type === 'off' && m.cfg.ref === GEN_CHANNEL) {
      return this.toast('Turn on the generator (pink noise) to find the delay', 'warn');
    }
    const est = m.findDelay(this.engine);
    if (!est) return;
    if (est.confidenceDb < 12) {
      this.toast(`Delay finder not confident (${est.confidenceDb.toFixed(0)} dB) — check levels and that the reference carries the excitation signal`, 'warn');
      return;
    }
    m.cfg.delay = est.samples;
    m.reset();
    this.save();
    this.renderMeasurements();
    const dist = (est.ms / 1000) * speedOfSound(this.settings.tempC);
    this.toast(
      `${m.cfg.name}: delay ${est.ms.toFixed(2)} ms (${dist.toFixed(2)} m)${est.polarityInverted ? ' · polarity appears inverted' : ''}`,
      'ok',
    );
  }

  captureTrace(m: Measurement, kind: 'tf' | 'rta' = 'tf'): Trace | null {
    if (!this.engine.running || (kind === 'tf' && !m.tfReady)) {
      this.toast(kind === 'tf' ? 'No transfer function yet: start audio with the generator on, then capture.' : 'Start audio first, then capture.', 'warn');
      return null;
    }
    const now = new Date();
    const stamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    const t =
      kind === 'tf'
        ? this.traces.add({
            name: `${m.cfg.name} ${stamp}`,
            kind: 'tf',
            freqs: Array.from(this.grid),
            mag: Array.from(m.mag, (v) => (Number.isFinite(v) ? +v.toFixed(3) : -200)),
            phase: Array.from(m.phase, (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0)),
            coh: Array.from(m.result.coh, (v) => +v.toFixed(4)),
          })
        : this.traces.add({
            name: `${m.cfg.name} RTA ${stamp}`,
            kind: 'rta',
            freqs: Array.from(this.grid),
            mag: Array.from(m.rtaOut, (v) => +v.toFixed(2)),
          });
    this.toast(`Captured “${t.name}”`, 'ok');
    return t;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Remote access

  /** Remote client: ask for the PIN if needed, then connect to the host. */
  private async initRemoteClient(): Promise<void> {
    const eng = this.engine as RemoteEngine;
    eng.onStatus = (st) => this.adoptHost(st);
    // Traces and sweep results live on the host; this device mirrors them
    this.traces.sink = (op) => void this.sendToHost({ t: 'cmd', cmd: 'traces', ops: [op] });
    eng.onTraces = (list) => this.traces.setAll(list);
    eng.onSweep = (meta, ir) => this.roomView.applyShared(meta, ir);
    eng.onSweepProgress = (p) => this.roomView.showHostProgress(p.running, p.frac, p.text);
    eng.wantAnalysis = this.hostProcessing;
    eng.onAnalysis = (frames) => {
      if (!this.hostProcessing) return; // frames still in flight after switching to on-device analysis
      const t = performance.now();
      for (const f of frames) {
        const m = this.measurements[f.index];
        if (!m) continue;
        m.hostFrame = f;
        m.hostFrameAt = t;
      }
    };
    eng.onChange = () => {
      this.renderTopState();
      if (eng.state === 'connected') this.reconnectDelay = 1500;
      this.scheduleReconnect();
    };
    // Phones suspend background tabs and drop Wi-Fi when the screen turns off: reconnect on return
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && eng.state !== 'connected' && eng.state !== 'connecting' && !this.userDisconnected) this.start();
    });
    window.addEventListener('online', () => {
      if (eng.state !== 'connected' && !this.userDisconnected) this.start();
    });
    this.refreshDevices();
    const info = await fetch('/api/info', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (info?.pinRequired && !this.remotePin) showRemoteConnect(this);
    else this.start();
  }

  private reconnectTimer = 0;
  private reconnectDelay = 1500;
  /** The user pressed Disconnect: don't reconnect automatically. */
  private userDisconnected = false;
  private autoReconnecting = false;

  /** After a lost connection, retry with back-off (not after a wrong PIN or a manual disconnect). */
  private scheduleReconnect(): void {
    const eng = this.engine as RemoteEngine;
    if (eng.state !== 'error' || this.userDisconnected || this.reconnectTimer || /PIN/.test(eng.lastError)) return;
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = 0;
      if (eng.state === 'connected' || this.userDisconnected) return;
      this.autoReconnecting = true;
      await this.start();
      this.autoReconnecting = false;
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
  }

  /** Called by the PIN dialog. */
  connectRemote(pin: string): void {
    this.remotePin = pin.trim();
    sessionStorage.setItem('cal-remote-pin', this.remotePin);
    this.start();
  }

  /** Apply the host's generator state and (when they change on the host) its calibration and channel setup. */
  adoptHost(st: HostStatus, force = false): void {
    const s = this.settings;
    // The host sends its status whenever anything changes (several times a second while music plays):
    // only re-render and save what actually changed, so controls the user is operating are not rebuilt
    const genChanged = force || JSON.stringify(s.generator) !== JSON.stringify(st.generator);
    s.generator = { ...st.generator };
    if (st.playlist && this.playlist instanceof RemotePlaylist) this.playlist.update(st.playlist);
    let changed = genChanged;
    if (this.hostProcessing && st.analysis && (st.analysis.rtaFft !== s.rtaFft || st.analysis.rtaAveraging !== s.rtaAveraging || st.analysis.tfAveraging !== s.tfAveraging || (st.analysis.lfResolution && st.analysis.lfResolution !== s.lfResolution))) {
      // The host's analysis settings apply to what this device shows
      Object.assign(s, st.analysis);
      for (const m of this.measurements) m.applySettings(s);
      this.syncSettingControls();
      changed = true;
    }
    const shared = JSON.stringify(st.shared);
    if (force || shared !== this.sharedApplied) {
      this.sharedApplied = shared;
      changed = true;
      if (s.splOffset !== st.shared.splOffset) this.spl.resetLeq(); // Leq / Lmax were in the old units
      s.splOffset = st.shared.splOffset;
      s.splCalibrated = st.shared.splCalibrated;
      s.micCal = st.shared.micCal;
      s.tempC = st.shared.tempC;
      s.measurements = JSON.parse(JSON.stringify(st.shared.measurements));
      this.spl.offsetDb = s.splOffset;
      this.updateCal();
      if (this.engine.running) this.rebuildMeasurements();
      this.renderMeasurements();
    }
    const label = `${st.deviceLabel}|${st.running}`;
    if (label !== this.lastHostLabel) {
      this.lastHostLabel = label;
      this.refreshDevices();
      changed = true;
    }
    if (!changed) return;
    this.save();
    if (genChanged) this.renderGenControls();
    this.renderTopState();
  }
  private lastHostLabel = '';

  /** How this page can host remote clients: the desktop app's built-in server, the CLI server, or not at all. */
  get serverMode(): 'desktop' | 'cli' | null {
    if (this.remote) return null;
    if (desktopBridge()) return 'desktop';
    if (this.hubPage?.role === 'host') return 'cli';
    return null;
  }

  private async initRemoteHost(): Promise<void> {
    if (this.serverMode === 'cli' && this.hubPage?.port && this.hubPage.token) {
      this.hostLink = new HostLink(this);
      this.hostLink.onChange = () => this.onRemoteChange();
      await this.hostLink.connect(this.hubPage.port, this.hubPage.token).catch(() => this.toast('Could not connect to the remote-access server', 'warn'));
    } else if (this.serverMode === 'desktop' && this.settings.remoteServer.enabled) {
      await this.startServer().catch(() => undefined);
    }
  }

  /** Start the desktop app's built-in remote-access server. */
  async startServer(): Promise<void> {
    const bridge = desktopBridge();
    if (!bridge) throw new Error('Remote access needs the desktop app');
    const rs = this.settings.remoteServer;
    try {
      const r = await bridge.server.start({ port: rs.port, pin: rs.pin, allowControl: rs.allowControl });
      this.hostLink ??= new HostLink(this);
      this.hostLink.onChange = () => this.onRemoteChange();
      await this.hostLink.connect(r.port, r.token);
      rs.enabled = true;
      this.save();
      this.toast(`Remote access on · port ${r.port}`, 'ok');
    } catch (e) {
      rs.enabled = false;
      this.save();
      this.toast(`Could not start remote access: ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'warn');
      throw e;
    } finally {
      this.onRemoteChange();
    }
  }

  async stopServer(): Promise<void> {
    this.hostLink?.disconnect();
    this.hostLink = null;
    await desktopBridge()?.server.stop();
    this.settings.remoteServer.enabled = false;
    this.save();
    this.onRemoteChange();
  }

  private onRemoteChange(): void {
    this.renderRemoteBadge();
    for (const v of this.views) v.invalidate?.();
  }

  private renderRemoteBadge(): void {
    const b = this.remoteBadge;
    if (this.remote) {
      const eng = this.engine as RemoteEngine;
      b.style.display = '';
      b.className = `remote-badge ${eng.state === 'connected' ? 'on' : 'off'}`;
      b.replaceChildren(icon('wifi', 14), h('span', {}, eng.state === 'connected' ? 'Remote' : eng.state === 'connecting' ? 'Connecting…' : 'Offline'));
      b.title = eng.state === 'connected' ? `Connected to the measurement host at ${location.host}` : 'Not connected to the measurement host · click to connect';
      b.onclick = () => (eng.state === 'connected' ? this.setView('tools') : this.start());
      return;
    }
    const link = this.hostLink;
    if (!link?.connected) {
      b.style.display = 'none';
      return;
    }
    const n = link.clients.length;
    b.style.display = '';
    b.className = `remote-badge on${n ? ' busy' : ''}`;
    b.replaceChildren(icon('wifi', 14), h('span', {}, n ? `${n} remote${n > 1 ? 's' : ''}` : 'Remote on'));
    b.title = 'Remote access is on · click for connection details';
    b.onclick = () => this.setView('tools');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Theme

  /** Apply the saved colour scheme to the document, canvases and the toggle button. */
  applyTheme(): void {
    const day = this.settings.theme === 'day';
    document.documentElement.dataset.theme = this.settings.theme;
    applyChartTheme(this.settings.theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', day ? '#ffffff' : '#000000');
    this.themeBtn.replaceChildren(icon(day ? 'moon' : 'sun', 18));
    this.themeBtn.title = day ? 'Switch to night mode (OLED black) — T' : 'Switch to day mode (high contrast for sunlight) — T';
    for (const v of this.views) v.invalidate?.();
  }

  /** Whole-app fullscreen toggle (hidden where the browser can't do it, e.g. iPhone Safari). */
  private fullscreenBtn(): HTMLElement | null {
    type FsDoc = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void; webkitFullscreenEnabled?: boolean };
    type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
    const doc = document as FsDoc;
    if (!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) return null;
    const btn = h('button', { class: 'btn icon-btn fullscreen-btn', onclick: () => this.toggleFullscreen() });
    const render = () => {
      const on = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      btn.replaceChildren(icon(on ? 'minimize' : 'maximize', 18));
      btn.title = on ? 'Exit fullscreen — F11' : 'Fullscreen — F11';
      btn.classList.toggle('on', on);
    };
    document.addEventListener('fullscreenchange', render);
    document.addEventListener('webkitfullscreenchange', render);
    render();
    this.toggleFullscreen = () => {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (doc.exitFullscreen) doc.exitFullscreen().catch(() => undefined);
        else doc.webkitExitFullscreen?.();
      } else {
        const el = document.documentElement as FsEl;
        if (el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => this.toast('Fullscreen is not available here', 'warn'));
        else el.webkitRequestFullscreen?.();
      }
    };
    return btn;
  }

  toggleFullscreen: () => void = () => undefined;

  toggleTheme(): void {
    this.settings.theme = this.settings.theme === 'day' ? 'night' : 'day';
    this.save();
    this.applyTheme();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Layout

  private build(): void {
    clear(this.root);
    this.startBtn = h('button', { class: 'btn btn-start', onclick: () => this.toggleEngine(), title: 'Start / stop audio (Enter)' });
    this.genBtn = h('button', { class: 'btn btn-gen', onclick: () => this.toggleGenerator(), title: 'Generator on/off (Space)' });
    this.sourceSel = h('select', { class: 'source', title: 'Audio input source' });
    this.sourceSel.addEventListener('change', () => {
      const v = this.sourceSel.value;
      this.settings.simulate = v === '__demo';
      if (!this.settings.simulate) this.settings.deviceId = v === '__default' ? '' : v;
      this.save();
      if (this.engine.running) this.start();
    });
    this.genControls = h('div', { class: 'gen-controls' });
    this.splMini = h('div', { class: 'spl-mini', title: 'Sound level (click for SPL meter)', onclick: () => this.setView('spl') });

    // Controls that move into the "more" sheet on small screens
    this.sourceGroup = h('div', { class: 'group src-group' }, this.sourceSel);
    this.genGroup = h('div', { class: 'group gen' }, h('span', { class: 'label' }, 'Generator'), this.genBtn, this.genControls);
    this.extraGroup = h(
      'div',
      { class: 'group extra-group' },
      this.fullscreenBtn(),
      this.themeBtn,
      h('button', { class: 'btn icon-btn', title: 'Help & shortcuts (?)', onclick: () => showHelp(this) }, icon('help', 18)),
      this.remote ? null : h('button', { class: 'btn icon-btn', title: 'Setup assistant', onclick: () => showWizard(this) }, icon('sparkle', 18)),
    );
    const drawerBtn = h('button', { class: 'btn icon-btn compact-only', title: 'Measurements, traces & assistant', onclick: () => this.toggleDrawer() }, icon('menu', 18));
    const moreBtn = h('button', { class: 'btn icon-btn compact-only', title: 'Source, generator & display settings', onclick: () => this.toggleSheet() }, icon('more', 18));
    this.startGroup = h('div', { class: 'group start-group' }, this.startBtn);
    this.topbar = h(
      'header',
      { class: 'topbar' },
      drawerBtn,
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'CAL'), h('div', { class: 'brand-text' }, h('b', {}, 'CAL Audio Analyzer'), h('span', {}, 'System & room measurement'))),
      this.startGroup,
      this.sourceGroup,
      this.genGroup,
      h('div', { class: 'spacer' }),
      this.remoteBadge,
      this.splMini,
      this.extraGroup,
      moreBtn,
    );
    const top = this.topbar;
    this.sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Settings' });
    this.scrim = h('div', { class: 'scrim', onclick: () => this.closeOverlays() });

    this.views = [
      new SpectrumView(this),
      new TransferView(this),
      new SpectrogramView(this),
      new ImpulseView(this),
      new RoomView(this),
      new EqView(this),
      new SplView(this),
      new ToolsView(this),
    ];
    this.tabs = h('nav', { class: 'tabs' });
    this.views.forEach((v, i) => {
      this.tabs.append(
        h('button', { class: 'tab', dataset: { view: v.id }, onclick: () => this.setView(v.id), title: `${v.title} (${i + 1})` }, icon(v.icon, 15), h('span', {}, v.title)),
      );
    });
    this.viewHost = h('main', { class: 'view-host' });
    for (const v of this.views) {
      v.el.classList.add('view');
      v.el.style.display = 'none';
      this.viewHost.append(v.el);
    }

    this.sidebarMeas = h('div', { class: 'meas-list' });
    this.sidebarTraces = h('div', { class: 'trace-list' });
    this.hintsEl = h('div', { class: 'hints' });
    const fileInput = h('input', { type: 'file', accept: '.csv,.txt,.frd,.json', multiple: true, style: 'display:none' });
    fileInput.addEventListener('change', () => this.importTraces(fileInput));
    const sidebar = h(
      'aside',
      { class: 'sidebar' },
      h(
        'section',
        {},
        h('div', { class: 'sec-head' }, h('h3', {}, 'Measurements'), h('button', { class: 'btn small ghost', onclick: () => this.addMeasurement(), title: 'Add a measurement (mic/reference pair)' }, icon('plus', 14), 'Add')),
        this.sidebarMeas,
      ),
      h(
        'section',
        { class: 'grow' },
        h(
          'div',
          { class: 'sec-head' },
          h('h3', {}, 'Traces'),
          h(
            'div',
            { class: 'row gap4' },
            h('button', { class: 'btn small ghost', onclick: () => fileInput.click(), title: 'Import measurement text (CSV, FRD, TXT)' }, icon('upload', 14)),
            h('button', { class: 'btn small ghost', onclick: () => this.averageSelected(), title: 'Power-average the selected traces' }, 'Avg'),
          ),
        ),
        this.sidebarTraces,
        fileInput,
      ),
      h('section', { class: 'assistant' }, h('div', { class: 'sec-head' }, h('h3', {}, icon('sparkle', 13), ' Assistant')), this.hintsEl),
    );

    this.metersEl = h('div', { class: 'meters' });
    this.statusEl = h('div', { class: 'status-text' });
    const status = h('footer', { class: 'statusbar' }, this.metersEl, h('div', { class: 'spacer' }), this.statusEl);
    this.root.append(top, h('div', { class: 'body' }, sidebar, h('div', { class: 'main-col' }, this.tabs, this.viewHost)), status, this.scrim, this.sheet);
    this.compactQuery.addEventListener('change', () => this.applyCompact());
    this.applyCompact();

    this.setView(this.settings.view);
    this.renderTopState();
    this.renderGenControls();
    this.renderMeasurements();
    this.renderTraces();
    this.refreshDevices();
  }

  toastHost = (() => {
    const el = h('div', { class: 'toasts' });
    document.body.append(el);
    return el;
  })();

  toast(text: string, level: 'info' | 'ok' | 'warn' = 'info'): void {
    const t = h('div', { class: `toast ${level}` }, icon(level === 'warn' ? 'alert' : level === 'ok' ? 'check' : 'info', 16), h('span', {}, text));
    this.toastHost.append(t);
    setTimeout(() => t.classList.add('out'), level === 'warn' ? 5200 : 3200);
    setTimeout(() => t.remove(), level === 'warn' ? 5600 : 3600);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Compact layout (phones, small tablets, small windows)

  private compactQuery = window.matchMedia('(max-width: 900px), (max-height: 560px)');
  private topbar!: HTMLElement;
  private sheet!: HTMLElement;
  private scrim!: HTMLElement;
  private sourceGroup!: HTMLElement;
  private genGroup!: HTMLElement;
  private extraGroup!: HTMLElement;
  private startGroup!: HTMLElement;
  compact = false;

  /** Switch between the full desktop layout and the compact one (one-row top bar, drawer, stacked panels). */
  private applyCompact(): void {
    const compact = this.compactQuery.matches;
    this.compact = compact;
    document.documentElement.classList.toggle('compact', compact);
    this.closeOverlays();
    if (compact) {
      this.sheet.replaceChildren(
        h('div', { class: 'sheet-head' }, h('b', {}, 'Settings'), h('button', { class: 'btn icon-btn ghost', title: 'Close', onclick: () => this.closeOverlays() }, icon('x', 18))),
        h('div', { class: 'sheet-sec' }, h('div', { class: 'remote-label' }, this.remote ? 'Measurement host' : 'Audio source'), this.sourceGroup),
        h('div', { class: 'sheet-sec' }, h('div', { class: 'remote-label' }, 'Generator'), this.genGroup),
        h('div', { class: 'sheet-sec' }, h('div', { class: 'remote-label' }, 'Display & help'), this.extraGroup),
      );
    } else {
      // Put the controls back into the top bar, in their original order
      this.startGroup.after(this.sourceGroup, this.genGroup);
      this.splMini.after(this.extraGroup);
    }
    for (const v of this.views) (v as View & { setCompact?(c: boolean): void }).setCompact?.(compact);
  }

  toggleDrawer(): void {
    const open = !this.root.classList.contains('drawer-open');
    this.closeOverlays();
    this.root.classList.toggle('drawer-open', open);
  }

  toggleSheet(): void {
    const open = !this.root.classList.contains('sheet-open');
    this.closeOverlays();
    this.root.classList.toggle('sheet-open', open);
  }

  closeOverlays(): void {
    this.root.classList.remove('drawer-open', 'sheet-open');
  }

  setView(id: ViewId): void {
    this.closeOverlays();
    const v = this.views.find((x) => x.id === id) ?? this.views[0];
    if (this.active && this.active !== v) {
      this.active.el.style.display = 'none';
      this.active.hide?.();
    }
    this.active = v;
    v.el.style.display = '';
    v.show?.();
    this.settings.view = v.id;
    this.save();
    for (const b of this.tabs.querySelectorAll<HTMLButtonElement>('.tab')) b.classList.toggle('active', b.dataset.view === v.id);
  }

  async refreshDevices(): Promise<void> {
    if (this.remote) {
      const st = (this.engine as RemoteEngine).status;
      clear(this.sourceSel);
      this.sourceSel.append(h('option', { value: '' }, `📡 Remote host: ${st ? st.deviceLabel : location.host}`));
      this.sourceSel.disabled = true;
      return;
    }
    const devices = await AudioEngine.listDevices().catch(() => []);
    const cur = this.settings.simulate ? '__demo' : this.settings.deviceId || '__default';
    clear(this.sourceSel);
    this.sourceSel.append(h('option', { value: '__demo' }, '🎧 Demo: virtual room'));
    this.sourceSel.append(h('option', { value: '__default' }, 'System default input'));
    devices
      .filter((d) => d.deviceId && d.deviceId !== 'default')
      .forEach((d, i) => this.sourceSel.append(h('option', { value: d.deviceId }, d.label || `Input device ${i + 1}`)));
    this.sourceSel.value = cur;
    if (this.sourceSel.value !== cur) this.sourceSel.value = '__default';
  }

  renderTopState(): void {
    const running = this.engine.running;
    clear(this.startBtn);
    if (this.remote) {
      const connected = (this.engine as RemoteEngine).state === 'connected';
      this.startBtn.append(icon(connected ? 'stop' : 'wifi', 16), h('span', {}, connected ? 'Disconnect' : 'Connect'));
      this.startBtn.classList.toggle('on', connected);
      this.startBtn.title = connected ? 'Disconnect from the measurement host' : 'Connect to the measurement host';
    } else {
      this.startBtn.append(icon(running ? 'stop' : 'power', 16), h('span', {}, running ? 'Stop' : 'Start'));
      this.startBtn.classList.toggle('on', running);
    }
    this.renderRemoteBadge();
    const g = this.settings.generator;
    clear(this.genBtn);
    this.genBtn.append(icon(g.type === 'off' ? 'play' : 'pause', 14), h('span', {}, g.type === 'off' ? 'Off' : 'On'));
    this.genBtn.classList.toggle('on', g.type !== 'off');
  }

  renderGenControls(): void {
    const g = this.settings.generator;
    clear(this.genControls);
    const types: { value: GeneratorType; label: string }[] = [
      { value: 'pink', label: 'Pink noise' },
      { value: 'white', label: 'White noise' },
      { value: 'sine', label: 'Sine' },
      { value: 'sweep', label: 'Periodic sweep' },
      { value: 'music', label: 'Music (playlist)' },
    ];
    const cur = g.type === 'off' ? (this.lastGenType ?? 'pink') : g.type;
    this.genControls.append(
      select(types, cur, (v) => {
        this.lastGenType = v;
        if (g.type !== 'off') this.setGenerator({ type: v });
        this.renderGenControls();
        if (v === 'music' && !this.playlist.state().tracks.length) showPlaylist(this);
      }, { title: 'Signal type' }),
    );
    this.musicCtl = null;
    if (cur === 'music') {
      this.musicCtl = new MusicControls(this);
      this.genControls.append(this.musicCtl.el);
    }
    if (cur === 'sine') {
      const fi = h('input', { type: 'number', value: String(g.freq), min: '10', max: '24000', step: '1', class: 'num', title: 'Sine frequency (Hz)' });
      fi.addEventListener('change', () => this.setGenerator({ freq: Math.max(10, Math.min(this.fs / 2, +fi.value || 1000)) }));
      this.genControls.append(fi, h('span', { class: 'unit' }, 'Hz'));
    }
    const lvlVal = h('span', { class: 'lvl-val' }, `${g.level} dBFS`);
    const lvl = h('input', { type: 'range', min: '-60', max: '0', step: '1', value: String(g.level), class: 'lvl', title: 'Generator level' });
    lvl.addEventListener('input', () => {
      lvlVal.textContent = `${lvl.value} dBFS`;
      this.setGenerator({ level: +lvl.value });
    });
    this.genControls.append(lvl, lvlVal);
    const outs = this.engine.outputChannels;
    const outSel = h('select', { title: 'Output channels', class: 'outsel' });
    const opts: { v: string; l: string }[] = [
      { v: '0,1', l: 'Out 1+2' },
      { v: '0', l: 'Out 1' },
      { v: '1', l: 'Out 2' },
    ];
    for (let c = 2; c < Math.min(outs, 16); c++) opts.push({ v: String(c), l: `Out ${c + 1}` });
    for (const o of opts) outSel.append(h('option', { value: o.v }, o.l));
    outSel.value = g.outputs.join(',');
    outSel.addEventListener('change', () => this.setGenerator({ outputs: outSel.value.split(',').map(Number) }));
    this.genControls.append(outSel);
  }

  // Sidebar: measurements -----------------------------------------------------------------------------------

  addMeasurement(): void {
    const n = this.settings.measurements.length;
    const nCh = Math.max(this.engine.channelCount, 2);
    const cfg: MeasurementConfig = {
      id: `m${Date.now().toString(36)}`,
      name: `Mic ${n + 1}`,
      color: PALETTE[n % PALETTE.length],
      mic: Math.min(n, nCh - 1),
      ref: this.settings.measurements[0]?.ref ?? GEN_CHANNEL,
      delay: 0,
      enabled: true,
      invert: false,
    };
    if (cfg.mic === cfg.ref) cfg.mic = 0;
    this.settings.measurements.push(cfg);
    if (this.engine.running) this.measurements.push(new Measurement(cfg, this.fs, this.grid, this.settings));
    this.save();
    this.renderMeasurements();
  }

  removeMeasurement(id: string): void {
    if (this.settings.measurements.length <= 1) return this.toast('At least one measurement is needed', 'warn');
    this.settings.measurements = this.settings.measurements.filter((m) => m.id !== id);
    this.measurements = this.measurements.filter((m) => m.cfg.id !== id);
    this.save();
    this.renderMeasurements();
  }

  channelOptions(includeGen: boolean): { value: number; label: string }[] {
    const n = Math.max(this.engine.channelCount, this.engine.running ? 1 : 2);
    const out: { value: number; label: string }[] = [];
    if (includeGen) out.push({ value: GEN_CHANNEL, label: 'Generator (internal)' });
    for (let c = 0; c < n; c++) out.push({ value: c, label: this.engine.simulate && c === 1 ? 'In 2 (loopback)' : `In ${c + 1}` });
    return out;
  }

  renderMeasurements(): void {
    clear(this.sidebarMeas);
    for (const cfg of this.settings.measurements) {
      const m = this.measurements.find((x) => x.cfg.id === cfg.id);
      const name = h('input', { class: 'name', value: cfg.name, title: 'Rename' });
      name.addEventListener('change', () => {
        cfg.name = name.value || cfg.name;
        this.save();
      });
      const color = h('input', { type: 'color', value: cfg.color, class: 'swatch', title: 'Colour' });
      color.addEventListener('input', () => {
        cfg.color = color.value;
        this.save();
      });
      const enable = h('input', { type: 'checkbox', checked: cfg.enabled, title: 'Show / process this measurement' });
      enable.addEventListener('change', () => {
        cfg.enabled = enable.checked;
        this.save();
      });
      const delayMs = (cfg.delay / this.fs) * 1000;
      const delayInput = h('input', { type: 'number', class: 'num', step: '0.01', value: delayMs.toFixed(2), title: 'Reference delay compensation (ms)' });
      delayInput.addEventListener('change', () => {
        cfg.delay = Math.max(0, Math.round(((+delayInput.value || 0) / 1000) * this.fs));
        m?.reset();
        this.save();
        this.renderMeasurements();
      });
      const dist = (delayMs / 1000) * speedOfSound(this.settings.tempC);
      const card = h(
        'div',
        { class: `meas-card${cfg.enabled ? '' : ' disabled'}`, style: `--c:${cfg.color}` },
        h('div', { class: 'row' }, enable, color, name, h('button', { class: 'btn tiny ghost', title: 'Remove', onclick: () => this.removeMeasurement(cfg.id) }, icon('x', 13))),
        h(
          'div',
          { class: 'grid2' },
          h('label', {}, h('span', {}, icon('mic', 12), ' Mic'), select(this.channelOptions(false), cfg.mic, (v) => { cfg.mic = v; m?.reset(); this.save(); })),
          h('label', {}, h('span', {}, icon('wave', 12), ' Ref'), select(this.channelOptions(true), cfg.ref, (v) => { cfg.ref = v; m?.reset(); this.save(); })),
        ),
        h(
          'div',
          { class: 'row delay-row' },
          h('span', { class: 'dim' }, 'Delay'),
          delayInput,
          h('span', { class: 'unit' }, 'ms'),
          h('span', { class: 'dim small nowrap' }, `${dist.toFixed(2)} m`),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn tiny accent', title: 'Find delay automatically (D)', onclick: () => m && this.findDelay(m), disabled: !m }, icon('target', 13), 'Find'),
        ),
        h(
          'div',
          { class: 'row' },
          h('label', { class: 'check', title: 'Invert polarity of the measurement' }, (() => {
            const c = h('input', { type: 'checkbox', checked: cfg.invert });
            c.addEventListener('change', () => { cfg.invert = c.checked; this.save(); });
            return c;
          })(), 'Invert'),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn tiny', title: 'Store the current transfer function as a trace (C)', onclick: () => m && this.captureTrace(m, 'tf'), disabled: !m }, icon('camera', 13), 'TF'),
          h('button', { class: 'btn tiny', title: 'Store the current RTA as a trace', onclick: () => m && this.captureTrace(m, 'rta'), disabled: !m }, icon('camera', 13), 'RTA'),
        ),
      );
      this.sidebarMeas.append(card);
    }
  }

  // Sidebar: traces -----------------------------------------------------------------------------------------

  renderTraces(): void {
    clear(this.sidebarTraces);
    if (!this.traces.traces.length) {
      this.sidebarTraces.append(h('div', { class: 'empty' }, 'No traces yet. Capture one with the camera buttons or press C.'));
      return;
    }
    for (const t of [...this.traces.traces].reverse()) {
      const sel = h('input', { type: 'checkbox', checked: this.selectedTraces.has(t.id), title: 'Select (for averaging)' });
      sel.addEventListener('change', () => (sel.checked ? this.selectedTraces.add(t.id) : this.selectedTraces.delete(t.id)));
      const name = h('input', { class: 'name', value: t.name });
      name.addEventListener('change', () => this.traces.update(t.id, { name: name.value }));
      const color = h('input', { type: 'color', value: t.color, class: 'swatch' });
      color.addEventListener('input', () => this.traces.update(t.id, { color: color.value }));
      const off = h('input', { type: 'number', class: 'num tiny-num', value: String(t.offset), step: '0.5', title: 'Display offset (dB)' });
      off.addEventListener('change', () => this.traces.update(t.id, { offset: +off.value || 0 }));
      this.sidebarTraces.append(
        h(
          'div',
          { class: `trace${t.visible ? '' : ' hidden'}` },
          sel,
          color,
          h('div', { class: 'trace-main' }, name, h('div', { class: 'trace-meta' }, h('span', { class: `kind ${t.kind}` }, t.kind.toUpperCase()), off, h('span', { class: 'unit' }, 'dB'))),
          h('button', { class: 'btn tiny ghost', title: t.visible ? 'Hide' : 'Show', onclick: () => this.traces.update(t.id, { visible: !t.visible }) }, icon(t.visible ? 'eye' : 'eyeOff', 14)),
          h('button', { class: 'btn tiny ghost', title: 'Export CSV', onclick: () => download(`${t.name.replace(/[^\w.-]+/g, '_')}.csv`, traceToCsv(t)) }, icon('download', 14)),
          h('button', { class: 'btn tiny ghost', title: 'Delete', onclick: () => this.traces.remove(t.id) }, icon('trash', 14)),
        ),
      );
    }
  }

  private averageSelected(): void {
    const ids = [...this.selectedTraces];
    if (ids.length < 2) return this.toast('Select two or more traces (checkboxes) to average', 'warn');
    const t = this.traces.average(ids, `Average (${ids.length})`);
    if (t) this.toast(`Created “${t.name}”`, 'ok');
    this.selectedTraces.clear();
  }

  private async importTraces(input: HTMLInputElement): Promise<void> {
    for (const file of Array.from(input.files ?? [])) {
      try {
        const data = parseTraceText(await file.text());
        this.traces.add({ name: file.name.replace(/\.[^.]+$/, ''), kind: data.phase ? 'tf' : 'rta', ...data, note: `Imported from ${file.name}` });
        this.toast(`Imported ${file.name}`, 'ok');
      } catch (e) {
        this.toast(`${file.name}: ${(e as Error).message}`, 'warn');
      }
    }
    input.value = '';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Main loop

  private frameToken = 0;
  private frameTimer = 0;
  private frameCount = 0;

  /**
   * Schedule the next frame on every window that can show panels (main window + detached panel windows)
   * and a timer fallback. Whichever fires first runs the frame, so a detached panel keeps updating when it
   * covers or replaces the main window (e.g. full screen on a second monitor), where the browser pauses the
   * main window's animation frames.
   */
  private scheduleFrame(): void {
    const token = ++this.frameToken;
    const run = () => {
      if (token !== this.frameToken) return;
      this.frameToken++;
      clearTimeout(this.frameTimer);
      this.loop();
    };
    requestAnimationFrame(run);
    for (const w of Dock.openWindows()) {
      try {
        w.requestAnimationFrame(run);
      } catch {
        /* window closing */
      }
    }
    this.frameTimer = window.setTimeout(run, 40);
  }

  private loop = (): void => {
    const t0 = performance.now();
    this.adaptQuality(t0);
    // Adaptive drawing: slow devices (e.g. phones on remote) still process every audio block but draw less often
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    const drawEvery = avg > 30 ? 3 : avg > 15 ? 2 : 1;
    const draw = this.frameCount++ % drawEvery === 0;
    if (this.engine.running) {
      const needs = this.analysisNeeds();
      const now = performance.now();
      for (const m of this.measurements) {
        // Host processing: use the host's analysis while it arrives, fall back to local processing otherwise
        const fromHost = this.hostProcessing && !!m.hostFrame && now - m.hostFrameAt < 1500;
        if (!this.busy) m.process(this.engine, fromHost ? { rta: false, tf: needs.tfLocal } : { rta: needs.rta, tf: needs.tf || needs.tfLocal });
        if (draw) {
          if (fromHost) m.renderHost(this.settings, this.cal);
          else m.render(this.settings, this.cal);
        }
      }
      this.splReading = this.spl.read(this.settings.splTime);
    }
    if (this.frameCount % 15 === 0) {
      if (this.playlist instanceof Playlist && this.settings.generator.type === 'music' && this.engine.running) this.playlist.ensureLoaded();
      this.musicCtl?.update();
    }
    if (draw) {
      this.active?.tick();
      // Detached panels of other tabs keep updating too
      for (const v of this.views) if (v !== this.active && v.hasDetached?.()) v.tick(true);
      this.renderStatus();
    }
    this.frameTimes.push(performance.now() - t0);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    this.scheduleFrame();
  };

  private renderStatus(): void {
    const e = this.engine;
    // SPL mini readout
    const r = this.splReading;
    const unit = this.settings.splCalibrated ? `dB${this.settings.splWeighting}` : `dBFS ${this.settings.splWeighting}`;
    this.splMini.innerHTML = e.running && r ? `<b>${r.level.toFixed(1)}</b><span>${unit}</span><em>Leq ${r.leq.toFixed(1)}</em>` : `<b>—</b><span>${unit}</span>`;
    // Input meters
    if (this.metersEl.childElementCount !== e.levels.length + 1) {
      clear(this.metersEl);
      e.levels.forEach((_, i) =>
        this.metersEl.append(
          h('div', { class: 'meter', title: `Input ${i + 1} — click to reset clip`, onclick: () => (e.levels[i].clipped = false) }, h('span', {}, `In${i + 1}`), h('div', { class: 'bar' }, h('i', {}), h('b', {})), h('em', {}, '')),
        ),
      );
      this.metersEl.append(h('div', { class: 'meter gen', title: 'Generator output' }, h('span', {}, 'Gen'), h('div', { class: 'bar' }, h('i', {}), h('b', {})), h('em', {}, '')));
    }
    const all = [...e.levels, e.genLevel];
    Array.from(this.metersEl.children).forEach((el, i) => {
      const l = all[i];
      if (!l) return;
      const pkDb = 20 * Math.log10(Math.max(l.peak, 1e-6));
      const rmsDb = 20 * Math.log10(Math.max(l.rms, 1e-6)) + 3.01;
      const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 72) / 72) * 100))}%`;
      (el.querySelector('i') as HTMLElement).style.width = pct(rmsDb);
      (el.querySelector('b') as HTMLElement).style.left = pct(pkDb);
      (el.querySelector('em') as HTMLElement).textContent = e.running ? `${pkDb > -99 ? pkDb.toFixed(0) : '-∞'}` : '';
      el.classList.toggle('clip', l.clipped);
      el.classList.toggle('hot', pkDb > -6);
    });
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    const remoteInfo = this.remote ? ' · remote client' : this.hostLink?.connected ? ` · remote access on (${this.hostLink.clients.length} connected)` : '';
    this.statusEl.textContent = e.running
      ? `${e.deviceLabel} · ${(e.sampleRate / 1000).toFixed(1)} kHz · ${e.channelCount} in · DSP ${avg.toFixed(1)} ms/frame${remoteInfo}`
      : this.remote
        ? (this.engine as RemoteEngine).state === 'connected'
          ? 'Connected · audio on the measurement host is stopped'
          : 'Not connected to the measurement host'
        : `Audio stopped${remoteInfo}`;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Assistant hints

  hints(): Hint[] {
    const e = this.engine;
    const out: Hint[] = [];
    if (this.remote) {
      const r = e as RemoteEngine;
      if (r.state !== 'connected') {
        out.push({ level: 'warn', text: r.lastError ? `Not connected: ${r.lastError}` : 'Not connected to the measurement host.', action: { label: 'Connect', run: () => this.start() } });
        return out;
      }
      if (!r.hostConnected) out.push({ level: 'warn', text: 'The measurement host app is not connected to its server. Check the host computer.' });
      else if (!e.running) out.push({ level: 'info', text: 'Audio on the measurement host is stopped.', action: r.allowControl ? { label: 'Start host audio', run: () => this.start() } : undefined });
      if (r.droppedBlocks > 0) {
        out.push({ level: 'warn', text: 'The network is too slow for the live audio stream, so some audio was dropped. Move closer to the Wi-Fi access point or use 5 GHz Wi-Fi / Ethernet.' });
        r.droppedBlocks = 0;
      }
      if (!r.allowControl) out.push({ level: 'info', text: 'View-only: the host has disabled remote control of the generator and sweeps.' });
      if (!e.running) return out;
    }
    if (!e.running) {
      out.push({ level: 'info', text: 'Audio is stopped. Press Start. No hardware? The demo room lets you try every feature.', action: { label: 'Start', run: () => this.start() } });
      return out;
    }
    const clipped = e.levels.findIndex((l) => l.clipped);
    if (clipped >= 0) out.push({ level: 'warn', text: `Input ${clipped + 1} clipped. Lower the preamp gain or the generator level. (Click its meter to reset.)` });
    const g = this.settings.generator;
    const needsExcitation = ['transfer', 'impulse', 'eq'].includes(this.settings.view);
    if (g.type === 'off' && needsExcitation) {
      out.push({ level: 'info', text: 'The generator is off. Transfer-function measurements need an excitation signal — pink noise is the usual choice.', action: { label: 'Pink noise on', run: () => { this.setGenerator({ type: 'pink' }); this.renderGenControls(); } } });
    }
    if (g.level > -6 && g.type !== 'off') out.push({ level: 'warn', text: 'Generator level is very high. Start low (−20 dBFS) and raise the amplifier gain gradually to protect loudspeakers and ears.' });
    for (const m of this.measurements) {
      if (!m.cfg.enabled) continue;
      const lvl = e.levels[m.cfg.mic];
      if (lvl && lvl.peak < 0.001 && !e.simulate) out.push({ level: 'warn', text: `${m.cfg.name}: no signal on In ${m.cfg.mic + 1}. Check phantom power, cable and input gain.` });
      if (m.cfg.ref === m.cfg.mic) out.push({ level: 'warn', text: `${m.cfg.name}: mic and reference are the same channel.` });
      if (g.type !== 'off' && m.tfReady && !this.busy) {
        let s = 0;
        let n = 0;
        for (let i = 0; i < this.grid.length; i++) {
          if (this.grid[i] > 200 && this.grid[i] < 8000) {
            s += m.result.coh[i];
            n++;
          }
        }
        const c = n ? s / n : 0;
        if (c < 0.35 && m.cfg.delay === 0) {
          out.push({ level: 'warn', text: `${m.cfg.name}: very low coherence — the reference delay is probably not set.`, action: { label: 'Find delay', run: () => this.findDelay(m) } });
        } else if (c < 0.6) {
          out.push({ level: 'warn', text: `${m.cfg.name}: coherence is low (${(c * 100).toFixed(0)}%). Background noise or reverberation dominate — raise the level, move the mic closer, or re-run Find delay.`, action: { label: 'Find delay', run: () => this.findDelay(m) } });
        } else if (c > 0.85) {
          out.push({ level: 'ok', text: `${m.cfg.name}: good coherence (${(c * 100).toFixed(0)}%). Data is trustworthy — capture a trace with C.` });
        }
      }
    }
    if (this.hostLink?.connected && this.hostLink.clients.length) out.push({ level: 'ok', text: `${this.hostLink.clients.length} remote client${this.hostLink.clients.length > 1 ? 's are' : ' is'} connected and receiving live audio.` });
    if (e.simulate) out.push({ level: 'info', text: 'Demo mode: a virtual loudspeaker in a reverberant room with modes at 47, 94 and 142 Hz. Nothing is played through your speakers.' });
    if (!this.settings.splCalibrated && this.settings.view === 'spl') out.push({ level: 'info', text: 'SPL readings are in dBFS until you calibrate with a 94 dB or 114 dB calibrator (Tools → SPL calibration).' });
    return out;
  }

  private updateHints(): void {
    const hints = this.hints();
    const key = hints.map((x) => x.text).join('|');
    if (key === this.lastHints) return;
    this.lastHints = key;
    clear(this.hintsEl);
    for (const hint of hints.slice(0, 4)) {
      this.hintsEl.append(
        h(
          'div',
          { class: `hint ${hint.level}` },
          icon(hint.level === 'warn' ? 'alert' : hint.level === 'ok' ? 'check' : 'info', 14),
          h('div', {}, h('p', {}, hint.text), hint.action ? h('button', { class: 'btn tiny accent', onclick: hint.action.run }, hint.action.label) : null),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Keyboard

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      // Enter / Space on a focused button or link activate that control: don't also run a shortcut
      if ((e.key === 'Enter' || e.key === ' ') && target?.closest('button, a, [role="button"]')) return;
      // A dialog is open: shortcuts would act on the app behind it
      if (document.querySelector('.modal-overlay') && e.key !== 'F11') return;
      const m = this.measurements.find((x) => x.cfg.enabled);
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.toggleGenerator();
          break;
        case 'Enter':
          this.toggleEngine();
          break;
        case 'c':
        case 'C':
          if (m) this.captureTrace(m, 'tf');
          break;
        case 'r':
        case 'R':
          this.resetAverages();
          break;
        case 'd':
        case 'D':
          if (m) this.findDelay(m);
          break;
        case 'p':
        case 'P':
          this.settings.peakHold = !this.settings.peakHold;
          this.save();
          break;
        case 'f':
        case 'F':
          for (const x of this.measurements) x.frozen = !x.frozen;
          this.toast(this.measurements[0]?.frozen ? 'Display frozen' : 'Display live');
          break;
        case 'b':
        case 'B':
          (this.views.find((v) => v.id === 'spectrum') as SpectrumView).setStyle(this.settings.rtaStyle === 'bars' ? 'line' : 'bars');
          break;
        case 'F11':
          if (desktopBridge()) break; // the desktop app's View menu handles F11
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case '?':
          showHelp(this);
          break;
        case 't':
        case 'T':
          this.toggleTheme();
          break;
        default:
          if (/^[1-8]$/.test(e.key)) this.setView(this.views[+e.key - 1].id);
      }
    });
  }
}

export { SMOOTHING_OPTIONS, refLabel };

/** A friendly name for this remote device, shown on the host. */
function remoteClientName(): string {
  const ua = navigator.userAgent;
  const device = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device} · ${browser}` : device;
}
