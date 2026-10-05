import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, select, clear } from '../ui/dom';
import { autoEq, eqResponse, TARGETS, type AutoEqResult, type PeqFilter } from '../dsp/eq';
import { smoothCurve } from '../dsp/freq';
import { optionsMenu, optRow, optHead } from '../ui/popover';

export interface EqSnapshot {
  source: string;
  target: string;
  targetLabel: string;
  opt: { fMin: number; fMax: number; maxFilters: number; maxBoost: number; maxCut: number; minCoherence: number };
  freqs: number[];
  before: (number | null)[];
  offset: number;
  rmsBefore: number;
  rmsAfter: number;
  filters: PeqFilter[];
  summary: string;
}

/**
 * EQ Assistant: fits parametric EQ filters to bring a measurement (live or stored trace) to a target curve.
 * Cuts are preferred and boosts limited, and low-coherence regions are ignored, following good practice for
 * system tuning. Filters can be edited and exported to common formats.
 */
export class EqView implements View {
  id = 'eq' as const;
  readonly needs = { tf: true };
  title = 'EQ';
  icon = 'sliders' as const;
  el = h('div', { class: 'eq' });
  private plot: Plot;
  private source = 'live:0';
  private target = TARGETS[0].id;
  private opt = { fMin: 40, fMax: 12000, maxFilters: 8, maxBoost: 3, maxCut: 12, minCoherence: 0.6 };
  private result: AutoEqResult | null = null;
  private filters: PeqFilter[] = [];
  private freqs: Float64Array | number[] = [];
  private srcHost = h('span', {});
  private list = h('div', { class: 'peq-list' });
  private summary = h('div', { class: 'info-strip' });
  private dirty = true;
  private sourceName = '';

