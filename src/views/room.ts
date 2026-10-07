import { CHART, BAND_COLORS } from '../ui/theme';
import type { App, View } from '../app';
import { Plot, escapeHtml } from '../ui/plot';
import { h, icon, select, clear } from '../ui/dom';
import { logSweep, deconvolve, linearIR, harmonicDistortion, spectrumOf, type SweepSpec, type Deconvolution } from '../dsp/sweep';
import { roomAcoustics, energyTimeCurve, schroederFrequency, type AcousticsResult, type BandAcoustics } from '../dsp/acoustics';
import { LogSmoother, type Smoothing } from '../dsp/freq';
import { nextPow2 } from '../dsp/fft';
import type { SweepMeta } from '../remote/protocol';
import { waterfall, WATERFALL_PRESETS, type WaterfallResult } from '../dsp/waterfall';
import { WaterfallPlot, DEFAULT_WATERFALL_VIEW, type WaterfallView } from '../ui/waterfall-plot';
import { optionsMenu, optRow, optHead } from '../ui/popover';
import { TargetOverlay } from './target-overlay';
import { diagnose, type Diagnosis, type FindingKind } from '../dsp/diagnose';
import { speedOfSound } from '../dsp/delay';
import { axialModes, modeDimension } from './modes';
import type { Trace } from '../traces';
import { GraphNotes } from './graph-notes';

/** How each kind of diagnosis finding is labelled (text first, colour second). */
const DX_KIND: Record<FindingKind, { label: string; short: string; color: string }> = {
  mode: { label: 'Room mode', short: 'Mode', color: '#ff9f1c' },
  sbir: { label: 'SBIR', short: 'SBIR', color: '#ff4d6d' },
  null: { label: 'Modal null', short: 'Null', color: '#b18cff' },
  reflection: { label: 'Reflection', short: 'Refl.', color: '#4cc9f0' },
};

interface SweepResult {
  spec: SweepSpec;
  d: Deconvolution;
  ir: Float64Array;
  t0: number;
  fr: Float64Array;
  thd: Float64Array;
  h2: Float64Array;
  h3: Float64Array;
  h4: Float64Array;
  h5: Float64Array;
  /** THD (%) the background noise alone would show (see harmonicDistortion). */
  floor: Float64Array;
  /** Fundamental level of the distortion analysis, dB (same reference as the harmonics). */
  fund: Float64Array;
  acoustics: AcousticsResult;
  etc: Float64Array;
  peakDb: number;
  noiseDb: number;
  channel: number;
  when: Date;
}

/**
 * Log-sweep measurement: impulse response, frequency response, harmonic distortion and ISO 3382 room acoustic
 * parameters (EDT, T20, T30, C50, C80, D50, Ts) per octave or third-octave band.
 */
/** Quick angles for the waterfall. */
const WATERFALL_ANGLES: { id: string; label: string; hint: string; view: Partial<WaterfallView> }[] = [
  { id: 'standard', label: '3-D', hint: 'The standard 3-D view (also: double-click the graph)', view: DEFAULT_WATERFALL_VIEW },
  { id: 'front', label: 'Front', hint: 'Straight from the front: the slices stacked as level over frequency', view: { yaw: 0, pitch: 0, zoom: 1 } },
  { id: 'side', label: 'Side', hint: 'From the side: how each frequency decays over time', view: { yaw: 72, pitch: 10, zoom: 1 } },
  { id: 'top', label: 'Above', hint: 'From high above: where the ridges run back in time', view: { yaw: 8, pitch: 62, zoom: 1 } },
];

export class RoomView implements View {
  id = 'room' as const;
  title = 'Sweep & Room';
  icon = 'home' as const;
  el = h('div', { class: 'room' });
  private opts = { duration: 4, level: -12, repeats: 1, f1: 20, f2: 20000, fraction: 1 as 1 | 3, window: 500, smoothing: 6 as Smoothing, measIdx: 0, positions: 1 };
  /** A guided series of sweeps at several mic positions (null when none is running). */
  private series: { n: number; traces: Trace[]; answer: ((choice: 'go' | 'finish' | 'cancel') => void) | null } | null = null;
  private seriesBar = h('div', { class: 'series-bar', hidden: true });
  /** Remote devices: resolves when the sweep this device asked the host for has finished (true with a result). */
  private hostWaiter: ((ok: boolean) => void) | null = null;
  private running: { cancelled: boolean } | null = null;
  private progress = h('div', { class: 'progress' }, h('i', {}));
  private statusText = h('span', { class: 'dim' }, 'Ready.');
  private measureBtn!: HTMLButtonElement;
  private result: SweepResult | null = null;
  private fr: Plot;
  private irPlot: Plot;
  private decay: Plot;
  private table = h('div', { class: 'rt-table' });
  private cards = h('div', { class: 'cards' });
  private tab: 'fr' | 'thd' | 'ir' | 'rt' | 'wf' | 'dx' = 'fr';
  /** Distortion: THD and harmonics 2–5 in percent of the fundamental, with the measurement floor. */
  private thdPlot: Plot;
  private thdInfo = h('div', { class: 'thd-info', 'aria-live': 'polite' });
  private wf = new WaterfallPlot('Waterfall: cumulative spectral decay');
  private wfOpts: { preset: 'bass' | 'full'; range: number } = { preset: 'bass', range: 45 };
  private wfFor: { result: unknown; preset: string } | null = null;

  /** Remember the waterfall's angle (turned with the mouse or the view buttons). */
  private saveWfView(): void {
    this.app.settings.waterfallView = { ...this.wf.view };
    this.app.save();
  }
  private tabHost = h('div', { class: 'subtabs' });
  private content = h('div', { class: 'room-content' });
  private selHost = h('span', {});
  private dirty = true;
  /** Target curve on the frequency response (its own choice, separate from the live views). */
  private target: TargetOverlay;
  private targetKey = '';
  private notes: GraphNotes;

