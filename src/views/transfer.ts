import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import { SMOOTHING_OPTIONS, type Smoothing } from '../dsp/freq';
import { AVG_OPTIONS, cohAlpha } from './meters';
import { DockedView } from './docked';

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

  constructor(app: App) {
    super(app, 'transferLayout', defaultTransferLayout);
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
    const cohSlider = h('input', { type: 'range', min: '0', max: '0.95', step: '0.05', value: String(s.coherenceThreshold), class: 'mini-range', title: 'Coherence blanking threshold' });
    const cohVal = h('span', { class: 'dim small' }, `${Math.round(s.coherenceThreshold * 100)}%`);
    cohSlider.addEventListener('input', () => {
      s.coherenceThreshold = +cohSlider.value;
      cohVal.textContent = `${Math.round(s.coherenceThreshold * 100)}%`;
      app.save();
    });
    return h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, this.panelChip('mag', 'Magnitude', 'magnitude'), this.panelChip('phase', 'Phase', 'phase'), this.panelChip('spl', 'SPL', 'SPL meter'), this.panelChip('levels', 'Levels', 'input level')),
      h('div', { class: 'tb-group' }, this.settingChip('showCoherence', 'Coherence', 'Show coherence trace on the magnitude plot')),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Smoothing'), select(SMOOTHING_OPTIONS.filter((o) => o.value !== 0), s.tfSmoothing, (v: Smoothing) => { s.tfSmoothing = v; app.save(); }), h('span', { class: 'tb-label' }, 'Avg'), select(AVG_OPTIONS, s.tfAveraging, (v) => { s.tfAveraging = v; app.applyAnalysisSettings(); }, { dataset: { setting: 'tfAveraging' } })),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label', title: 'Fade data with coherence below this value' }, 'Blank <'), cohSlider, cohVal),
      h('div', { class: 'spacer' }),
      ...this.layoutButtons(),
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
    const key = `${app.traces.version}|${s.coherenceThreshold}|${s.showCoherence}|${app.measurements.map((m) => `${m.cfg.id}:${m.cfg.enabled}:${m.cfg.color}:${m.tfReady}:${m.tfShown}`).join(',')}`;
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
    for (const m of app.measurements) {
      if (!m.cfg.enabled || !m.tfReady) continue;
      const c = m.cfg.color;
      const a = this.alpha(m.cfg.id, m.result.coh);
      magS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.mag, color: c, width: 2, alpha: a });
      if (s.showCoherence) magS.push({ id: `${m.cfg.id}-coh`, label: `${m.cfg.name} coh`, x: g, y: m.result.coh, color: `${c}66`, width: 1, secondary: true, unit: '%' });
      phS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.phase, color: c, width: 1.6, alpha: a, wrap: 180 });
    }
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
