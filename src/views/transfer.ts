import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import { SMOOTHING_OPTIONS, type Smoothing } from '../dsp/freq';
import { AVG_OPTIONS, cohAlpha } from './meters';
import { DockedView } from './docked';
import { optionsMenu, optRow, optHead } from '../ui/popover';
import { TargetOverlay } from './target-overlay';
import { micAverageControl, micAverageSeries } from './mic-average-overlay';

export function defaultTransferLayout(): DockLayout {
  return {
    order: ['mag', 'phase', 'spl', 'levels'],
    sizes: { mag: 1.5, phase: 1, spl: 0.5, levels: 0.6 },
    hidden: ['spl'],
    floating: {
      levels: { x: -14, y: -40, w: 250, h: 190 },
      spl: { x: -276, y: -40, w: 230, h: 150 },
    },
  };
}

/** Dual-channel transfer function: magnitude with coherence, phase, plus SPL and level meters. */
export class TransferView extends DockedView implements View {
  id = 'transfer' as const;
  readonly needs = { tf: true };
  title = 'Transfer';
  icon = 'wave' as const;
  private mag: Plot;
  private phase: Plot;
  private alphas = new Map<string, Float64Array>();
  readonly target: TargetOverlay;

  constructor(app: App) {
    super(app, 'transferLayout', defaultTransferLayout);
    this.target = new TargetOverlay(app);
    const s = app.settings;
    this.mag = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.magRange[0], yMax: s.magRange[1], yUnit: 'dB', yStep: 6, secondaryLabel: 'Coherence', showNote: true, yLimits: [-120, 120] });
    this.phase = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -180, yMax: 180, yUnit: 'deg', yStep: 45, yLimits: [-540, 540] });
    this.mag.onRangeChange = (a, b) => {
      s.magRange = [a, b];
      app.save();
    };
    this.mountDock(
      [this.plotPanel('mag', 'Transfer function · magnitude & coherence', this.mag), this.plotPanel('phase', 'Transfer function · phase', this.phase), ...this.meterPanels()],
      this.toolbar(),
    );
  }

  private toolbar(): HTMLElement {
    const s = this.app.settings;
    const app = this.app;
    const cohSlider = h('input', { type: 'range', min: '0', max: '0.95', step: '0.05', value: String(s.coherenceThreshold), class: 'mini-range', title: 'Fade data with coherence below this value' });
    const cohVal = h('span', { class: 'dim small' }, `${Math.round(s.coherenceThreshold * 100)}%`);
    cohSlider.addEventListener('input', () => {
      s.coherenceThreshold = +cohSlider.value;
      cohVal.textContent = `${Math.round(s.coherenceThreshold * 100)}%`;
      app.save();
    });
    const options = optionsMenu(
      [
        optHead('Panels'),
        h('div', { class: 'opt-ctl' }, this.panelChip('mag', 'Magnitude', 'magnitude'), this.panelChip('phase', 'Phase', 'phase'), this.panelChip('spl', 'SPL meter', 'SPL meter'), this.panelChip('levels', 'Input levels', 'input level')),
        optHead('Display'),
        optRow('Blank below', cohSlider, cohVal),
        optRow('Target tolerance', this.target.toleranceControl()),
        optRow('Several mics', micAverageControl(app)),
        optHead('Layout'),
        h('div', { class: 'opt-ctl' }, this.resetLayoutButton()),
      ],
      { title: 'Transfer options: panels, coherence blanking, tolerance, several mics', id: 'transfer' },
    );
    return h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Smoothing'), select(SMOOTHING_OPTIONS.filter((o) => o.value !== 0), s.tfSmoothing, (v: Smoothing) => { s.tfSmoothing = v; app.save(); }, { dataset: { setting: 'tfSmoothing' } }), h('span', { class: 'tb-label' }, 'Avg'), select(AVG_OPTIONS, s.tfAveraging, (v) => { s.tfAveraging = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'tfAveraging' } })),
      this.target.targetControl(),
      this.settingChip('showCoherence', 'Coherence', 'Show coherence trace on the magnitude plot'),
      h('div', { class: 'spacer' }),
      options,
      this.resetButton(),
    );
  }

  private alpha(id: string, coh: Float64Array): Float64Array {
    let a = this.alphas.get(id);
    if (!a || a.length !== coh.length) {
      a = new Float64Array(coh.length);
      this.alphas.set(id, a);
    }
    return cohAlpha(coh, this.app.settings.coherenceThreshold, a);
  }

  private lastKey = '';

  invalidate(): void {
    this.lastKey = '';
  }

  tick(detachedOnly = false): void {
    this.detachedOnly = detachedOnly;
    const app = this.app;
    const s = app.settings;
    // Redraw only when what is shown changed
    const key = `${app.traces.version}|${s.targetCurve}|${s.targetTolerance}|${s.micAverage}|${s.coherenceThreshold}|${s.showCoherence}|${app.measurements.map((m) => `${m.cfg.id}:${m.cfg.enabled}:${m.cfg.color}:${m.tfReady}:${m.tfShown}`).join(',')}`;
    if (key === this.lastKey) return this.tickMeters();
    this.lastKey = key;
    const g = app.grid;
    const magS: Series[] = [];
    const phS: Series[] = [];
    for (const t of app.traces.traces) {
      if (!t.visible || t.kind === 'rta') continue;
      magS.push({ id: t.id, label: t.name, x: t.freqs, y: t.offset ? t.mag.map((v) => v + t.offset) : t.mag, color: t.color, width: 1.3, dash: [5, 3] });
      if (t.phase) phS.push({ id: t.id, label: t.name, x: t.freqs, y: t.phase, color: t.color, width: 1.1, dash: [5, 3], wrap: 180 });
    }
    const live = app.measurements.filter((m) => m.cfg.enabled && m.tfReady);
    const only = s.micAverage === 'only' && live.length > 1;
    for (const m of only ? [] : live) {
      const c = m.cfg.color;
      const a = this.alpha(m.cfg.id, m.result.coh);
      magS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.mag, color: c, width: 2, alpha: a });
      if (s.showCoherence) magS.push({ id: `${m.cfg.id}-coh`, label: `${m.cfg.name} coh`, x: g, y: m.result.coh, color: `${c}66`, width: 1, secondary: true, unit: '%' });
      phS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.phase, color: c, width: 1.6, alpha: a, wrap: 180 });
    }
    // Several mics: their coherence-weighted power average and spread
    magS.push(...micAverageSeries(app, g, live.map((m) => m.mag), live.map((m) => m.result.coh)));
    // Target curve, levelled (coherence-weighted) to the first shown transfer function
    const ref = app.measurements.find((m) => m.cfg.enabled && m.tfReady);
    magS.unshift(...this.target.series(g, ref ? ref.mag : null, ref ? ref.result.coh : null));
    if (this.visible('mag')) {
      this.mag.series = magS;
      this.mag.draw();
    }
    if (this.visible('phase')) {
      this.phase.series = phS;
      this.phase.draw();
    }
    this.tickMeters();
  }
}