  constructor(private app: App) {
    this.target = new TargetOverlay(app, 'roomTargetCurve', false);
    this.wf.view = { ...app.settings.waterfallView };
    this.wf.enableRotation();
    this.wf.onViewChange = () => this.saveWfView();
    this.fr = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -50, yMax: 10, yUnit: 'dB', yStep: 6, title: 'Frequency response', showNote: true, yLimits: [-200, 100] });
    this.thdPlot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: 0, yMax: 5, yUnit: '%', yStep: 1, title: 'Harmonic distortion (% of the fundamental, at the frequency played)', yLimits: [0, 100] });
    this.thdPlot.placeholder = 'No sweep yet: press Measure sweep';
    this.irPlot = new Plot({ xType: 'lin', xMin: -5, xMax: 300, yMin: -90, yMax: 3, yUnit: 'dB', xUnit: 'ms', yStep: 10, title: 'Energy-time curve', yLimits: [-200, 20] });
    this.notes = new GraphNotes(app, 'room', this.fr);
    for (const p of [this.fr, this.irPlot]) p.placeholder = 'No sweep yet: press Measure sweep';
    this.decay = new Plot({ xType: 'lin', xMin: 0, xMax: 1500, yMin: -70, yMax: 2, yUnit: 'dB', xUnit: 'ms', yStep: 10, title: 'Schroeder decay curves', yLimits: [-200, 20] });
    this.decay.placeholder = 'No sweep yet: press Measure sweep';
    this.build();
  }

  private build(): void {
    const o = this.opts;
    this.measureBtn = h('button', { class: 'btn accent big', onclick: () => (this.running ? this.cancel() : this.opts.positions > 1 ? this.measurePositions(this.opts.positions) : this.measure()) });
    this.setMeasureLabel();
    const lvl = h('input', { type: 'number', class: 'num', value: String(o.level), min: '-60', max: '0', step: '1' });
    lvl.addEventListener('change', () => (o.level = Math.min(0, Math.max(-60, +lvl.value))));
    const sweepOptions = optionsMenu(
      [
        optHead('Sweep'),
        optRow('Repeats', select([1, 2, 4, 8].map((v) => ({ value: v, label: `${v}× (averaged)` })), o.repeats, (v) => (o.repeats = v), { title: 'More repeats lower the noise floor' })),
        optRow(
          'Range',
          select([{ value: 20, label: '20 Hz' }, { value: 10, label: '10 Hz' }, { value: 40, label: '40 Hz' }, { value: 80, label: '80 Hz' }], o.f1, (v) => (o.f1 = v), { 'aria-label': 'Sweep start frequency' }),
          '–',
          select([{ value: 20000, label: '20 kHz' }, { value: 16000, label: '16 kHz' }, { value: 10000, label: '10 kHz' }, { value: 1000, label: '1 kHz (sub)' }], o.f2, (v) => (o.f2 = v), { 'aria-label': 'Sweep end frequency' }),
        ),
      ],
      { label: 'Sweep options', title: 'Sweep options: repeats and frequency range', id: 'sweep' },
    );
    const settings = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Measurement'), this.selHost),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Sweep'), select([1, 2, 4, 8, 16].map((v) => ({ value: v, label: `${v} s` })), o.duration, (v) => (o.duration = v))),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Level'), lvl, h('span', { class: 'unit' }, 'dBFS')),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'Positions'),
        select(
          [1, 3, 4, 5, 6, 8].map((v) => ({ value: v, label: v === 1 ? '1 (one spot)' : `${v} (averaged)` })),
          o.positions,
          (v) => {
            o.positions = v;
            this.setMeasureLabel();
          },
          { title: 'Measure at several mic positions, one sweep each, guided step by step; the result is their power average (a spatial average, the best basis for room EQ)', dataset: { sweep: 'positions' } },
        ),
      ),
      sweepOptions,
      h('div', { class: 'spacer' }),
      this.measureBtn,
    );
    const analysisOptions = optionsMenu(
      [
        optHead('Analysis'),
        optRow('FR window', select([{ value: 5, label: '5 ms (gated)' }, { value: 20, label: '20 ms' }, { value: 100, label: '100 ms' }, { value: 500, label: '500 ms' }, { value: 2000, label: 'Full' }], o.window, (v) => { o.window = v; this.recompute(); }, { title: 'Time window for the frequency response: short windows leave out room reflections' })),
        optRow('Smoothing', select([48, 24, 12, 6, 3, 1].map((v) => ({ value: v as Smoothing, label: `1/${v} octave` })), o.smoothing, (v) => { o.smoothing = v; this.recompute(); })),
        optRow('RT bands', select([{ value: 1 as const, label: 'Octave' }, { value: 3 as const, label: '1/3 octave' }], o.fraction, (v) => { o.fraction = v; this.recompute(true); })),
        optHead('Export'),
        h('div', { class: 'opt-ctl' }, h('button', { class: 'btn small', onclick: () => this.exportIr(), title: 'Download the impulse response as a WAV file' }, icon('download', 14), 'Impulse response .wav')),
      ],
      { label: 'Analysis', title: 'Analysis: FR window, smoothing, RT bands, IR export', id: 'room-analysis' },
    );
    const bar = h('div', { class: 'progress-row' }, this.progress, this.statusText);
    this.renderTabs();
    const tabsRow = h('div', { class: 'room-tabs-row' }, this.tabHost, h('div', { class: 'spacer' }), this.target.targetControl(), this.notes.button(), analysisOptions, h('button', { class: 'btn small', onclick: () => this.saveTrace(), title: 'Store the frequency response as a trace (shown on Transfer and on Spectrum, levelled to the live curve)' }, icon('camera', 14), 'Save FR as trace'));
    this.el.append(settings, bar, this.seriesBar, this.cards, tabsRow, this.content);
    this.showTab();
  }

  private setMeasureLabel(): void {
    clear(this.measureBtn);
    this.measureBtn.append(icon(this.running ? 'stop' : 'play', 16), h('span', {}, this.running ? 'Cancel' : this.opts.positions > 1 ? `Measure ${this.opts.positions} positions` : 'Measure sweep'));
    this.measureBtn.style.display = this.series && !this.running ? 'none' : '';
  }

  private renderTabs(): void {
    clear(this.tabHost);
    const tabs: { id: 'fr' | 'thd' | 'ir' | 'rt' | 'wf' | 'dx'; label: string }[] = [
      { id: 'fr', label: 'Frequency response' },
      { id: 'thd', label: 'Distortion' },
      { id: 'ir', label: 'Impulse / ETC' },
      { id: 'rt', label: 'Reverberation (RT60)' },
      { id: 'wf', label: 'Waterfall' },
      { id: 'dx', label: 'Diagnosis' },
    ];
    for (const t of tabs) {
      this.tabHost.append(h('button', { class: `chip${this.tab === t.id ? ' on' : ''}`, onclick: () => { this.tab = t.id; this.renderTabs(); this.showTab(); } }, t.label));
    }
  }

  private showTab(): void {
    clear(this.content);
    if (this.tab === 'fr') this.content.append(h('div', { class: 'pane fill' }, this.fr.el));
    else if (this.tab === 'thd') this.content.append(h('div', { class: 'thd-tab' }, this.thdInfo, h('div', { class: 'pane fill' }, this.thdPlot.el)));
    else if (this.tab === 'ir') this.content.append(h('div', { class: 'pane fill' }, this.irPlot.el));
    else if (this.tab === 'wf') {
      const o = this.wfOpts;
      const bar = h(
        'div',
        { class: 'toolbar wf-bar' },
        h(
          'div',
          { class: 'tb-group' },
          h('span', { class: 'tb-label' }, 'Range'),
          select(
            [
              { value: 'bass' as const, label: 'Room modes (15–500 Hz, 400 ms)' },
              { value: 'full' as const, label: 'Full range (100 Hz–20 kHz, 20 ms)' },
            ],
            o.preset,
            (v) => {
              o.preset = v;
              this.dirty = true;
            },
            { dataset: { waterfall: 'preset' } },
          ),
          h('span', { class: 'tb-label' }, 'Depth'),
          select([30, 45, 60].map((v) => ({ value: v, label: `${v} dB` })), o.range, (v) => {
            o.range = v;
            this.dirty = true;
          }),
        ),
        h(
          'div',
          { class: 'tb-group', role: 'group', 'aria-label': 'View angle' },
          h('span', { class: 'tb-label' }, 'View'),
          ...WATERFALL_ANGLES.map((a) => h('button', { class: 'btn small ghost', dataset: { wfView: a.id }, title: a.hint, onclick: () => { this.wf.setView(a.view); this.saveWfView(); } }, a.label)),
        ),
        h('span', { class: 'dim small' }, 'Ridges that reach far back are resonances that keep ringing: room modes in the bass, or cabinet and horn resonances higher up.'),
      );
      this.content.append(bar, h('div', { class: 'pane fill' }, this.wf.el));
    } else if (this.tab === 'dx') this.content.append(this.dxEl);
    else this.content.append(h('div', { class: 'rt-split' }, h('div', { class: 'pane' }, this.decay.el), this.table));
    this.dirty = true;
  }

  show(): void {
    const opts = this.app.measurements.length
      ? this.app.measurements.map((m, i) => ({ value: i, label: `${m.cfg.name} (In ${m.cfg.mic + 1})` }))
      : this.app.settings.measurements.map((m, i) => ({ value: i, label: `${m.name} (In ${m.mic + 1})` }));
    this.selHost.replaceChildren(select(opts, this.opts.measIdx, (v) => (this.opts.measIdx = v)));
    this.dirty = true;
  }

  cancel(): void {
    if (this.app.remote) {
      this.app.sendToHost({ t: 'cmd', cmd: 'sweepCancel' });
      return;
    }
    if (this.running) this.running.cancelled = true;
    this.app.engine.stopPlayback();
  }

  private setProgress(frac: number, text: string, running = !!this.running): void {
    (this.progress.firstChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    this.statusText.textContent = text;
    // The host shows sweep progress on every connected device
    if (!this.app.remote) this.app.hostLink?.sendSweepProgress(running, frac, text);
  }

  /** Remote devices: progress of a sweep running on the measurement host. */
  showHostProgress(running: boolean, frac: number, text: string): void {
    const wasRunning = !!this.running;
    this.running = running ? (this.running ?? { cancelled: false }) : null;
    // A sweep that ended without a result (cancelled, failed); a finished one resolves when its result arrives
    if (!running && wasRunning && !/^(Done|Measured on the host)/.test(text)) this.resolveHostWaiter(false);
    this.setMeasureLabel();
    (this.progress.firstChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    this.statusText.textContent = text;
  }

  /** Host: run a sweep requested by a remote device (with that device's settings). */
  async measureWith(req: { duration: number; level: number; repeats: number; f1: number; f2: number; measIdx: number }, by: string): Promise<void> {
    if (this.running) return; // the running sweep's progress and result reach that device too
    // Settings from the network: keep them within what the UI offers
    const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
    const o = this.opts;
    Object.assign(o, {
      duration: num(req.duration, 0.5, 16, o.duration),
      level: num(req.level, -60, 0, o.level),
      repeats: Math.round(num(req.repeats, 1, 8, o.repeats)),
      f1: num(req.f1, 5, 1000, o.f1),
      f2: num(req.f2, 200, 24000, o.f2),
      measIdx: Math.round(num(req.measIdx, 0, Math.max(0, this.app.settings.measurements.length - 1), 0)),
    });
    this.show();
    this.app.toast(`Sweep requested by ${by}`, 'info');
    await this.measure(by);
  }

  /** Show a sweep result measured on the host (shared with every device). */
  applyShared(meta: { spec: SweepSpec; peak: number; fs: number; channel: number; when: number; by: string }, ir: Float64Array): void {
    const d: Deconvolution = { ir, fs: meta.fs, peak: meta.peak };
    this.result = this.analyse(d, meta.spec, meta.channel);
    this.result.when = new Date(meta.when);
    this.renderResults();
    this.resolveHostWaiter(true);
    const bb = this.result.acoustics.broadband;
    this.showHostProgress(false, 1, `Measured on the host${meta.by ? ` (requested by ${meta.by})` : ''} at ${this.result.when.toLocaleTimeString()} · peak-to-noise ${this.result.peakDb.toFixed(0)} dB · T30 ${fmtS(bb.t30.rt)} · EDT ${fmtS(bb.edt.rt)}`);
  }

  /** The current sweep (for sessions): what applyShared() takes, or null. */
  sweepState(): { meta: SweepMeta; ir: Float64Array } | null {
    const r = this.result;
    if (!r) return null;
    return { meta: { spec: r.spec, peak: r.d.peak, fs: r.d.fs, channel: r.channel, when: r.when.getTime(), by: '' }, ir: r.d.ir };
  }

  /** Restore a sweep from a session (null clears it). */
  restoreSweep(state: { meta: SweepMeta; ir: Float64Array } | null): void {
    if (!state) {
      this.result = null;
      clear(this.cards);
      this.table.innerHTML = '';
      for (const p of [this.fr, this.irPlot, this.decay]) p.series = [];
      this.diagnosis = null;
      this.fr.markers = [];
      this.irPlot.markers = [];
      this.dxEl.replaceChildren(h('div', { class: 'empty big' }, 'Run a sweep to see which dips and peaks come from room modes, reflections or speaker-boundary interference.'));
      this.setProgress(0, 'Ready.', false);
      this.dirty = true;
      return;
    }
    this.applyShared(state.meta, state.ir);
    this.setProgress(1, `Loaded from the session · measured ${this.result!.when.toLocaleString()} · peak-to-noise ${this.result!.peakDb.toFixed(0)} dB`, false);
    this.app.shareSweep(state.meta, state.ir);
  }

  /** The last sweep's frequency response as shown (level-normalised), for the Room modes tab; null without one. */
  measuredResponse(): { x: ArrayLike<number>; y: ArrayLike<number> } | null {
    const s = this.result ? this.fr.series.find((x) => x.id === 'fr') : null;
    return s ? { x: s.x, y: s.y } : null;
  }

  /** Room diagnosis of the current sweep: what causes the response's peaks and dips. */
  diagnosis: Diagnosis | null = null;
  private dxEl = h('div', { class: 'dx-list' }, h('div', { class: 'empty big' }, 'Run a sweep to see which dips and peaks come from room modes, reflections or speaker-boundary interference.'));

  private renderDiagnosis(r: SweepResult): void {
    const c = speedOfSound(this.app.settings.tempC);
    const room = this.app.settings.room;
    // With the room's dimensions entered in Tools → Calculators → Room modes, measured modes are matched to predicted ones
    const predicted = room.known ? axialModes(room, c, 300).map((m) => ({ f: m.f, label: `${modeDimension(m)} mode ${m.n.join('·')}` })) : undefined;
    const dx = (this.diagnosis = diagnose(r.ir, r.d.fs, r.t0, { c, fMin: r.spec.f1, predicted }));
    // Markers: modes, nulls and SBIR on the frequency response; reflections on the impulse response / ETC
    this.fr.markers = dx.findings.filter((f) => f.kind !== 'reflection' && f.f).map((f) => ({ x: f.f!, label: `${DX_KIND[f.kind].short} ${f.f! < 1000 ? Math.round(f.f!) : (f.f! / 1000).toFixed(1) + 'k'}`, color: DX_KIND[f.kind].color, top: true }));
    this.irPlot.markers = dx.findings.filter((f) => f.delayMs !== undefined).map((f) => ({ x: f.delayMs!, label: `${DX_KIND[f.kind].short} ${f.delayMs!.toFixed(1)} ms`, color: DX_KIND[f.kind].color }));
    const intro = h(
      'p',
      { class: 'dim small dx-intro' },
      'What shapes this response: room modes (resonances that ring), speaker-boundary interference (SBIR: a nearby wall, floor or desk cancelling the low-mids) and reflections (comb filtering). Each needs a different fix. Markers on the Frequency response and Impulse / ETC graphs show where they are.',
    );
    if (!dx.findings.length) {
      this.dxEl.replaceChildren(intro, h('div', { class: 'empty big' }, 'No clear room modes, boundary interference or strong reflections in this measurement.'));
      return;
    }
    this.dxEl.replaceChildren(
      intro,
      ...dx.findings.map((f) =>
        h(
          'div',
          { class: `dx-card ${f.kind} ${f.confidence}`, dataset: { kind: f.kind } },
          h('div', { class: 'dx-head' }, h('span', { class: 'dx-badge', style: `--dx:${DX_KIND[f.kind].color}` }, DX_KIND[f.kind].label), h('b', {}, f.title), h('span', { class: 'dx-conf' }, f.confidence === 'likely' ? 'Likely' : 'Possible')),
          h('p', {}, f.detail),
          h('p', { class: 'dx-advice' }, h('b', {}, 'What to do: '), f.advice),
        ),
      ),
    );
  }

  /** Waterfall of the current sweep (computed once per sweep and range), or null. */
  waterfallData(preset: 'bass' | 'full'): WaterfallResult | null {
    const r = this.result;
    if (!r) return null;
    if (this.wfFor?.result !== r || this.wfFor.preset !== preset || !this.wfCache) {
      this.wfCache = waterfall(r.ir, r.d.fs, r.t0, WATERFALL_PRESETS[preset]);
      this.wfFor = { result: r, preset };
    }
    return this.wfCache;
  }
  private wfCache: WaterfallResult | null = null;

  /** Report data: the displayed (level-normalised) frequency response, the result cards and the RT table. */
  reportData(): { fr: Float64Array; cards: { label: string; value: string; sub: string }[]; tableHtml: string; when: Date; spec: SweepSpec; window: number; smoothing: number } | null {
    const r = this.result;
    if (!r) return null;
    const fr = this.fr.series.find((s) => s.id === 'fr');
    return {
      fr: Float64Array.from(fr ? (fr.y as ArrayLike<number>) : r.fr),
      cards: [...this.cards.querySelectorAll('.card')].map((c) => ({ label: c.children[0].textContent ?? '', value: c.children[1].textContent ?? '', sub: c.children[2].textContent ?? '' })),
      tableHtml: this.table.querySelector('table')?.outerHTML ?? '',
      when: r.when,
      spec: r.spec,
      window: this.opts.window,
      smoothing: this.opts.smoothing,
    };
  }

  async measure(by = 'the host'): Promise<void> {
    const app = this.app;
    if (app.remote) {
      // All measurements run on the host, which captures the sweep sample-accurately and shares the result
      const sent = app.sendToHost({ t: 'cmd', cmd: 'sweep', opts: { duration: this.opts.duration, level: this.opts.level, repeats: this.opts.repeats, f1: this.opts.f1, f2: this.opts.f2, measIdx: this.opts.measIdx } });
      if (!sent) return app.toast('Not connected to the measurement host', 'warn');
      this.showHostProgress(true, 0, 'Starting the sweep on the measurement host…');
      return;
    }
    // A sweep that can't start is reported to every device (a remote that asked for it is waiting)
    const fail = (msg: string) => {
      app.toast(msg, 'warn');
      this.setProgress(0, msg, false);
    };
    const e = app.engine;
    if (!e.running) {
      await app.start();
      if (!e.running) return fail('Could not start audio for the sweep.');
    }
    const cfg = app.settings.measurements[this.opts.measIdx] ?? app.settings.measurements[0];
    const ring = e.ring(cfg.mic);
    if (!ring) return fail('Measurement channel not available.');
    const fs = e.sampleRate;
    const tail = Math.round(fs * 2.5);
    // The recording must fit in the capture buffer (long sweeps at very high sample rates may not)
    const maxSeconds = Math.floor(ring.capacity / fs - 3.5);
    if (this.opts.duration + 2.5 > ring.capacity / fs - 1) return fail(`At ${fs / 1000} kHz sweeps can be at most ${maxSeconds} s long. Choose a shorter sweep.`);
    const spec: SweepSpec = { fs, f1: this.opts.f1, f2: Math.min(this.opts.f2, fs / 2 - 500), duration: this.opts.duration, amplitude: Math.pow(10, this.opts.level / 20) };
    const sweep = logSweep(spec);
    const buf = new Float32Array(sweep.length + tail);
    buf.set(sweep);
    const sum = new Float64Array(buf.length);
    const token = { cancelled: false };
    this.running = token;
    app.busy = true;
    this.setMeasureLabel();
    const wasGen = app.settings.generator.type;
    if (wasGen !== 'off') app.engine.setGenerator({ ...app.settings.generator, type: 'off' });
    // Audio restarted during the sweep (e.g. another input source): the recording is gone, stop waiting for it
    let restarted = false;
    const watch = setInterval(() => {
      if (e.running && e.ring(cfg.mic) === ring) return;
      restarted = true;
      token.cancelled = true;
    }, 100);
    try {
      for (let r = 0; r < this.opts.repeats; r++) {
        this.setProgress(r / this.opts.repeats, `Playing sweep ${r + 1}/${this.opts.repeats}… keep quiet!`);
        const t0 = performance.now();
        const timer = setInterval(() => {
          const frac = Math.min(1, (performance.now() - t0) / 1000 / (buf.length / fs));
          this.setProgress((r + frac) / this.opts.repeats, `Sweep ${r + 1}/${this.opts.repeats} · ${Math.round(frac * 100)}%${frac > sweep.length / buf.length ? ' · recording decay' : ''}`);
        }, 100);
        let start: number;
        try {
          ({ start } = await e.play(buf));
        } finally {
          clearInterval(timer);
        }
        if (token.cancelled) throw new Error(restarted ? 'audio was restarted during the sweep. Run it again.' : 'cancelled');
        await e.waitForFrame(start + buf.length, token);
        if (restarted || e.ring(cfg.mic) !== ring) throw new Error('audio was restarted during the sweep. Run it again.');
        if (token.cancelled) throw new Error('cancelled');
        const rec = new Float64Array(buf.length);
        ring.read(start, buf.length, rec);
        for (let i = 0; i < rec.length; i++) sum[i] += rec[i] / this.opts.repeats;
      }
      this.setProgress(1, 'Analysing…');
      await new Promise((r) => setTimeout(r, 20));
      const d = deconvolve(sum, sweep, spec);
      this.result = this.analyse(d, spec, cfg.mic);
      this.renderResults();
      const bb = this.result.acoustics.broadband;
      this.running = null;
      this.setProgress(1, `Done · peak-to-noise ${this.result.peakDb.toFixed(0)} dB · T30 ${fmtS(bb.t30.rt)} · EDT ${fmtS(bb.edt.rt)}`, false);
      // Share the result with every connected device
      app.shareSweep({ spec, peak: d.peak, fs: d.fs, channel: cfg.mic, when: Date.now(), by: by === 'the host' ? '' : by }, d.ir);
      if (this.result.peakDb < 40) app.toast('Low signal-to-noise ratio: raise the level, use a longer sweep or more repeats for reliable RT60.', 'warn');
    } catch (err) {
      const msg = restarted ? 'audio was restarted during the sweep. Run it again.' : (err as Error).message;
      if (msg !== 'cancelled') app.toast(`Sweep failed: ${msg}`, 'warn');
      this.running = null;
      this.setProgress(0, 'Cancelled.', false);
    } finally {
      clearInterval(watch);
      this.running = null;
      app.busy = false;
      this.setMeasureLabel();
      if (wasGen !== 'off') app.engine.setGenerator(app.settings.generator);
    }
  }

  private analyse(d: Deconvolution, spec: SweepSpec, channel: number): SweepResult {
    const { ir, t0 } = linearIR(d, 5, Math.min(3, d.ir.length / d.fs / 2));
    const acoustics = roomAcoustics(ir, d.fs, this.opts.fraction);
    const etc = energyTimeCurve(ir);
    let peak = 0;
    for (const v of ir) peak = Math.max(peak, v * v);
    let noise = 0;
    const tailN = Math.round(ir.length * 0.1);
    for (let i = ir.length - tailN; i < ir.length; i++) noise += ir[i] * ir[i];
    noise /= tailN;
    const grid = this.app.grid;
    const hd = harmonicDistortion(d, spec, grid, 5);
    const res: SweepResult = {
      spec,
      d,
      ir,
      t0,
      fr: new Float64Array(grid.length),
      thd: hd.thd,
      h2: hd.harmonics[0],
      h3: hd.harmonics[1],
      h4: hd.harmonics[2],
      h5: hd.harmonics[3],
      floor: hd.floor,
      fund: hd.fundamental,
      acoustics,
      etc,
      peakDb: 10 * Math.log10(peak / Math.max(noise, 1e-30)),
      noiseDb: 10 * Math.log10(Math.max(noise, 1e-30)),
      channel,
      when: new Date(),
    };
    this.computeFr(res);
    return res;
  }

  private computeFr(r: SweepResult): void {
    const fs = r.d.fs;
    const winN = Math.min(r.ir.length, r.t0 + Math.round((this.opts.window / 1000) * fs));
    const w = r.ir.slice(0, winN);
    // Half-Hann fade-out over the last 20% of the window
    const fade = Math.max(1, Math.round((winN - r.t0) * 0.2));
    for (let i = 0; i < fade; i++) w[winN - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    const size = Math.max(nextPow2(winN), 32768);
    const sp = spectrumOf(w, fs, size);
    const pow = Float64Array.from(sp.mag, (m) => m * m);
    const grid = this.app.grid;
    new LogSmoother(grid, fs / size, sp.mag.length).apply(pow, this.opts.smoothing, r.fr);
    // The mic correction and, when compensated, the air absorption over that measurement's distance
    const cfg = this.app.settings.measurements.find((m) => m.mic === r.channel);
    const cal = cfg ? this.app.correctionFor(cfg) : this.app.calFor(r.channel);
    for (let i = 0; i < grid.length; i++) {
      r.fr[i] = 10 * Math.log10(Math.max(r.fr[i], 1e-30)) + (cal ? cal[i] : 0);
      if (grid[i] < r.spec.f1 || grid[i] > r.spec.f2) r.fr[i] = NaN;
    }
  }

  private recompute(bands = false): void {
    if (!this.result) return;
    this.computeFr(this.result);
    if (bands) this.result.acoustics = roomAcoustics(this.result.ir, this.result.d.fs, this.opts.fraction);
    this.renderResults();
  }

  private renderResults(): void {
    const r = this.result;
    if (!r) return;
    const grid = this.app.grid;
    // Level-normalise FR display so the median of 200 Hz–5 kHz sits at 0 dB
    const mid: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] > 200 && grid[i] < 5000 && Number.isFinite(r.fr[i])) mid.push(r.fr[i]);
    mid.sort((a, b) => a - b);
    const ref = mid.length ? mid[Math.floor(mid.length / 2)] : 0;
    const fr = Float64Array.from(r.fr, (v) => v - ref);
    this.fr.series = [{ id: 'fr', label: 'Response', x: grid, y: fr, color: CHART.accent, width: 2 }];
    this.renderDistortion(r, fr);
    this.applyTarget();
    const t = Float64Array.from(r.etc, (_, i) => ((i - r.t0) / r.d.fs) * 1000);
    this.irPlot.series = [{ id: 'etc', label: 'ETC', x: t, y: r.etc, color: CHART.accent, width: 1.2, fill: true }];
    const ac = r.acoustics;
    const colors = BAND_COLORS;
    const decaySeries = ac.bands.map((b, i) => ({
      id: `d${i}`,
      label: `${b.label} Hz`,
      x: Float64Array.from(b.decay, (_, k) => k * ac.decayStep * 1000),
      y: b.decay,
      color: colors[Math.round((i / Math.max(1, ac.bands.length - 1)) * (colors.length - 1))],
      width: 1,
    }));
    decaySeries.push({ id: 'bb', label: 'Broadband', x: Float64Array.from(ac.broadband.decay, (_, k) => k * ac.decayStep * 1000), y: ac.broadband.decay, color: CHART.fg, width: 2 });
    this.decay.series = decaySeries;
    this.renderDiagnosis(r);
    this.renderCards(r);
    this.renderTable(ac);
    this.dirty = true;
  }

  /**
   * The Distortion tab: THD and harmonics 2–5 in percent of the fundamental, where the fundamental is strong
   * enough (within 15 dB of the response's midband) and the second harmonic is still inside the sweep; the
   * measurement floor shaded below; and the main figures in words.
   */
  private renderDistortion(r: SweepResult, fr: Float64Array): void {
    const grid = this.app.grid;
    const valid = (i: number) => grid[i] * 2 <= r.spec.f2 && grid[i] >= r.spec.f1 && Number.isFinite(fr[i]) && fr[i] > -15;
    const pct = (db: Float64Array) => smoothPct(Float64Array.from(db, (v, i) => (valid(i) ? 100 * Math.pow(10, (v - r.fund[i]) / 20) : NaN)));
    const thd = smoothPct(Float64Array.from(r.thd, (v, i) => (valid(i) ? v : NaN)));
    const floor = smoothPct(Float64Array.from(r.floor, (v, i) => (valid(i) ? Math.min(v, 100) : NaN)));
    // Where THD is above the floor it is distortion; at or below it, noise
    const measurable = (i: number) => Number.isFinite(thd[i]) && thd[i] > floor[i] * 1.4;
    let top = 1;
    for (let i = 0; i < grid.length; i++) if (Number.isFinite(thd[i]) && grid[i] > 40) top = Math.max(top, thd[i]);
    const yMax = Math.min(100, top <= 2 ? 2 : top <= 5 ? 5 : top <= 10 ? 10 : top <= 20 ? 20 : top <= 50 ? 50 : 100);
    if (this.thdPlot.cfg.yMax !== yMax) this.thdPlot.setDefaults({ yMin: 0, yMax });
    const zero = Float64Array.from(grid, () => 0);
    this.thdPlot.series = [
      { id: 'floor', label: 'Measurement floor (noise)', x: grid, y: floor, band: zero, color: CHART.neutral, quiet: true },
      { id: 'thd', label: 'THD', unit: '%', x: grid, y: thd, color: '#b18cff', width: 2.4 },
      { id: 'h2', label: 'H2', unit: '%', x: grid, y: pct(r.h2), color: CHART.warn, width: 1.3 },
      { id: 'h3', label: 'H3', unit: '%', x: grid, y: pct(r.h3), color: '#ff5c7a', width: 1.3 },
      { id: 'h4', label: 'H4', unit: '%', x: grid, y: pct(r.h4), color: '#2ec4b6', width: 1, dash: [4, 3] },
      { id: 'h5', label: 'H5', unit: '%', x: grid, y: pct(r.h5), color: '#7cff6b', width: 1, dash: [4, 3] },
    ];
    // The figures: THD at 100 Hz, 1 kHz and 10 kHz, and the highest measurable value
    const at = (f: number) => {
      const i = grid.findIndex((x) => x >= f);
      if (i < 0 || !Number.isFinite(thd[i])) return '—';
      return measurable(i) ? fmtPct(thd[i]) : `< ${fmtPct(floor[i])} (noise)`;
    };
    let worst = -1;
    for (let i = 0; i < grid.length; i++) if (measurable(i) && (worst < 0 || thd[i] > thd[worst])) worst = i;
    const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
    const level = 20 * Math.log10(r.spec.amplitude);
    const fig = (label: string, value: string, hint: string) => h('div', { class: 'thd-fig', title: hint }, h('span', {}, label), h('b', {}, value));
    this.thdInfo.replaceChildren(
      fig('THD 100 Hz', at(100), 'Total harmonic distortion of a 100 Hz tone'),
      fig('THD 1 kHz', at(1000), 'Total harmonic distortion of a 1 kHz tone'),
      fig('THD 10 kHz', at(10000), 'Total harmonic distortion of a 10 kHz tone (harmonics up to the sweep’s top frequency)'),
      fig('Highest', worst >= 0 ? `${fmtPct(thd[worst])} at ${fmtF(grid[worst])}` : '—', 'The highest THD above the measurement floor'),
      h(
        'p',
        { class: 'dim small' },
        `Sweep at ${level.toFixed(0)} dBFS. Distortion rises with level: compare measurements at the same level, and measure close to the loudspeaker so the room adds little. The grey area is the measurement floor: values in it are background noise, not distortion; a louder sweep or more repeats lower it.`,
      ),
    );
  }

  private renderCards(r: SweepResult): void {
    const bb = r.acoustics.broadband;
    const mids = r.acoustics.bands.filter((b) => b.centre > 400 && b.centre < 1300);
    const tMid = mids.length ? mids.reduce((s, b) => s + (Number.isFinite(b.t30.rt) ? b.t30.rt : b.t20.rt), 0) / mids.length : bb.t30.rt;
    const card = (label: string, value: string, sub: string, hint: string) => h('div', { class: 'card', title: hint }, h('span', {}, label), h('b', {}, value), h('em', {}, sub));
    clear(this.cards);
    this.cards.append(
      card('T30 (broadband)', fmtS(bb.t30.rt), `r = ${bb.t30.r ? bb.t30.r.toFixed(3) : '—'}`, 'Reverberation time from the −5…−35 dB slope, extrapolated to 60 dB'),
      card('T20', fmtS(bb.t20.rt), `EDT ${fmtS(bb.edt.rt)}`, 'T20 uses −5…−25 dB; EDT uses 0…−10 dB and correlates with perceived reverberance'),
      card('Tmid (500–1k)', fmtS(tMid), roomCharacter(tMid), 'Average of the 500 Hz and 1 kHz octave bands'),
      card('C50 speech', `${fmtDb(bb.c50)}`, `D50 ${Number.isFinite(bb.d50) ? bb.d50.toFixed(0) : '—'} %`, 'Clarity for speech: early (0–50 ms) to late energy ratio. > 0 dB is good'),
      card('C80 music', `${fmtDb(bb.c80)}`, `Ts ${bb.ts.toFixed(0)} ms`, 'Clarity for music: early (0–80 ms) to late energy. −2…+4 dB typical for concert halls'),
      card('Peak-to-noise', `${r.peakDb.toFixed(0)} dB`, r.peakDb > 45 ? 'reliable' : r.peakDb > 35 ? 'T20 only' : 'too noisy', 'ISO 3382 needs ≥ 45 dB for T30 and ≥ 35 dB for T20'),
    );
  }

  private renderTable(ac: AcousticsResult): void {
    const rows: { label: string; get: (b: BandAcoustics) => string; tip: string }[] = [
      { label: 'EDT (s)', get: (b) => fit(b.edt), tip: 'Early decay time' },
      { label: 'T20 (s)', get: (b) => fit(b.t20), tip: 'Reverberation time from 20 dB decay' },
      { label: 'T30 (s)', get: (b) => fit(b.t30), tip: 'Reverberation time from 30 dB decay' },
      { label: 'C50 (dB)', get: (b) => fmtDb(b.c50), tip: 'Speech clarity' },
      { label: 'C80 (dB)', get: (b) => fmtDb(b.c80), tip: 'Music clarity' },
      { label: 'D50 (%)', get: (b) => (Number.isFinite(b.d50) ? b.d50.toFixed(0) : '—'), tip: 'Definition' },
      { label: 'INR (dB)', get: (b) => b.inr.toFixed(0), tip: 'Impulse-to-noise ratio' },
    ];
    const head = `<tr><th></th>${ac.bands.map((b) => `<th>${escapeHtml(b.label)}</th>`).join('')}<th>Broadband</th></tr>`;
    const body = rows.map((r) => `<tr><th title="${r.tip}">${r.label}</th>${ac.bands.map((b) => `<td>${r.get(b)}</td>`).join('')}<td class="bb">${r.get(ac.broadband)}</td></tr>`).join('');
    const tmid = ac.bands.filter((b) => b.centre > 400 && b.centre < 1300).map((b) => b.t30.rt).filter(Number.isFinite);
    const note =
      tmid.length > 0
        ? `<p class="dim small">Values shown faded have a poor linear fit (r &lt; 0.98) or insufficient dynamic range. Schroeder frequency for a 200 m³ room with this RT: ${schroederFrequency(tmid.reduce((a, b) => a + b, 0) / tmid.length, 200).toFixed(0)} Hz — below it, individual room modes dominate.</p>`
        : '';
    this.table.innerHTML = `<table>${head}${body}</table>${note}`;
  }

  private saveTrace(name?: string): Trace | null {
    const r = this.result;
    if (!r) {
      this.app.toast('Run a sweep first', 'warn');
      return null;
    }
    const grid = this.app.grid;
    const idx: number[] = [];
    grid.forEach((_, i) => Number.isFinite(r.fr[i]) && idx.push(i));
    const t = this.app.traces.add({
      name: name ?? `Sweep In${r.channel + 1} ${r.when.toLocaleTimeString()}`,
      kind: 'sweep',
      freqs: idx.map((i) => grid[i]),
      mag: idx.map((i) => +r.fr[i].toFixed(2)),
      note: `${r.spec.duration}s log sweep, ${this.opts.window} ms window, 1/${this.opts.smoothing} oct`,
    });
    if (!name) this.app.toast('Frequency response saved as a trace: it shows on Transfer and on Spectrum', 'ok');
    return t;
  }

  private resolveHostWaiter(ok: boolean): void {
    const done = this.hostWaiter;
    this.hostWaiter = null;
    done?.(ok);
  }

  /** One sweep with the current settings; true when it produced a new result. */
  private async sweepOnce(): Promise<boolean> {
    const before = this.result;
    if (!this.app.remote) {
      await this.measure();
      return this.result !== before;
    }
    // Remote: the host runs the sweep and shares the result; wait for it to finish
    const done = new Promise<boolean>((resolve) => (this.hostWaiter = resolve));
    await this.measure();
    if (!this.running) {
      this.hostWaiter = null;
      return false;
    }
    return done;
  }

  /** Between two positions: say where to put the mic and wait for the user. */
  private askNext(k: number, failed: boolean): Promise<'go' | 'finish' | 'cancel'> {
    const s = this.series!;
    const done = s.traces.length;
    this.seriesBar.hidden = false;
    this.setMeasureLabel();
    const steps = h('div', { class: 'series-steps' }, ...Array.from({ length: s.n }, (_, i) => h('span', { class: `series-step${i < done ? ' done' : i === k - 1 ? ' now' : ''}`, title: `Position ${i + 1}` }, String(i + 1))));
    const text = failed
      ? `The sweep at position ${k} did not finish. Check the levels and try again.`
      : k === 1
        ? `Put the mic at the first listening position (ear height), then measure.`
        : `Move the mic to position ${k} of ${s.n}: 30–60 cm from the last one, not along the same line, at ear height. Keep quiet during the sweep.`;
    return new Promise((resolve) => {
      s.answer = resolve;
      const go = h('button', { class: 'btn accent', dataset: { series: 'go' }, onclick: () => resolve('go') }, icon('play', 14), failed ? `Try position ${k} again` : `Measure position ${k}`);
      const finish = h('button', { class: 'btn', dataset: { series: 'finish' }, onclick: () => resolve('finish') }, `Finish with ${done} positions`);
      this.seriesBar.replaceChildren(steps, h('p', { class: 'series-text' }, text), go, ...(done >= 2 ? [finish] : []), h('button', { class: 'btn ghost', dataset: { series: 'cancel' }, onclick: () => resolve('cancel') }, 'Cancel'));
      go.focus();
      this.app.announce(text);
    });
  }

  /**
   * Guided spatial average: one sweep at each of `n` mic positions, each saved as a (hidden) trace, then their
   * power average as one trace for the EQ tab. Between sweeps the user moves the mic and presses Measure.
   */
  async measurePositions(n: number): Promise<void> {
    if (this.series) return;
    const s = (this.series = { n, traces: [] as Trace[], answer: null as ((c: 'go' | 'finish' | 'cancel') => void) | null });
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let finish = false;
    try {
      for (let k = 1; k <= n && !finish; k++) {
        let failed = false;
        for (;;) {
          // The first position starts at once (the user just pressed Measure), unless its sweep failed
          const choice = k === 1 && !failed ? 'go' : await this.askNext(k, failed);
          if (choice === 'cancel') return this.app.toast(s.traces.length ? `Stopped: the ${s.traces.length} positions measured are kept as hidden traces` : 'Cancelled', 'info');
          if (choice === 'finish') {
            finish = true;
            break;
          }
          this.seriesBar.hidden = true;
          if (await this.sweepOnce()) break;
          failed = true;
        }
        if (finish) break;
        const t = this.saveTrace(`Position ${k}/${n} · ${stamp}`);
        if (t) {
          s.traces.push(t);
          this.app.traces.update(t.id, { visible: false });
        }
      }
      if (s.traces.length < 2) return;
      const avg = this.app.traces.average(s.traces.map((t) => t.id), `Spatial average (${s.traces.length} positions) · ${stamp}`);
      if (avg) {
        this.app.traces.update(avg.id, { note: `Power average of sweeps at ${s.traces.length} mic positions` });
        this.app.toast(`“${avg.name}” saved: use it on the EQ tab. Each position is kept as a hidden trace.`, 'ok');
        this.setProgress(1, `Done · ${s.traces.length} positions averaged`, false);
      }
    } finally {
      this.series = null;
      this.seriesBar.hidden = true;
      this.seriesBar.replaceChildren();
      this.setMeasureLabel();
    }
  }

  private exportIr(): void {
    const r = this.result;
    if (!r) return this.app.toast('Run a sweep first', 'warn');
    let pk = 0;
    for (const v of r.ir) pk = Math.max(pk, Math.abs(v));
    const data = Float32Array.from(r.ir, (v) => (v / (pk || 1)) * 0.9);
    const blob = encodeWav(data, r.d.fs);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `impulse-response-${Date.now()}.wav` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** (Re)draw the target on the frequency response, levelled to the response. */
  private applyTarget(): void {
    const s = this.app.settings;
    this.targetKey = `${s.roomTargetCurve}|${s.targetTolerance}|${this.app.traces.version}`;
    const own = this.fr.series.filter((x) => x.id !== 'target' && x.id !== 'target-band');
    const fr = own.find((x) => x.id === 'fr');
    this.fr.series = [...this.target.series(this.app.grid, fr ? (fr.y as ArrayLike<number>) : null), ...own];
  }

  invalidate(): void {
    this.dirty = true;
  }

  tick(): void {
    const s = this.app.settings;
    this.target.refresh();
    if (this.notes.apply()) this.dirty = true;
    if (this.result && this.targetKey !== `${s.roomTargetCurve}|${s.targetTolerance}|${this.app.traces.version}`) {
      this.applyTarget();
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.fr.draw();
    this.thdPlot.draw();
    this.irPlot.draw();
    this.decay.draw();
    if (this.tab === 'wf') {
      this.wf.data = this.waterfallData(this.wfOpts.preset);
      this.wf.range = this.wfOpts.range;
      this.wf.draw();
    }
    if (!this.result) {
      this.table.innerHTML = `<div class="empty big">Run a sweep to see reverberation time, clarity and definition per ${this.opts.fraction === 1 ? 'octave' : 'third-octave'} band.</div>`;
    }
  }
}

/** Percent with sensible precision: 0.08 %, 0.8 %, 8 %. */
function fmtPct(v: number): string {
  return `${v < 0.1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0)} %`;
}

/** Light smoothing of a percent curve (neighbouring points; gaps stay gaps). */
function smoothPct(y: Float64Array): Float64Array {
  const out = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) {
    if (!Number.isFinite(y[i])) {
      out[i] = NaN;
      continue;
    }
    let s = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) if (Number.isFinite(y[i + k])) (s += y[i + k]), n++;
    out[i] = s / n;
  }
  return out;
}


function fmtS(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)} s` : '—';
}
function fmtDb(v: number): string {
  return Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—';
}
function fit(f: { rt: number; r: number }): string {
  if (!Number.isFinite(f.rt)) return '<span class="dim">—</span>';
  return f.r < 0.98 ? `<span class="dim">${f.rt.toFixed(2)}</span>` : f.rt.toFixed(2);
}
function roomCharacter(rt: number): string {
  if (!Number.isFinite(rt)) return '';
  if (rt < 0.3) return 'very dry (studio / control room)';
  if (rt < 0.6) return 'dry (home theatre, meeting room)';
  if (rt < 1.0) return 'medium (classroom, club)';
  if (rt < 1.8) return 'live (theatre, concert hall)';
  return 'very live (church, arena)';
}

export function encodeWav(data: Float32Array, fs: number): Blob {
  const buf = new ArrayBuffer(44 + data.length * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, 1, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  str(36, 'data');
  v.setUint32(40, data.length * 4, true);
  for (let i = 0; i < data.length; i++) v.setFloat32(44 + i * 4, data[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}

