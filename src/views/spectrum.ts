import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import { interp, octaveBandCentres, sampleLogGrid, type Smoothing } from '../dsp/freq';
import { AVG_OPTIONS } from './meters';
import { DockedView } from './docked';
import { optionsMenu, optRow, optHead, colourChoice } from '../ui/popover';
import { TargetOverlay } from './target-overlay';
import { micAverageControl, micAverageSeries } from './mic-average-overlay';
import { GraphNotes } from './graph-notes';
import { FeedbackDetector, type FeedbackCandidate } from '../dsp/feedback';
import type { EqView } from './eq';
import { rangePeaks, type RangePeak } from '../dsp/peaks';

/** Colours offered for the average curve ('auto': white at night, black by day). */
export const AVG_COLORS = [
  { value: 'auto', label: 'Auto' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#ff9f1c', label: 'Orange' },
  { value: '#ff4d6d', label: 'Red' },
  { value: '#ff5cf0', label: 'Magenta' },
  { value: '#4cc9f0', label: 'Cyan' },
  { value: '#7cff6b', label: 'Green' },
];

/** Dash patterns that tell several average curves apart (solid, long dash, dots, dash-dot). */
const AVG_DASHES: (number[] | undefined)[] = [undefined, [12, 5], [3, 4], [12, 4, 3, 4]];

/** Mix a #rrggbb colour with another by `amount` (0 = unchanged, 1 = the other colour). */
function tint(c: string, toward: string, amount: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(c);
  const b = p(toward);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return c;
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`;
}

/** 2.51 kHz, 95 Hz */
const fmtF = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);

export function defaultSpectrumLayout(): DockLayout {
  return {
    order: ['rta', 'spl', 'levels'],
    sizes: { rta: 1, spl: 0.5, levels: 0.6 },
    // The level meters are in the status bar too: their panel starts hidden, the SPL meter floats
    hidden: ['levels'],
    floating: {
      levels: { x: -14, y: -40, w: 250, h: 210 },
      spl: { x: -14, y: -40, w: 250, h: 160 },
    },
  };
}

/** Single-channel real-time analysis: RTA / FFT spectrum of every measurement mic, plus SPL and level meters. */
export class SpectrumView extends DockedView implements View {
  id = 'spectrum' as const;
  readonly needs = { rta: true };
  title = 'Spectrum';
  icon = 'bars' as const;
  private rta: Plot;
  private bands: number[] = [];
  private lastKey = '';
  readonly target: TargetOverlay;
  private notes!: GraphNotes;
  /** The highlighted peaks (low, mid, high) last drawn. */
  peaks: RangePeak[] = [];

  invalidate(): void {
    this.lastKey = '';
  }
  private bandFraction = 0;
  /** Calibration offset the RTA's y range is currently shifted by (the saved range is in dBFS). */
  private appliedCal = 0;

  constructor(app: App) {
    super(app, 'spectrumLayout', defaultSpectrumLayout);
    this.target = new TargetOverlay(app);
    const s = app.settings;
    this.rta = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.rtaRange[0], yMax: s.rtaRange[1], yUnit: 'dBFS', yStep: 10, showNote: true, yLimits: [-200, 200], autoFit: true });
    this.rta.onRangeChange = (a, b) => {
      s.rtaRange = [a - this.appliedCal, b - this.appliedCal];
      app.save();
    };
    this.notes = new GraphNotes(app, 'spectrum', this.rta);
    this.mountDock([this.plotPanel('rta', 'Spectrum (RTA)', this.rta), ...this.meterPanels()], this.toolbar());
    this.el.insertBefore(this.fbStrip, this.dock.el);
  }

  private resHost = h('span', { class: 'tb-res' });

  // Feedback finder ----------------------------------------------------------------------------------------
  private detector = new FeedbackDetector();
  private fb: FeedbackCandidate[] = [];
  private fbVersion = -1;
  private fbKey = '';
  private fbStrip = h('div', { class: 'fb-strip', hidden: true, role: 'status' });
  /** When each frequency was last announced (a warning per new peak, not one per spectrum). */
  private fbWarned = new Map<number, number>();

  /** Feed the newest spectrum to the feedback finder; true when what it shows changed. */
  private tickFeedback(): boolean {
    const app = this.app;
    if (!app.settings.feedbackFinder) {
      if (this.fbStrip.hidden && !this.fb.length) return false;
      this.fbStrip.hidden = true;
      this.fb = [];
      this.fbKey = '';
      this.detector.reset();
      return true;
    }
    this.fbStrip.hidden = false;
    const m = app.measurements.find((x) => x.cfg.enabled && x.hasRta);
    const sp = m?.narrowSpectrum();
    if (!sp) {
      if (this.fbKey !== 'none') this.fbStrip.replaceChildren(h('span', { class: 'dim' }, 'Feedback finder: start audio to listen for feedback.'));
      this.fbKey = 'none';
      return false;
    }
    if (sp.version === this.fbVersion) return false;
    this.fbVersion = sp.version;
    this.fb = this.detector.update(app.grid, sp.data, performance.now() / 1000).slice(0, 4);
    const key = this.fb.map((c) => `${Math.round(c.f)}|${c.kind}|${Math.round(c.prominence)}|${c.notch.q}|${c.notch.gain}`).join(',');
    if (key === this.fbKey) return false;
    this.fbKey = key;
    // A warning when a peak appears (again after a quiet minute)
    const now = performance.now();
    for (const c of this.fb) {
      const near = [...this.fbWarned.keys()].find((f) => Math.abs(Math.log2(f / c.f)) < 1 / 24);
      if (near !== undefined && now - this.fbWarned.get(near)! < 60000) continue;
      this.fbWarned.set(near ?? c.f, now);
      app.toast(`Feedback risk at ${fmtF(c.f)} (${c.kind === 'rising' ? 'rising' : 'ringing'}, ${c.prominence.toFixed(0)} dB above the spectrum)`, 'warn');
    }
    this.renderFeedback();
    return true;
  }

  private renderFeedback(): void {
    if (!this.fb.length) {
      this.fbStrip.replaceChildren(h('span', { class: 'dim' }, 'Feedback finder: listening — no narrow, growing or ringing peaks.'));
      return;
    }
    const eq = this.app.views.find((v) => v.id === 'eq') as unknown as EqView | undefined;
    this.fbStrip.replaceChildren(
      h('span', { class: 'fb-title' }, 'Feedback risk'),
      ...this.fb.map((c) =>
        h(
          'span',
          { class: `fb-item ${c.kind}` },
          h('b', {}, fmtF(c.f)),
          ` ${c.prominence.toFixed(0)} dB above${c.kind === 'rising' ? `, rising ${c.rising.toFixed(0)} dB/s` : ', ringing'} · notch Q ${c.notch.q}, ${c.notch.gain} dB `,
          h(
            'button',
            {
              class: 'btn tiny',
              title: 'Add this notch filter to the EQ tab',
              onclick: () => {
                eq?.addFilter({ type: 'peak', f: c.notch.f, gain: c.notch.gain, q: c.notch.q });
                this.app.toast(`Notch at ${fmtF(c.notch.f)} (Q ${c.notch.q}, ${c.notch.gain} dB) added to the EQ tab`, 'ok');
              },
            },
            'Add notch to EQ',
          ),
        ),
      ),
    );
  }
  /** How long the chosen averaging takes to follow a change (next to the Averaging setting). */
  private avgHint = h('span', { class: 'opt-note' });

  private renderAvgHint(): void {
    const s = this.app.settings;
    const fs = this.app.fs || 48000;
    const n = s.rtaAveraging;
    // Exponential average over n half-overlapped frames: settles in about n × (FFT / 2) samples
    const text = n === 1 ? 'instant' : n === 0 ? 'until reset' : `≈ ${((n * s.rtaFft) / 2 / fs).toFixed(1)} s`;
    if (this.avgHint.textContent !== text) this.avgHint.textContent = text;
  }

  /** Resolution choices: bars come in whole fractional-octave bands only. */
  private renderResolution(): void {
    const s = this.app.settings;
    const bars = s.rtaStyle === 'bars';
    const all: { value: Smoothing; label: string }[] = [
      { value: 0, label: 'FFT (narrow)' },
      { value: 48, label: '1/48 oct' },
      { value: 24, label: '1/24 oct' },
      { value: 12, label: '1/12 oct' },
      { value: 6, label: '1/6 oct' },
      { value: 3, label: '1/3 oct' },
      { value: 1, label: '1/1 oct' },
    ];
    const opts = bars ? all.filter((o) => o.value !== 0 && o.value !== 48) : all;
    this.resHost.replaceChildren(
      h('span', { class: 'tb-label' }, bars ? 'Bands' : 'Resolution'),
      select(opts, s.rtaSmoothing, (v) => { s.rtaSmoothing = v; this.app.save(); }, { dataset: { setting: 'rtaSmoothing' } }),
    );
  }

  setStyle(style: 'line' | 'bars'): void {
    const s = this.app.settings;
    s.rtaStyle = style;
    // Narrow-band FFT and 1/48 octave have no sensible bar width: switch to third-octave bars
    if (style === 'bars' && (s.rtaSmoothing === 0 || s.rtaSmoothing === 48)) s.rtaSmoothing = 3;
    this.app.save();
    this.renderResolution();
    const sel = this.el.querySelector<HTMLSelectElement>('select[data-setting="rtaStyle"]');
    if (sel) sel.value = style;
  }

  private toolbar(): HTMLElement {
    this.renderResolution();
    const s = this.app.settings;
    const app = this.app;
    // Everyday controls stay in the toolbar; the rest live in the Options panel
    const options = optionsMenu(
      [
        optHead('Panels'),
        h('div', { class: 'opt-ctl' }, this.panelChip('rta', 'Spectrum', 'spectrum'), this.panelChip('spl', 'SPL meter', 'SPL meter'), this.panelChip('levels', 'Input levels', 'input level')),
        optHead('Analysis'),
        optRow('FFT size', select([4096, 8192, 16384, 32768, 65536].map((n) => ({ value: n, label: `${n / 1024}k` })), s.rtaFft, (v) => { s.rtaFft = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'rtaFft' }, title: 'Longer FFTs resolve lower frequencies but react more slowly' })),
        optRow('Averaging', select(AVG_OPTIONS, s.rtaAveraging, (v) => { s.rtaAveraging = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'rtaAveraging' }, title: 'More averaging steadies the curve but makes it slower to follow changes' }), this.avgHint),
        optRow(
          'Updates',
          select(
            [
              { value: 25 as const, label: '25 per second' },
              { value: 50 as const, label: '50 per second' },
            ],
            s.rtaUpdates,
            (v) => { s.rtaUpdates = v; app.applyAnalysisSettings(); },
            { dataset: { setting: 'rtaUpdates' }, title: 'New spectra per second: 50 follows changes faster and moves more smoothly, with about twice the processing. The averaging time stays the same.' },
          ),
        ),
        optHead('Display'),
        optRow('Peak hold', this.settingChip('peakHold', 'On', 'Keep the highest level at each frequency (P)')),
        optRow(
          'Motion',
          select(
            [
              { value: 'smooth' as const, label: 'Smooth (glide)' },
              { value: 'stepped' as const, label: 'Stepped' },
            ],
            s.rtaMotion,
            (v) => { s.rtaMotion = v; app.save(); },
            { dataset: { setting: 'rtaMotion' }, title: 'Smooth: the curve glides from one spectrum to the next (≈ 40 ms behind). Stepped: it jumps to each new spectrum.' },
          ),
        ),
        optRow('Trace', colourChoice(s.rtaTraceColor, (v) => { s.rtaTraceColor = v; app.save(); }, { auto: 'Measurement colour', label: 'Spectrum trace colour' })),
        optRow('Fill', colourChoice(s.rtaFillColor, (v) => { s.rtaFillColor = v; app.save(); }, { auto: 'Same as the trace', none: true, label: 'Spectrum fill colour' })),
        optRow(
          'Fill style',
          select(
            [
              { value: 'solid' as const, label: 'Solid' },
              { value: 'fade' as const, label: 'Fade (gradient downwards)' },
              { value: 'level' as const, label: 'By level (green → red)' },
              { value: 'frequency' as const, label: 'By frequency (rainbow)' },
            ],
            s.rtaFillGradient,
            (v) => {
              s.rtaFillGradient = v;
              app.save();
            },
            { title: 'How the area under the line, or the bars, is painted', dataset: { setting: 'rtaFillGradient' } },
          ),
        ),
        optRow(
          'Fill opacity',
          select(
            [{ value: 0, label: 'Default' }, ...[10, 20, 35, 50, 75, 100].map((v) => ({ value: v, label: `${v} %` }))],
            s.rtaFillOpacity,
            (v) => {
              s.rtaFillOpacity = v;
              app.save();
            },
            { title: 'How strongly the area under the line, or the bars, are filled', dataset: { setting: 'rtaFillOpacity' } },
          ),
        ),
        optHead('Average curve'),
        optRow(
          'Smoothing',
          select(
            [
              { value: 0, label: 'None' },
              { value: 12, label: '1/12 octave' },
              { value: 6, label: '1/6 octave' },
              { value: 3, label: '1/3 octave' },
              { value: 1, label: '1/1 octave' },
            ],
            s.rtaAverageSmoothing,
            (v) => {
              s.rtaAverageSmoothing = v;
              app.save();
            },
            { title: 'Smoothing of the average curve', dataset: { setting: 'rtaAverageSmoothing' } },
          ),
        ),
        optRow(
          'Colour',
          select(
            AVG_COLORS,
            s.avgCurveColor,
            (v) => {
              s.avgCurveColor = v;
              app.save();
            },
            { title: 'Colour of the average curve (Auto: white, or with several mics each mic’s own colour, lightened)', dataset: { setting: 'avgCurveColor' } },
          ),
        ),
        optRow(
          'Thickness',
          select(
            [1, 1.5, 2, 3, 4, 6].map((v) => ({ value: v, label: `${v} px` })),
            s.avgCurveWidth,
            (v) => {
              s.avgCurveWidth = v;
              app.save();
            },
            { title: 'Line width of the average curve', dataset: { setting: 'avgCurveWidth' } },
          ),
        ),
        optRow('', this.settingChip('avgCurveShow', 'Visible', 'Show or hide the average curve (it keeps averaging while hidden)'), h('button', { class: 'btn small', title: 'Start only the average curve again', onclick: () => app.measurements.forEach((m) => m.resetAverage()) }, icon('reset', 14), 'Restart average curve')),
        optHead('Overlays'),
        optRow('Target tolerance', this.target.toleranceControl()),
        optRow('Several mics', micAverageControl(app)),
        optRow('Saved sweeps', this.settingChip('rtaShowSweeps', 'Show', 'Show saved sweep traces here too, levelled to the live spectrum: a sweep measures the shape of the response, not its level')),
        optHead('Layout'),
        h('div', { class: 'opt-ctl' }, this.resetLayoutButton()),
      ],
      { title: 'Spectrum options: panels, analysis, display, average curve, overlays', id: 'spectrum' },
    );
    return h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'tb-group' },
        select(
          [
            { value: 'line' as const, label: 'Line' },
            { value: 'bars' as const, label: 'Bars' },
          ],
          s.rtaStyle,
          (v) => this.setStyle(v),
          { dataset: { setting: 'rtaStyle' }, title: 'Draw the spectrum as a line or as fractional-octave bars (B)' },
        ),
        this.resHost,
      ),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'Average'),
        select(
          [
            { value: 0, label: 'Off' },
            { value: 1, label: '1 s' },
            { value: 3, label: '3 s' },
            { value: 10, label: '10 s' },
            { value: 30, label: '30 s' },
            { value: -1, label: 'All' },
          ],
          s.rtaAverageCurve,
          (v) => {
            s.rtaAverageCurve = v;
            for (const m of app.measurements) m.resetAverage();
            app.save();
          },
          { title: 'Average curve over the live spectrum, for tuning (All: everything since Reset)', dataset: { setting: 'rtaAverageCurve' } },
        ),
        this.settingChip('avgCurveShow', icon('eye', 14), 'Show / hide the average curve (it keeps averaging while hidden)'),
      ),
      this.target.targetControl(),
      this.settingChip('rtaPeakMarks', 'Peaks', 'Highlight the highest peak in the low (20–250 Hz), mid (250 Hz–4 kHz) and high (4–20 kHz) ranges'),
      this.settingChip('feedbackFinder', 'Feedback', 'Feedback finder: narrow peaks that grow or ring, each with a suggested notch filter for the EQ tab'),
      this.notes.button(),
      h('div', { class: 'spacer' }),
      options,
      this.resetButton(),
    );
  }

  /**
   * Saved sweeps (Sweep & Room → Save as trace) on the Spectrum. A sweep gives the response's shape relative to
   * the test signal, not a sound level, so each is moved to sit on the live curve: same mean level over
   * 250 Hz–4 kHz (on the middle of the graph when nothing is measured).
   */
  private sweepSeries(live: ArrayLike<number> | null): Series[] {
    const out: Series[] = [];
    const g = this.app.grid;
    const at: number[] = [];
    for (let f = 250; f <= 4000; f *= 2 ** (1 / 6)) at.push(f);
    const mean = (fn: (f: number) => number) => {
      let sum = 0;
      let n = 0;
      for (const f of at) {
        const v = fn(f);
        if (Number.isFinite(v)) (sum += v), n++;
      }
      return n ? sum / n : NaN;
    };
    const level = live ? mean((f) => sampleLogGrid(g, live, f)) : (this.rta.cfg.yMin + this.rta.cfg.yMax) / 2;
    for (const t of this.app.traces.traces) {
      if (!t.visible || t.kind !== 'sweep' || !t.freqs.length) continue;
      const own = mean((f) => (f < t.freqs[0] || f > t.freqs[t.freqs.length - 1] ? NaN : interp(t.freqs, t.mag, f)));
      const add = (Number.isFinite(level) && Number.isFinite(own) ? level - own : 0) + t.offset;
      out.push({ id: t.id, label: `${t.name} (sweep, levelled)`, x: t.freqs, y: t.mag.map((v) => v + add), color: t.color, width: 1.4, dash: [8, 3, 2, 3] });
    }
    return out;
  }

  tick(detachedOnly = false): void {
    this.detachedOnly = detachedOnly;
    const app = this.app;
    const s = app.settings;
    this.renderAvgHint();
    if (this.notes.apply()) this.lastKey = '';
    if (this.tickFeedback()) this.lastKey = '';
    if (this.visible('rta')) {
      // Redraw only when what is shown changed (new analysis data arrives ~6–12 times a second)
      const key = `${app.traces.version}|${s.rtaStyle}|${s.rtaSmoothing}|${s.peakHold}|${s.rtaAverageCurve}|${s.rtaAverageSmoothing}|${s.avgCurveShow}|${s.rtaPeakMarks}|${s.rtaShowSweeps}|${s.rtaTraceColor}|${s.rtaFillColor}|${s.rtaFillOpacity}|${s.rtaFillGradient}|${s.avgCurveColor}|${s.avgCurveWidth}|${s.micAverage}|${s.targetCurve}|${s.targetTolerance}|${s.theme}|${s.splCalibrated}|${s.splOffset}|${JSON.stringify(s.mics.map((mc) => [mc.channel, mc.splCalibrated && mc.splOffset]))}|${app.measurements.map((m) => `${m.cfg.id}:${m.cfg.enabled}:${m.cfg.color}:${m.rtaShown}`).join(',')}`;
      if (key === this.lastKey) return this.tickMeters();
      this.lastKey = key;
      const g = app.grid;
      const series: Series[] = [];
      // Each mic has its own SPL calibration: every curve is shifted by the offset of its own input
      const shown = app.measurements.filter((m) => m.cfg.enabled);
      const spl = shown.some((m) => app.isCalibrated(m.cfg.mic));
      const offOf = (channel: number) => app.splOffsetFor(channel);
      const cal = shown.length ? offOf(shown[0].cfg.mic) : 0;
      const nameOf = (m: (typeof shown)[number]) => (spl && !app.isCalibrated(m.cfg.mic) ? `${m.cfg.name} (uncal.)` : m.cfg.name);
      for (const t of app.traces.traces) {
        if (!t.visible || t.kind !== 'rta') continue;
        // Captured RTAs are stored in dBFS: show them in the same units as the live curves (their input's mic)
        const add = t.offset + (t.dbfs ? offOf(t.channel ?? s.splChannel) : 0);
        series.push({ id: t.id, label: t.name, x: t.freqs, y: add ? t.mag.map((v) => v + add) : t.mag, color: t.color, width: 1.2, dash: [5, 3] });
      }
      if (cal !== this.appliedCal) {
        // Keep the view on the data when SPL calibration (e.g. adopted from the measurement host) changes units
        this.rta.shiftY(cal - this.appliedCal);
        this.appliedCal = cal;
      }
      const shiftBy = (y: Float64Array, off: number) => (off ? Array.from(y, (v) => v + off) : y);
      const bars = s.rtaStyle === 'bars' && s.rtaSmoothing > 0 && s.rtaSmoothing < 48 ? s.rtaSmoothing : 0;
      if (bars && this.bandFraction !== bars) {
        this.bandFraction = bars;
        this.bands = octaveBandCentres(bars, 20, 20000);
      }
      // Band levels at the exact band centres (the RTA is already band power at this resolution)
      const atBands = (y: Float64Array, off: number) => this.bands.map((f) => sampleLogGrid(g, y, f) + off);
      // Chosen colours (Options → Colours): the trace, and the fill under the line / of the bars
      const traceOf = (c: string) => (s.rtaTraceColor === 'auto' ? c : s.rtaTraceColor);
      const fillStyle: Pick<Series, 'fillColor' | 'fillAlpha' | 'fillGradient'> =
        s.rtaFillColor === 'none' ? { fillAlpha: 0 } : { fillColor: s.rtaFillColor === 'auto' ? undefined : s.rtaFillColor, fillAlpha: s.rtaFillOpacity ? s.rtaFillOpacity / 100 : undefined, fillGradient: s.rtaFillGradient };
      const only = s.micAverage === 'only' && app.measurements.filter((m) => m.cfg.enabled).length > 1;
      for (const m of app.measurements) {
        if (!m.cfg.enabled || only || !m.hasRta) continue;
        const off = offOf(m.cfg.mic);
        if (bars) {
          series.push({ id: m.cfg.id, label: nameOf(m), x: this.bands, y: atBands(m.rtaOut, off), color: traceOf(m.cfg.color), bars, ...fillStyle });
          if (s.peakHold) series.push({ id: `${m.cfg.id}-pk`, label: `${m.cfg.name} peak`, x: this.bands, y: atBands(m.rtaPeakOut, off), color: traceOf(m.cfg.color), bars, cap: true });
          continue;
        }
        if (s.peakHold) series.push({ id: `${m.cfg.id}-pk`, label: `${m.cfg.name} peak`, x: g, y: shiftBy(m.rtaPeakOut, off), color: traceOf(m.cfg.color), width: 1, dash: [2, 2] });
        series.push({ id: m.cfg.id, label: nameOf(m), x: g, y: shiftBy(m.rtaOut, off), color: traceOf(m.cfg.color), width: 1.6, fill: true, ...fillStyle });
      }
      // Average curves (for tuning) on top of everything: the long-term balance behind the live RTA
      const day = s.theme === 'day';
      series.push(...micAverageSeries(app, g, app.measurements.filter((m) => m.cfg.enabled && m.hasRta).map((m) => shiftBy(m.rtaOut, offOf(m.cfg.mic)))));
      // One average curve: white (black by day). Several (one per mic): each in its mic's colour, lightened (darkened
      // by day) so it stands apart from the live trace, and each with its own dash pattern, so they can be told
      // apart even when two colours look alike
      const avgs = app.measurements.filter((m) => m.cfg.enabled && !only && s.avgCurveShow && m.averageDb());
      const several = avgs.length > 1;
      avgs.forEach((m, k) => {
        const avg = m.averageDb()!;
        const label = `${m.cfg.name} average${s.rtaAverageCurve > 0 ? ` (${s.rtaAverageCurve} s)` : ''}`;
        const color = s.avgCurveColor !== 'auto' ? s.avgCurveColor : several ? tint(m.cfg.color, day ? '#000000' : '#ffffff', 0.45) : day ? '#111111' : '#ffffff';
        // Drawn as a smooth curve on the fine grid in both display styles (over bars too)
        series.push({ id: `${m.cfg.id}-avg`, label, x: g, y: shiftBy(avg, offOf(m.cfg.mic)), color, width: s.avgCurveWidth, dash: several ? AVG_DASHES[k % AVG_DASHES.length] : undefined, halo: day ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)' });
      });
      // Target curve, levelled to the first shown measurement (its average curve when there is one)
      const ref = app.measurements.find((m) => m.cfg.enabled && m.hasRta);
      if (s.rtaShowSweeps) series.unshift(...this.sweepSeries(ref ? shiftBy(ref.averageDb() ?? ref.rtaOut, offOf(ref.cfg.mic)) : null));
      if (ref) {
        const data = ref.averageDb() ?? ref.rtaOut;
        series.unshift(...this.target.series(g, shiftBy(data, offOf(ref.cfg.mic))));
      } else this.target.series(g, null);
      // Highest peak in the low, mid and high ranges, on the curve that is shown: the (steadier) average curve
      // when it is on, else the bars or the live line
      this.rta.pins = [];
      if (s.rtaPeakMarks && ref) {
        const off = offOf(ref.cfg.mic);
        const avg = s.avgCurveShow && !only ? ref.averageDb() : null;
        const [px, py] = avg ? [g, shiftBy(avg, off)] : bars ? [this.bands, atBands(ref.rtaOut, off)] : [g, shiftBy(ref.rtaOut, off)];
        this.peaks = rangePeaks(px, py);
        // Only real peaks get a label: a range whose highest point is just its edge (a slope) is left out
        this.rta.pins = this.peaks.filter((p) => p.isPeak).map((p) => ({ x: p.f, y: p.level, color: '#ffd60a', label: `${p.range.label} ${p.f >= 1000 ? `${+(p.f / 1000).toFixed(p.f >= 10000 ? 1 : 2)} kHz` : `${Math.round(p.f)} Hz`} · ${p.level.toFixed(1)} dB` }));
      } else this.peaks = [];
      this.rta.markers = this.fb.map((c) => ({ x: c.f, color: '#ff4d5e', top: true, label: `${c.kind === 'rising' ? '↑ ' : ''}${fmtF(c.f)}` }));
      this.rta.cfg.yUnit = spl ? 'dB SPL' : 'dBFS';
      this.rta.series = series;
      this.rta.draw();
      return this.tickMeters();
    }
    this.tickMeters();
  }
}