  constructor(private app: App) {
    // Start from the target chosen for the Spectrum / Transfer views, when it is a built-in one
    if (TARGETS.some((t) => t.id === app.settings.targetCurve)) this.target = app.settings.targetCurve;
    this.plot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -18, yMax: 18, yUnit: 'dB', yStep: 3, title: 'Deviation from target, EQ and predicted result', showNote: true, yLimits: [-60, 60] });
    this.plot.placeholder = 'Choose a source and a target, then press Calculate EQ';
    const numIn = (key: keyof typeof this.opt, step: string, label?: string) => {
      const i = h('input', { type: 'number', class: 'num', value: String(this.opt[key]), step, dataset: { eqOpt: key }, 'aria-label': label });
      i.addEventListener('change', () => ((this.opt[key] as number) = +i.value));
      return i;
    };
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Source'), this.srcHost),
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Target'), select(TARGETS.map((t) => ({ value: t.id, label: t.label })), this.target, (v) => { this.target = v; })),
        optionsMenu(
          [
            optHead('Range'),
            optRow('Frequencies', numIn('fMin', '1', 'Lowest frequency (Hz)'), '–', numIn('fMax', '100', 'Highest frequency (Hz)'), h('span', { class: 'unit' }, 'Hz')),
            optHead('Filters'),
            optRow('Number of filters', numIn('maxFilters', '1')),
            optRow('Max boost', numIn('maxBoost', '0.5'), h('span', { class: 'unit' }, 'dB')),
            optRow('Max cut', numIn('maxCut', '0.5'), h('span', { class: 'unit' }, 'dB')),
          ],
          { title: 'EQ options: frequency range, number of filters, boost and cut limits', id: 'eq' },
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn accent', onclick: () => this.run() }, icon('sparkle', 15), 'Calculate EQ'),
      ),
      this.summary,
      h('div', { class: 'eq-split' }, h('div', { class: 'pane fill' }, this.plot.el), h('div', { class: 'peq-side' }, h('h4', {}, 'Parametric EQ'), this.list, h('div', { class: 'row gap4' }, this.copyBtns[0], this.copyBtns[1]))),
    );
    this.renderList();
    this.summary.textContent = 'Choose a source measurement and press Calculate EQ. Use a spatially averaged trace for best results.';
  }

  show(): void {
    const opts = [
      // By measurement id, so removing another measurement never moves the source to a different mic
      ...this.app.measurements.map((m) => ({ value: `live:${m.cfg.id}`, label: `Live: ${m.cfg.name}` })),
      ...this.app.traces.traces.filter((t) => t.kind !== 'rta').map((t) => ({ value: `trace:${t.id}`, label: `Trace: ${t.name}` })),
    ];
    if (!opts.length) opts.push({ value: 'live:', label: 'Live: (start audio)' });
    if (!opts.find((o) => o.value === this.source)) this.source = opts[0].value;
    this.srcHost.replaceChildren(select(opts, this.source, (v) => (this.source = v)));
    this.dirty = true;
  }

  private getSource(): { freqs: ArrayLike<number>; mag: ArrayLike<number>; coh: ArrayLike<number> | null; name: string } | null {
    const [kind, id] = this.source.split(':');
    if (kind === 'live') {
      const m = this.app.measurements.find((x) => x.cfg.id === id);
      if (!m || !m.tfReady) return null;
      return { freqs: this.app.grid, mag: m.mag, coh: m.result.coh, name: m.cfg.name };
    }
    const t = this.app.traces.traces.find((x) => x.id === id);
    if (!t) return null;
    return { freqs: t.freqs, mag: t.mag.map((v) => v + t.offset), coh: t.coh ?? null, name: t.name };
  }

  private run(): void {
    const src = this.getSource();
    if (!src) return this.app.toast('No data: start audio with the generator on, or pick a stored trace', 'warn');
    const target = TARGETS.find((t) => t.id === this.target)!;
    // Work on a 1/6-octave smoothed copy — narrower features are rarely position-independent
    const lin = Array.from(src.mag, (v) => Math.pow(10, v / 20));
    const sm = smoothCurve(src.freqs, lin, 6);
    const magDb = Float64Array.from(sm, (v) => 20 * Math.log10(Math.max(v, 1e-9)));
    this.freqs = Array.from(src.freqs);
    this.result = autoEq(src.freqs, magDb, src.coh, target, this.opt);
    this.filters = this.result.filters.map((f) => ({ ...f }));
    this.sourceName = src.name;
    this.summary.innerHTML = this.filters.length
      ? `<b>${this.filters.length} filters</b> for “${src.name}” → ${target.label}. RMS deviation ${this.result.rmsBefore.toFixed(1)} dB → <b>${this.result.rmsAfter.toFixed(1)} dB</b>. Tip: verify with a new measurement, and prefer fixing large dips with placement/delay rather than boost.`
      : 'The response is already within ±1 dB of the target in the selected range — no EQ needed.';
    this.renderList();
    this.dirty = true;
  }

  /** Copy buttons: only useful once there are filters. */
  private copyBtns = [h('button', { class: 'btn small', onclick: () => this.copy('text') }, 'Copy filter text'), h('button', { class: 'btn small', onclick: () => this.copy('csv') }, 'Copy CSV')];

  private renderList(): void {
    clear(this.list);
    for (const b of this.copyBtns) b.disabled = !this.filters.length;
    if (!this.filters.length) {
      this.list.append(h('div', { class: 'empty' }, 'No filters yet: press Calculate EQ.'));
      return;
    }
    this.filters.forEach((f, i) => {
      const inp = (key: 'f' | 'gain' | 'q', step: string) => {
        const el = h('input', { type: 'number', class: 'num', value: String(f[key]), step });
        el.addEventListener('change', () => {
          f[key] = +el.value;
          this.dirty = true;
        });
        return el;
      };
      this.list.append(
        h(
          'div',
          { class: 'peq' },
          h('span', { class: 'idx' }, String(i + 1)),
          h('label', {}, 'Fc', inp('f', '1')),
          h('label', {}, 'Gain', inp('gain', '0.1')),
          h('label', {}, 'Q', inp('q', '0.05')),
          h('button', { class: 'btn tiny ghost', title: 'Remove', onclick: () => { this.filters.splice(i, 1); this.renderList(); this.dirty = true; } }, icon('x', 12)),
        ),
      );
    });
  }

  private copy(fmt: 'text' | 'csv'): void {
    if (!this.filters.length) return;
    const text =
      fmt === 'text'
        ? this.filters.map((f, i) => `Filter ${i + 1}: ON PK Fc ${f.f.toFixed(1)} Hz Gain ${f.gain.toFixed(1)} dB Q ${f.q.toFixed(2)}`).join('\n')
        : ['type,frequency_hz,gain_db,q', ...this.filters.map((f) => `${f.type},${f.f},${f.gain},${f.q}`)].join('\n');
    navigator.clipboard?.writeText(text).then(
      () => this.app.toast('Filters copied to clipboard', 'ok'),
      () => this.app.toast('Clipboard not available', 'warn'),
    );
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** The current EQ (for sessions and reports), or null before Calculate EQ. */
  snapshot(): EqSnapshot | null {
    const r = this.result;
    if (!r) return null;
    return {
      source: this.sourceName,
      target: this.target,
      targetLabel: TARGETS.find((t) => t.id === this.target)?.label ?? this.target,
      opt: { ...this.opt },
      freqs: Array.from(this.freqs),
      before: Array.from(r.before, (v) => (Number.isFinite(v) ? +v.toFixed(3) : null)),
      offset: r.offset,
      rmsBefore: r.rmsBefore,
      rmsAfter: r.rmsAfter,
      filters: this.filters.map((f) => ({ ...f })),
      summary: this.summary.textContent ?? '',
    };
  }

  restore(snap: EqSnapshot | null): void {
    if (!snap) {
      this.result = null;
      this.filters = [];
      this.plot.series = [];
      this.plot.markers = [];
      this.summary.textContent = 'Choose a source measurement and press Calculate EQ. Use a spatially averaged trace for best results.';
    } else {
      if (TARGETS.some((t) => t.id === snap.target)) this.target = snap.target;
      Object.assign(this.opt, snap.opt);
      this.freqs = snap.freqs;
      const before = Float64Array.from(snap.before, (v) => (v === null ? NaN : v));
      this.result = { filters: snap.filters, offset: snap.offset, before, after: before, rmsBefore: snap.rmsBefore, rmsAfter: snap.rmsAfter };
      this.filters = snap.filters.map((f) => ({ ...f }));
      this.sourceName = snap.source;
      this.summary.textContent = snap.summary;
    }
    this.renderList();
    this.dirty = true;
  }

  tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const r = this.result;
    if (r) {
      const x = this.freqs;
      const eq = eqResponse(this.filters, x);
      const after = Float64Array.from(r.before, (v, i) => v + eq[i]);
      const band = (arr: ArrayLike<number>) => Float64Array.from(arr, (v, i) => (x[i] < this.opt.fMin || x[i] > this.opt.fMax ? NaN : v));
      this.plot.series = [
        { id: 'before', label: 'Measured − target', x, y: r.before, color: CHART.neutral, width: 1.4 },
        { id: 'eq', label: 'EQ curve', x, y: eq, color: CHART.warn, width: 2 },
        { id: 'after', label: 'Predicted result', x, y: band(after), color: CHART.accent, width: 2 },
      ];
      this.plot.markers = this.filters.map((f, i) => ({ x: f.f, color: CHART.warnSoft, label: `${i + 1}` }));
      this.plot.shades = [
        { x0: 20, x1: this.opt.fMin, color: CHART.shade },
        { x0: this.opt.fMax, x1: 20000, color: CHART.shade },
      ];
    }
    this.plot.draw();
  }
}
