import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import { Dock, type DockLayout, type DockPanel } from '../ui/dock';
import { SMOOTHING_OPTIONS, type Smoothing } from '../dsp/freq';
import type { Averaging } from '../dsp/transfer';
import type { Settings } from '../state';

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

type PanelId = 'rta' | 'mag' | 'phase' | 'spl' | 'levels';

const PANEL_TITLES: Record<PanelId, string> = {
  rta: 'Spectrum (RTA)',
  mag: 'Transfer function · magnitude',
  phase: 'Transfer function · phase',
  spl: 'SPL meter',
  levels: 'Input levels',
};

/** Default arrangement: graphs stacked, the two meters floating at the bottom right. */
export function defaultLiveLayout(s?: Partial<Settings>): DockLayout {
  const hidden: string[] = [];
  if (s?.showRta === false) hidden.push('rta');
  if (s?.showMag === false) hidden.push('mag');
  if (s?.showPhase === false) hidden.push('phase');
  return {
    order: ['rta', 'mag', 'phase', 'spl', 'levels'],
    sizes: { rta: 1, mag: 1.5, phase: 1, spl: 0.6, levels: 0.8 },
    hidden,
    floating: {
      levels: { x: -14, y: -40, w: 250, h: 190 },
      spl: { x: -276, y: -40, w: 230, h: 150 },
    },
  };
}

const METER_FLOOR = -60;

/**
 * The main dual-channel view. Every display (RTA, magnitude + coherence, phase, SPL meter, input levels) is a
 * panel in a dock: drag title bars to rearrange, drag splitters to resize, float panels over the view, or
 * detach them into their own windows.
 */
export class LiveView implements View {
  id = 'live' as const;
  title = 'Live';
  icon = 'wave' as const;
  el = h('div', { class: 'live' });
  private rta: Plot;
  private mag: Plot;
  private phase: Plot;
  private dock: Dock;
  private chips = new Map<PanelId, HTMLButtonElement>();
  private alphas = new Map<string, Float64Array>();
  private splEl = h('div', { class: 'spl-panel' });
  private levelsEl = h('div', { class: 'levels-panel' });
  private holds: { v: number; t: number }[] = [];
  private splTick = 0;

