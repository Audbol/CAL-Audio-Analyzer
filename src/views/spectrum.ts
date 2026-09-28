import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import type { Smoothing } from '../dsp/freq';
import { AVG_OPTIONS } from './meters';
import { DockedView } from './docked';

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
  title = 'Spectrum';
  icon = 'bars' as const;
  private rta: Plot;

  constructor(app: App) {
    super(app, 'spectrumLayout', defaultSpectrumLayout);
    const s = app.settings;
    this.rta = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.rtaRange[0], yMax: s.rtaRange[1], yUnit: 'dBFS', yStep: 10, showNote: true, yLimits: [-200, 160] });
    this.rta.onRangeChange = (a, b) => {
      s.rtaRange = [a, b];
      app.save();
    };
    this.mountDock([this.plotPanel('rta', 'Spectrum (RTA)', this.rta), ...this.meterPanels()], this.toolbar());
  }

  private toolbar(): HTMLElement {
    const s = this.app.settings;
    const app = this.app;
    return h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, this.panelChip('rta', 'RTA', 'spectrum'), this.panelChip('spl', 'SPL', 'SPL meter'), this.panelChip('levels', 'Levels', 'input level')),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'Resolution'),
        select(
          [
            { value: 0 as Smoothing, label: 'FFT (narrow)' },
            { value: 48 as Smoothing, label: '1/48 oct' },
            { value: 24 as Smoothing, label: '1/24 oct' },
            { value: 12 as Smoothing, label: '1/12 oct' },
            { value: 6 as Smoothing, label: '1/6 oct' },
            { value: 3 as Smoothing, label: '1/3 oct' },
            { value: 1 as Smoothing, label: '1/1 oct' },
          ],
          s.rtaSmoothing,
          (v) => { s.rtaSmoothing = v; app.save(); },
        ),
        select([4096, 8192, 16384, 32768, 65536].map((n) => ({ value: n, label: `${n / 1024}k FFT` })), s.rtaFft, (v) => { s.rtaFft = v; app.applyAnalysisSettings(); }),
        h('span', { class: 'tb-label' }, 'Avg'),
        select(AVG_OPTIONS, s.rtaAveraging, (v) => { s.rtaAveraging = v; app.applyAnalysisSettings(); }),
        this.settingChip('peakHold', 'Peak hold', 'Peak hold (P)'),
      ),
      h('div', { class: 'spacer' }),
      ...this.layoutButtons(),
    );
  }

  tick(): void {
    const app = this.app;
    const s = app.settings;
    if (this.visible('rta')) {
      const g = app.grid;
      const series: Series[] = [];
      for (const t of app.traces.traces) {
        if (!t.visible || t.kind !== 'rta') continue;
        series.push({ id: t.id, label: t.name, x: t.freqs, y: t.offset ? t.mag.map((v) => v + t.offset) : t.mag, color: t.color, width: 1.2, dash: [5, 3] });
      }
      const cal = s.splCalibrated ? s.splOffset : 0;
      const shift = (y: Float64Array) => (cal ? Array.from(y, (v) => v + cal) : y);
      for (const m of app.measurements) {
        if (!m.cfg.enabled) continue;
        if (s.peakHold) series.push({ id: `${m.cfg.id}-pk`, label: `${m.cfg.name} peak`, x: g, y: shift(m.rtaPeakOut), color: m.cfg.color, width: 1, dash: [2, 2] });
        series.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: shift(m.rtaOut), color: m.cfg.color, width: 1.6, fill: true });
      }
      this.rta.cfg.yUnit = s.splCalibrated ? 'dB SPL' : 'dBFS';
      this.rta.series = series;
      this.rta.draw();
    }
    this.tickMeters();
  }
}
