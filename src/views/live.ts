import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import { SMOOTHING_OPTIONS, type Smoothing } from '../dsp/freq';
import type { Averaging } from '../dsp/transfer';

export const AVG_OPTIONS: { value: Averaging; label: string }[] = [
  { value: 1, label: 'None' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
  { value: 8, label: '8' },
  { value: 16, label: '16' },
  { value: 32, label: '32' },
  { value: 64, label: '64' },
  { value: 0, label: '∞ (cumulative)' },
];

/** Coherence → opacity mapping used for coherence blanking. */
export function cohAlpha(coh: Float64Array, threshold: number, out: Float64Array): Float64Array {
  for (let i = 0; i < coh.length; i++) {
    const c = coh[i];
    out[i] = c >= threshold ? 1 : 0.08 + 0.6 * Math.pow(c / Math.max(threshold, 1e-3), 2);
  }
  return out;
}

/** The main dual-channel view: RTA, transfer function magnitude + coherence, and phase. */
export class LiveView implements View {
  id = 'live' as const;
  title = 'Live';
  icon = 'wave' as const;
  el = h('div', { class: 'live' });
  private rta: Plot;
  private mag: Plot;
  private phase: Plot;
  private panes: Record<'rta' | 'mag' | 'phase', HTMLElement>;
  private alphas = new Map<string, Float64Array>();

  constructor(private app: App) {
    const s = app.settings;
    this.rta = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.rtaRange[0], yMax: s.rtaRange[1], yUnit: 'dBFS', yStep: 10, title: 'Spectrum (RTA)', showNote: true, yLimits: [-200, 160] });
    this.mag = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.magRange[0], yMax: s.magRange[1], yUnit: 'dB', yStep: 6, title: 'Transfer function · magnitude', secondaryLabel: 'Coherence', showNote: true, yLimits: [-120, 120] });
    this.phase = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -180, yMax: 180, yUnit: 'deg', yStep: 45, title: 'Transfer function · phase', yLimits: [-540, 540] });
    this.mag.onRangeChange = (a, b) => {
      s.magRange = [a, b];
      app.save();
    };
    this.rta.onRangeChange = (a, b) => {
      s.rtaRange = [a, b];
      app.save();
    };
    this.panes = {
      rta: h('div', { class: 'pane' }, this.rta.el),
      mag: h('div', { class: 'pane big' }, this.mag.el),
      phase: h('div', { class: 'pane' }, this.phase.el),
    };
    this.el.append(this.toolbar(), h('div', { class: 'panes' }, this.panes.rta, this.panes.mag, this.panes.phase));
    this.layout();
  }

  private toolbar(): HTMLElement {
    const s = this.app.settings;
    const app = this.app;
    const toggle = (key: 'showRta' | 'showMag' | 'showPhase' | 'showCoherence' | 'peakHold', label: string, title: string) => {
      const b = h('button', { class: `chip${s[key] ? ' on' : ''}`, title }, label);
      b.addEventListener('click', () => {
        s[key] = !s[key];
        b.classList.toggle('on', s[key]);
        app.save();
        this.layout();
      });
      return b;
    };
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
      h('div', { class: 'tb-group' }, toggle('showRta', 'RTA', 'Show spectrum'), toggle('showMag', 'Magnitude', 'Show transfer function magnitude'), toggle('showPhase', 'Phase', 'Show transfer function phase'), toggle('showCoherence', 'Coherence', 'Show coherence trace')),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'TF smoothing'), select(SMOOTHING_OPTIONS.filter((o) => o.value !== 0), s.tfSmoothing, (v: Smoothing) => { s.tfSmoothing = v; app.save(); }), h('span', { class: 'tb-label' }, 'Avg'), select(AVG_OPTIONS, s.tfAveraging, (v) => { s.tfAveraging = v; app.applyAnalysisSettings(); })),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'RTA'),
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
        select(AVG_OPTIONS, s.rtaAveraging, (v) => { s.rtaAveraging = v; app.applyAnalysisSettings(); }),
        toggle('peakHold', 'Peak', 'Peak hold (P)'),
      ),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label', title: 'Fade data with coherence below this value' }, 'Blank <'), cohSlider, cohVal),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Reset all averages (R)', onclick: () => app.resetAverages() }, icon('reset', 14), 'Reset'),
    );
  }

  private layout(): void {
    const s = this.app.settings;
    this.panes.rta.style.display = s.showRta ? '' : 'none';
    this.panes.mag.style.display = s.showMag ? '' : 'none';
    this.panes.phase.style.display = s.showPhase ? '' : 'none';
  }

  private alpha(id: string, coh: Float64Array): Float64Array {
    let a = this.alphas.get(id);
    if (!a || a.length !== coh.length) {
      a = new Float64Array(coh.length);
      this.alphas.set(id, a);
    }
    return cohAlpha(coh, this.app.settings.coherenceThreshold, a);
  }

  tick(): void {
    const app = this.app;
    const s = app.settings;
    const g = app.grid;
    const rtaS: Series[] = [];
    const magS: Series[] = [];
    const phS: Series[] = [];
    for (const t of app.traces.traces) {
      if (!t.visible) continue;
      const mag = t.offset ? t.mag.map((v) => v + t.offset) : t.mag;
      if (t.kind === 'rta') rtaS.push({ id: t.id, label: t.name, x: t.freqs, y: mag, color: t.color, width: 1.2, dash: [5, 3] });
      else {
        magS.push({ id: t.id, label: t.name, x: t.freqs, y: mag, color: t.color, width: 1.3, dash: [5, 3] });
        if (t.phase) phS.push({ id: t.id, label: t.name, x: t.freqs, y: t.phase, color: t.color, width: 1.1, dash: [5, 3], wrap: 180 });
      }
    }
    for (const m of app.measurements) {
      if (!m.cfg.enabled) continue;
      const c = m.cfg.color;
      if (s.peakHold) rtaS.push({ id: `${m.cfg.id}-pk`, label: `${m.cfg.name} peak`, x: g, y: m.rtaPeakOut, color: c, width: 1, dash: [2, 2] });
      rtaS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.rtaOut, color: c, width: 1.6, fill: true });
      if (m.tf.ready) {
        const a = this.alpha(m.cfg.id, m.result.coh);
        magS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.mag, color: c, width: 2, alpha: a });
        if (s.showCoherence) magS.push({ id: `${m.cfg.id}-coh`, label: `${m.cfg.name} coh`, x: g, y: m.result.coh, color: `${c}66`, width: 1, secondary: true, unit: '%' });
        phS.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: m.phase, color: c, width: 1.6, alpha: a, wrap: 180 });
      }
    }
    if (s.showRta) {
      this.rta.cfg.yUnit = s.splCalibrated ? 'dB SPL' : 'dBFS';
      this.rta.series = rtaS;
      if (s.splCalibrated) for (const x of rtaS) if (!app.traces.traces.find((t) => t.id === x.id)) x.y = Array.from(x.y as Float64Array, (v) => v + s.splOffset);
      this.rta.draw();
    }
    if (s.showMag) {
      this.mag.series = magS;
      this.mag.draw();
    }
    if (s.showPhase) {
      this.phase.series = phS;
      this.phase.draw();
    }
  }
}
