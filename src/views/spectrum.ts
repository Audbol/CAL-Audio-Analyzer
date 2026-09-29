import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import { octaveBandCentres, sampleLogGrid, type Smoothing } from '../dsp/freq';
import { AVG_OPTIONS } from './meters';
import { DockedView } from './docked';
import { TargetOverlay } from './target-overlay';
import { micAverageControl, micAverageSeries } from './mic-average-overlay';

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
    return h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, this.panelChip('rta', 'RTA', 'spectrum'), this.panelChip('spl', 'SPL', 'SPL meter'), this.panelChip('levels', 'Levels', 'input level')),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'Display'),
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
        select([4096, 8192, 16384, 32768, 65536].map((n) => ({ value: n, label: `${n / 1024}k FFT` })), s.rtaFft, (v) => { s.rtaFft = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'rtaFft' } }),
        h('span', { class: 'tb-label' }, 'Avg'),
        select(AVG_OPTIONS, s.rtaAveraging, (v) => { s.rtaAveraging = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'rtaAveraging' } }),
        this.settingChip('peakHold', 'Peak hold', 'Peak hold (P)'),
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
            { value: -1, label: 'All (since reset)' },
          ],
          s.rtaAverageCurve,
          (v) => {
            s.rtaAverageCurve = v;
            for (const m of app.measurements) m.resetAverage();
            app.save();
          },
          { title: 'Average curve over the live RTA, for tuning', dataset: { setting: 'rtaAverageCurve' } },
        ),
        select(
          [
            { value: 0, label: 'Unsmoothed' },
            { value: 12, label: 'Smooth 1/12' },
            { value: 6, label: 'Smooth 1/6' },
            { value: 3, label: 'Smooth 1/3' },
            { value: 1, label: 'Smooth 1/1' },
          ],
          s.rtaAverageSmoothing,
          (v) => {
            s.rtaAverageSmoothing = v;
            app.save();
          },
          { title: 'Smoothing of the average curve (octave fraction)', dataset: { setting: 'rtaAverageSmoothing' } },
        ),
        h('button', { class: 'btn small', title: 'Start the average curve again (R restarts it together with all averaging)', onclick: () => app.measurements.forEach((m) => m.resetAverage()) }, icon('reset', 14), 'Restart'),
      ),
      this.target.controls(),
      h('div', { class: 'tb-group' }, micAverageControl(app)),
      h('div', { class: 'spacer' }),
      ...this.layoutButtons(),
    );
  }

  tick(detachedOnly = false): void {
    this.detachedOnly = detachedOnly;
    const app = this.app;
    const s = app.settings;
    if (this.visible('rta')) {
      // Redraw only when what is shown changed (new analysis data arrives ~6–12 times a second)
      const key = `${app.traces.version}|${s.rtaStyle}|${s.rtaSmoothing}|${s.peakHold}|${s.rtaAverageCurve}|${s.rtaAverageSmoothing}|${s.micAverage}|${s.targetCurve}|${s.targetTolerance}|${s.theme}|${s.splCalibrated}|${s.splOffset}|${app.measurements.map((m) => `${m.cfg.id}:${m.cfg.enabled}:${m.cfg.color}:${m.rtaShown}`).join(',')}`;
      if (key === this.lastKey) return this.tickMeters();
      this.lastKey = key;
      const g = app.grid;
      const series: Series[] = [];
      const cal = s.splCalibrated ? s.splOffset : 0;
      for (const t of app.traces.traces) {
        if (!t.visible || t.kind !== 'rta') continue;
        // Captured RTAs are stored in dBFS: show them in the same units as the live curves
        const add = t.offset + (t.dbfs ? cal : 0);
        series.push({ id: t.id, label: t.name, x: t.freqs, y: add ? t.mag.map((v) => v + add) : t.mag, color: t.color, width: 1.2, dash: [5, 3] });
      }
      if (cal !== this.appliedCal) {
        // Keep the view on the data when SPL calibration (e.g. adopted from the measurement host) changes units
        this.rta.shiftY(cal - this.appliedCal);
        this.appliedCal = cal;
      }
      const shift = (y: Float64Array) => (cal ? Array.from(y, (v) => v + cal) : y);
      const bars = s.rtaStyle === 'bars' && s.rtaSmoothing > 0 && s.rtaSmoothing < 48 ? s.rtaSmoothing : 0;
      if (bars && this.bandFraction !== bars) {
        this.bandFraction = bars;
        this.bands = octaveBandCentres(bars, 20, 20000);
      }
      // Band levels at the exact band centres (the RTA is already band power at this resolution)
      const atBands = (y: Float64Array) => this.bands.map((f) => sampleLogGrid(g, y, f) + cal);
      const only = s.micAverage === 'only' && app.measurements.filter((m) => m.cfg.enabled).length > 1;
      for (const m of app.measurements) {
        if (!m.cfg.enabled || only) continue;
        if (bars) {
          series.push({ id: m.cfg.id, label: m.cfg.name, x: this.bands, y: atBands(m.rtaOut), color: m.cfg.color, bars });
          if (s.peakHold) series.push({ id: `${m.cfg.id}-pk`, label: `${m.cfg.name} peak`, x: this.bands, y: atBands(m.rtaPeakOut), color: m.cfg.color, bars, cap: true });
          continue;
        }
        if (s.peakHold) series.push({ id: `${m.cfg.id}-pk`, label: `${m.cfg.name} peak`, x: g, y: shift(m.rtaPeakOut), color: m.cfg.color, width: 1, dash: [2, 2] });
        series.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: shift(m.rtaOut), color: m.cfg.color, width: 1.6, fill: true });
      }
      // Average curves (for tuning) on top of everything: the long-term balance behind the live RTA
      const day = s.theme === 'day';
      series.push(...micAverageSeries(app, g, app.measurements.filter((m) => m.cfg.enabled && m.rtaShown > 0).map((m) => shift(m.rtaOut))));
      for (const m of app.measurements) {
        const avg = m.cfg.enabled && !only ? m.averageDb() : null;
        if (!avg) continue;
        const label = `${m.cfg.name} average${s.rtaAverageCurve > 0 ? ` (${s.rtaAverageCurve} s)` : ''}`;
        // Drawn as a smooth curve on the fine grid in both display styles (over bars too)
        series.push({ id: `${m.cfg.id}-avg`, label, x: g, y: shift(avg), color: day ? '#111111' : '#ffffff', width: 2, halo: day ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)' });
      }
      // Target curve, levelled to the first shown measurement (its average curve when there is one)
      const ref = app.measurements.find((m) => m.cfg.enabled && m.rtaShown > 0);
      if (ref) {
        const data = ref.averageDb() ?? ref.rtaOut;
        series.unshift(...this.target.series(g, shift(data)));
      } else this.target.series(g, null);
      this.rta.cfg.yUnit = s.splCalibrated ? 'dB SPL' : 'dBFS';
      this.rta.series = series;
      this.rta.draw();
      return this.tickMeters();
    }
    this.tickMeters();
  }
}