  constructor(private app: App) {
    const s = app.settings;
    this.rta = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.rtaRange[0], yMax: s.rtaRange[1], yUnit: 'dBFS', yStep: 10, showNote: true, yLimits: [-200, 160] });
    this.mag = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: s.magRange[0], yMax: s.magRange[1], yUnit: 'dB', yStep: 6, secondaryLabel: 'Coherence', showNote: true, yLimits: [-120, 120] });
    this.phase = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -180, yMax: 180, yUnit: 'deg', yStep: 45, yLimits: [-540, 540] });
    this.mag.onRangeChange = (a, b) => {
      s.magRange = [a, b];
      app.save();
    };
    this.rta.onRangeChange = (a, b) => {
      s.rtaRange = [a, b];
      app.save();
    };
    const plotPanel = (id: PanelId, plot: Plot): DockPanel => ({
      id,
      title: PANEL_TITLES[id],
      body: h('div', { class: 'pane-fill' }, plot.el),
      onResize: () => plot.resize(),
    });
    const panels: DockPanel[] = [
      plotPanel('rta', this.rta),
      plotPanel('mag', this.mag),
      plotPanel('phase', this.phase),
      { id: 'spl', title: PANEL_TITLES.spl, body: this.splEl },
      { id: 'levels', title: PANEL_TITLES.levels, body: this.levelsEl },
    ];
    if (!s.liveLayout) s.liveLayout = defaultLiveLayout(s);
    this.dock = new Dock(
      panels,
      s.liveLayout,
      (layout) => {
        s.liveLayout = layout;
        app.save();
        this.syncChips();
      },
      (msg) => app.toast(msg, 'warn'),
    );
    this.el.append(this.toolbar(), this.dock.el);
    this.syncChips();
  }

  private toolbar(): HTMLElement {
    const s = this.app.settings;
    const app = this.app;
    const toggle = (key: 'showCoherence' | 'peakHold', label: string, title: string) => {
      const b = h('button', { class: `chip${s[key] ? ' on' : ''}`, title }, label);
      b.addEventListener('click', () => {
        s[key] = !s[key];
        b.classList.toggle('on', s[key]);
        app.save();
      });
      return b;
    };
    const panelChip = (id: PanelId, label: string) => {
      const b = h('button', { class: 'chip', title: `Show / hide the ${PANEL_TITLES[id]} panel` }, label);
      b.addEventListener('click', () => this.dock.setVisible(id, !this.dock.isVisible(id)));
      this.chips.set(id, b);
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
      h('div', { class: 'tb-group' }, panelChip('rta', 'RTA'), panelChip('mag', 'Magnitude'), panelChip('phase', 'Phase'), panelChip('spl', 'SPL'), panelChip('levels', 'Levels')),
      h('div', { class: 'tb-group' }, toggle('showCoherence', 'Coherence', 'Show coherence trace on the magnitude plot')),
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
      h('button', { class: 'btn small ghost', title: 'Restore the default panel arrangement', onclick: () => this.dock.reset(defaultLiveLayout()) }, icon('layout', 14), 'Reset layout'),
      h('button', { class: 'btn small', title: 'Reset all averages (R)', onclick: () => app.resetAverages() }, icon('reset', 14), 'Reset'),
    );
  }

  private syncChips(): void {
    for (const [id, b] of this.chips) b.classList.toggle('on', this.dock.isVisible(id));
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
    const show = (id: PanelId) => this.dock.isVisible(id);
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
    if (show('rta')) {
      this.rta.cfg.yUnit = s.splCalibrated ? 'dB SPL' : 'dBFS';
      this.rta.series = rtaS;
      if (s.splCalibrated) for (const x of rtaS) if (!app.traces.traces.find((t) => t.id === x.id)) x.y = Array.from(x.y as Float64Array, (v) => v + s.splOffset);
      this.rta.draw();
    }
    if (show('mag')) {
      this.mag.series = magS;
      this.mag.draw();
    }
    if (show('phase')) {
      this.phase.series = phS;
      this.phase.draw();
    }
    // Numeric meters don't need 60 fps
    if (this.splTick++ % 3 === 0) {
      if (show('spl')) this.renderSpl();
      if (show('levels')) this.renderLevels();
    }
  }

  private renderSpl(): void {
    const s = this.app.settings;
    const r = this.app.splReading;
    const run = this.app.engine.running && r;
    const unit = s.splCalibrated ? `dB(${s.splWeighting})` : `dBFS(${s.splWeighting})`;
    const f = (v: number | undefined) => (run && v !== undefined && Number.isFinite(v) ? v.toFixed(1) : '—');
    this.splEl.innerHTML =
      `<div class="spl-val">${f(r?.level)}</div>` +
      `<div class="spl-unit">${unit} · ${s.splTime === 'fast' ? 'Fast' : 'Slow'}${s.splCalibrated ? '' : ' · <span class="warn-text">uncal.</span>'}</div>` +
      `<div class="spl-row"><span>L<sub>eq</sub> <b>${f(r?.leq)}</b></span><span>L<sub>max</sub> <b>${f(r?.max)}</b></span><span>Pk <b>${f(r?.peakHold)}</b></span></div>`;
  }

  private renderLevels(): void {
    const e = this.app.engine;
    const chans = [...e.levels.map((l, i) => ({ l, label: `In ${i + 1}`, gen: false })), { l: e.genLevel, label: 'Gen', gen: true }];
    if (this.levelsEl.childElementCount !== chans.length + 1) {
      this.levelsEl.replaceChildren(
        h('div', { class: 'lv-scale' }, ...[0, -6, -12, -24, -36, -48, -60].map((d) => h('span', { style: `bottom:${this.pct(d)}%` }, String(d)))),
        ...chans.map((c, i) =>
          h(
            'div',
            { class: `lv-col${c.gen ? ' gen' : ''}`, title: c.gen ? 'Generator output' : `Input ${i + 1} · click to reset clip / hold`, onclick: () => {
              // Look the level up at click time: the engine replaces its level objects when restarted
              const lvl = c.gen ? e.genLevel : e.levels[i];
              if (lvl) lvl.clipped = false;
              this.holds[i] = { v: -Infinity, t: 0 };
            } },
            h('div', { class: 'lv-clip' }, 'CLIP'),
            h('div', { class: 'lv-bar' }, h('i', { class: 'lv-rms' }), h('i', { class: 'lv-peak' }), h('i', { class: 'lv-hold' })),
            h('div', { class: 'lv-val' }, '—'),
            h('div', { class: 'lv-label' }, c.label),
          ),
        ),
      );
    }
    const now = performance.now();
    chans.forEach((c, i) => {
      const col = this.levelsEl.children[i + 1] as HTMLElement;
      const pk = 20 * Math.log10(Math.max(c.l.peak, 1e-6));
      const rms = 20 * Math.log10(Math.max(c.l.rms, 1e-6)) + 3.01;
      const hold = (this.holds[i] ??= { v: -Infinity, t: 0 });
      if (pk >= hold.v || now - hold.t > 2000) {
        hold.v = pk;
        hold.t = now;
      }
      (col.querySelector('.lv-rms') as HTMLElement).style.height = `${this.pct(rms)}%`;
      (col.querySelector('.lv-peak') as HTMLElement).style.height = `${this.pct(pk)}%`;
      (col.querySelector('.lv-hold') as HTMLElement).style.bottom = `${this.pct(hold.v)}%`;
      (col.querySelector('.lv-val') as HTMLElement).textContent = e.running && hold.v > -99 ? hold.v.toFixed(1) : '—';
      col.classList.toggle('clip', c.l.clipped);
      col.classList.toggle('hot', pk > -6);
    });
  }

  private pct(db: number): number {
    return Math.max(0, Math.min(100, ((db - METER_FLOOR) / -METER_FLOOR) * 100));
  }
}
