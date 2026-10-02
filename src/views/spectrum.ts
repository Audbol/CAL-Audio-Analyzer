import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import { octaveBandCentres, sampleLogGrid, type Smoothing } from '../dsp/freq';
import { AVG_OPTIONS } from './meters';
import { DockedView } from './docked';
import { optionsMenu, optRow, optHead, colourChoice } from '../ui/popover';
import { TargetOverlay } from './target-overlay';
import { micAverageControl, micAverageSeries } from './mic-average-overlay';
import { rangePeaks, type RangePeak } from '../dsp/peaks';

/** Colours offered for the average curve ('auto': white at night, black by day). */
export const AVG_COLORS = [
  { value: 'auto', label: 'Auto (white / black)' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#ff9f1c', label: 'Orange' },
  { value: '#ff4d6d', label: 'Red' },
  { value: '#ff5cf0', label: 'Magenta' },
  { value: '#4cc9f0', label: 'Cyan' },
  { value: '#7cff6b', label: 'Green' },
];

export function defaultSpectrumLayout(): DockLayout {
  return {
    order: ['rta', 'spl', 'levels'],
    sizes: { rta: 1, spl: 0.5, levels: 0.6 },
    hidden: [],
    floating: {
      levels: { x: -14, y: -40, w: 250, h: 210 },
      spl: { x: -276, y: -40, w: 250, h: 160 },
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
    this.mountDock([this.plotPanel('rta', 'Spectrum (RTA)', this.rta), ...this.meterPanels()], this.toolbar());
  }

  private resHost = h('span', { class: 'tb-res' });

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
        optRow('Averaging', select(AVG_OPTIONS, s.rtaAveraging, (v) => { s.rtaAveraging = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'rtaAveraging' } })),
        optHead('Colours'),
        optRow('Trace', colourChoice(s.rtaTraceColor, (v) => { s.rtaTraceColor = v; app.save(); }, { auto: 'Measurement colour', label: 'Spectrum trace colour' })),
        optRow('Fill', colourChoice(s.rtaFillColor, (v) => { s.rtaFillColor = v; app.save(); }, { auto: 'Same as the trace', none: true, label: 'Spectrum fill colour' })),
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
        optRow('Show', this.settingChip('avgCurveShow', 'Visible', 'Show or hide the average curve (it keeps averaging while hidden)')),
        optRow(
          'Colour',
          select(
            AVG_COLORS,
            s.avgCurveColor,
            (v) => {
              s.avgCurveColor = v;
              app.save();
            },
            { title: 'Colour of the average curve', dataset: { setting: 'avgCurveColor' } },
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
        optRow('', h('button', { class: 'btn small', title: 'Start only the average curve again', onclick: () => app.measurements.forEach((m) => m.resetAverage()) }, icon('reset', 14), 'Restart average curve')),
        optHead('Target & mics'),
        optRow('Target tolerance', this.target.toleranceControl()),
        optRow('Several mics', micAverageControl(app)),
        optHead('Layout'),
        h('div', { class: 'opt-ctl' }, this.resetLayoutButton()),
      ],
      { title: 'Spectrum options: panels, FFT, averaging, curve smoothing, tolerance, several mics', id: 'spectrum' },
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
      this.settingChip('peakHold', 'Peak hold', 'Peak hold (P)'),
      this.settingChip('rtaPeakMarks', 'Peaks', 'Highlight the highest peak in the low (20–250 Hz), mid (250 Hz–4 kHz) and high (4–20 kHz) ranges'),
      h('div', { class: 'spacer' }),
      options,
      this.resetButton(),
    );
  }

  tick(detachedOnly = false): void {
    this.detachedOnly = detachedOnly;
    const app = this.app;
    const s = app.settings;
    if (this.visible('rta')) {
      // Redraw only when what is shown changed (new analysis data arrives ~6–12 times a second)
      const key = `${app.traces.version}|${s.rtaStyle}|${s.rtaSmoothing}|${s.peakHold}|${s.rtaAverageCurve}|${s.rtaAverageSmoothing}|${s.avgCurveShow}|${s.rtaPeakMarks}|${s.rtaTraceColor}|${s.rtaFillColor}|${s.rtaFillOpacity}|${s.avgCurveColor}|${s.avgCurveWidth}|${s.micAverage}|${s.targetCurve}|${s.targetTolerance}|${s.theme}|${s.splCalibrated}|${s.splOffset}|${JSON.stringify(s.mics.map((mc) => [mc.channel, mc.splCalibrated && mc.splOffset]))}|${app.measurements.map((m) => `${m.cfg.id}:${m.cfg.enabled}:${m.cfg.color}:${m.rtaShown}`).join(',')}`;
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
      const fillStyle: Pick<Series, 'fillColor' | 'fillAlpha'> =
        s.rtaFillColor === 'none' ? { fillAlpha: 0 } : { fillColor: s.rtaFillColor === 'auto' ? undefined : s.rtaFillColor, fillAlpha: s.rtaFillOpacity ? s.rtaFillOpacity / 100 : undefined };
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
      const avgColor = s.avgCurveColor === 'auto' ? (day ? '#111111' : '#ffffff') : s.avgCurveColor;
      for (const m of app.measurements) {
        const avg = m.cfg.enabled && !only && s.avgCurveShow ? m.averageDb() : null;
        if (!avg) continue;
        const label = `${m.cfg.name} average${s.rtaAverageCurve > 0 ? ` (${s.rtaAverageCurve} s)` : ''}`;
        // Drawn as a smooth curve on the fine grid in both display styles (over bars too)
        series.push({ id: `${m.cfg.id}-avg`, label, x: g, y: shiftBy(avg, offOf(m.cfg.mic)), color: avgColor, width: s.avgCurveWidth, halo: day ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)' });
      }
      // Target curve, levelled to the first shown measurement (its average curve when there is one)
      const ref = app.measurements.find((m) => m.cfg.enabled && m.hasRta);
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
        this.rta.pins = this.peaks.map((p) => ({ x: p.f, y: p.level, color: '#ffd60a', label: `${p.range.label}${p.isPeak ? '' : ' (no peak)'} ${p.f >= 1000 ? `${+(p.f / 1000).toFixed(p.f >= 10000 ? 1 : 2)} kHz` : `${Math.round(p.f)} Hz`} · ${p.level.toFixed(1)} dB` }));
      } else this.peaks = [];
      this.rta.cfg.yUnit = spl ? 'dB SPL' : 'dBFS';
      this.rta.series = series;
      this.rta.draw();
      return this.tickMeters();
    }
    this.tickMeters();
  }
}
