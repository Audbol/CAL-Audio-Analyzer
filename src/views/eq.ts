import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, select, clear } from '../ui/dom';
import { allTargets, autoEq, byBand, eqResponse, findTarget, isBand, TARGETS, targetsVersion, type AutoEqResult, type PeqFilter } from '../dsp/eq';
import { showTargetEditor } from '../ui/target-editor';
import { EqBoard } from '../ui/eq-board';
import { EDIT_TARGETS } from './target-overlay';
import { smoothCurve } from '../dsp/freq';
import { interpLog } from '../dsp/target';
import { optionsMenu, optRow, optHead } from '../ui/popover';
import { showFirExport } from './fir-export';
import { CONSOLE_PROFILES, consoleText, fitToProfile, octaveFraction, profileById, qToOctaves, widthName, widthToQ, type ConsoleEqProfile } from '../dsp/console-eq';

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
  /** Older sessions don't have it. */
  rolloff?: { low: number | null; high: number | null };
  filters: PeqFilter[];
  summary: string;
  /** The console profile the filters were made for. */
  console?: string;
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
  /** Top: the response against the target, as measured and as predicted with the EQ. */
  private plot: Plot;
  /** Below: the EQ itself, with its numbered filters. */
  private eqPlot: Plot;
  private legend = h('div', { class: 'eq-legend', 'aria-hidden': 'true' });
  private source = 'live:0';
  private target = TARGETS[0].id;
  private opt = { fMin: 40, fMax: 12000, maxFilters: 8, maxBoost: 3, maxCut: 12, minCoherence: 0.6 };
  private result: AutoEqResult | null = null;
  /** The check after the EQ went in: a new measurement against the target, levelled like the prediction. */
  private verify: { name: string; dev: Float64Array } | null = null;
  private verifySource = '';
  private verifyHost = h('span', {});
  private verifyOut = h('div', { class: 'eq-verify-out small', 'aria-live': 'polite' });
  private verifyBox = h('div', { class: 'eq-verify', hidden: true });
  /** A high-pass where the target rolls off in the bass ('auto'), or never. */
  private hpfMode: 'auto' | 'off' = 'auto';
  private filters: PeqFilter[] = [];
  private freqs: Float64Array | number[] = [];
  private srcHost = h('span', {});
  private targetHost = h('span', {});
  private targetsSeen = -1;

  /** The target list: built-in and custom targets, and the custom target editor. */
  private renderTargets(): void {
    this.targetsSeen = targetsVersion();
    if (!findTarget(this.target)) this.target = TARGETS[0].id;
    this.targetHost.replaceChildren(
      select(
        [...allTargets().map((t) => ({ value: t.id, label: t.label, title: t.note })), { value: EDIT_TARGETS, label: 'Custom targets…', title: 'Make your own target curves, or edit them' }],
        this.target,
        (v) => {
          if (v !== EDIT_TARGETS) return void (this.target = v);
          this.renderTargets();
          showTargetEditor(this.app, (id) => {
            if (!id) return;
            this.target = id;
            this.renderTargets();
          }, this.target);
        },
        { dataset: { eqTarget: '' }, 'aria-label': 'Target' },
      ),
    );
  }
  private list = h('div', { class: 'peq-list' });
  private summary = h('div', { class: 'info-strip' });
  private dirty = true;
  private sourceName = '';
  /** The console the EQ is for (its bands and ranges limit the filters). */
  private profile: ConsoleEqProfile;
  private profileInfo = h('p', { class: 'peq-profile small' });
  private consoleSel!: HTMLSelectElement;

  constructor(private app: App) {
    // Start from the target chosen for the Spectrum / Transfer views, when it is a built-in one
    if (findTarget(app.settings.targetCurve)) this.target = app.settings.targetCurve;
    this.plot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -18, yMax: 12, yUnit: 'dB', yStep: 3, title: 'Response against the target (0 dB = on target)', showNote: true, yLimits: [-60, 60] });
    this.plot.placeholder = 'Choose a source and a target, then press Calculate EQ';
    this.eqPlot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -12, yMax: 6, yUnit: 'dB', yStep: 3, title: 'EQ filters (labelled as in the list)', yLimits: [-40, 30] });
    this.eqPlot.placeholder = 'The EQ curve appears here';
    this.profile = profileById(app.settings.eqConsole);
    this.limitOpts();
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
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Target'), this.targetHost),
        h(
          'div',
          { class: 'tb-group' },
          h('span', { class: 'tb-label' }, 'Console'),
          (this.consoleSel = select(
            CONSOLE_PROFILES.map((p) => ({ value: p.id, label: p.id === 'generic' ? p.name : `${p.name} – ${p.section}` })),
            this.profile.id,
            (v) => this.setProfile(v),
            { dataset: { eqConsole: '' }, title: 'The console the EQ is for: the suggestion uses only as many bands as its EQ has, within its gain and width ranges, and lists them the way it labels them' },
          )),
        ),
        optionsMenu(
          [
            optHead('Range'),
            optRow('Frequencies', numIn('fMin', '1', 'Lowest frequency (Hz)'), '–', numIn('fMax', '100', 'Highest frequency (Hz)'), h('span', { class: 'unit' }, 'Hz')),
            optHead('Filters'),
            optRow('Number of filters', numIn('maxFilters', '1')),
            optRow('Max boost', numIn('maxBoost', '0.5'), h('span', { class: 'unit' }, 'dB')),
            optRow('Max cut', numIn('maxCut', '0.5'), h('span', { class: 'unit' }, 'dB')),
            optRow(
              'High-pass',
              select(
                [
                  { value: 'auto' as const, label: 'Where the target rolls off' },
                  { value: 'off' as const, label: 'Never' },
                ],
                this.hpfMode,
                (v) => (this.hpfMode = v),
                { dataset: { eqHpf: '' }, title: 'Suggest a high-pass filter (it needs no EQ band) where the target itself rolls off in the bass, e.g. the speech target' },
              ),
            ),
          ],
          { title: 'EQ options: frequency range, number of filters, boost and cut limits', id: 'eq' },
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn accent', onclick: () => this.run() }, icon('sparkle', 15), 'Calculate EQ'),
      ),
      this.summary,
      h(
        'div',
        { class: 'eq-split' },
        h('div', { class: 'eq-plots' }, this.legend, h('div', { class: 'pane eq-main' }, this.plot.el), h('div', { class: 'pane eq-curve' }, this.eqPlot.el)), h('div', { class: 'peq-side' }, h('h4', {}, 'Parametric EQ'), this.profileInfo, this.list, h('div', { class: 'row gap4 wrap' }, ...this.copyBtns), this.verifyBox)),
    );
    this.verifyBox.append(
      h('h4', {}, icon('check', 14), ' Check the result'),
      h('p', { class: 'dim small' }, 'Enter the filters on the console, measure again at the same position (or average the same positions), then compare with the prediction.'),
      h(
        'div',
        { class: 'row gap4 wrap' },
        this.verifyHost,
        h('button', { class: 'btn small accent', dataset: { eqVerify: 'compare' }, onclick: () => this.runVerify() }, 'Compare'),
        h('button', { class: 'btn small ghost', dataset: { eqVerify: 'clear' }, onclick: () => { this.verify = null; this.verifyOut.replaceChildren(); this.dirty = true; } }, 'Clear'),
      ),
      this.verifyOut,
    );
    this.renderTargets();
    this.renderList();
    this.summary.textContent = 'Choose a source measurement and press Calculate EQ. Use a spatially averaged trace for best results.';
  }

  show(): void {
    if (this.targetsSeen !== targetsVersion()) this.renderTargets();
    const opts = [
      // By measurement id, so removing another measurement never moves the source to a different mic
      ...this.app.measurements.map((m) => ({ value: `live:${m.cfg.id}`, label: `Live: ${m.cfg.name}` })),
      ...this.app.traces.traces.filter((t) => t.kind !== 'rta').map((t) => ({ value: `trace:${t.id}`, label: `Trace: ${t.name}` })),
    ];
    if (!opts.length) opts.push({ value: 'live:', label: 'Live: (start audio)' });
    if (!opts.find((o) => o.value === this.source)) this.source = opts[0].value;
    this.srcHost.replaceChildren(select(opts, this.source, (v) => (this.source = v)));
    // Checking the result: the live measurement by default, or a new trace (an average of the same positions)
    if (!opts.find((o) => o.value === this.verifySource)) this.verifySource = (opts.find((o) => o.value.startsWith('live:')) ?? opts[0]).value;
    this.verifyHost.replaceChildren(select(opts, this.verifySource, (v) => (this.verifySource = v), { 'aria-label': 'Measurement to check', dataset: { eqVerify: 'source' } }));
    this.dirty = true;
  }

  private getSource(key = this.source): { freqs: ArrayLike<number>; mag: ArrayLike<number>; coh: ArrayLike<number> | null; name: string } | null {
    const [kind, id] = key.split(':');
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
    const target = findTarget(this.target) ?? TARGETS[0];
    // Work on a 1/6-octave smoothed copy — narrower features are rarely position-independent
    const lin = Array.from(src.mag, (v) => Math.pow(10, v / 20));
    const sm = smoothCurve(src.freqs, lin, 6);
    const magDb = Float64Array.from(sm, (v) => 20 * Math.log10(Math.max(v, 1e-9)));
    this.freqs = Array.from(src.freqs);
    this.verify = null;
    this.verifyOut.replaceChildren();
    const p = this.profile;
    this.result = autoEq(src.freqs, magDb, src.coh, target, { ...this.opt, maxFilters: Math.min(this.opt.maxFilters, p.bands), qMin: p.qMin, qMax: p.qMax, hpfSlopes: this.hpfMode === 'auto' ? p.hpf : [] });
    // As the console can set them: within its ranges, at the precision it shows
    this.filters = this.result.filters.map((f) => fitToProfile(f, p));
    this.sourceName = src.name;
    const ro = this.result.rolloff;
    const fmt = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);
    const ends = [ro.low ? `below ${fmt(ro.low)}` : '', ro.high ? `above ${fmt(ro.high)}` : ''].filter(Boolean).join(' and ');
    const rollText = ends ? ` The system rolls off ${ends}: left as it is (boosting a loudspeaker past its range only costs headroom).` : '';
    this.summary.innerHTML = this.filters.length
      ? `<b>${this.filters.length} filters</b> for “${src.name}” → ${target.label}${target.note ? ` (${target.note})` : ''}. RMS deviation ${this.result.rmsBefore.toFixed(1)} dB → <b>${this.result.rmsAfter.toFixed(1)} dB</b>.${rollText} Tip: verify with a new measurement, and prefer fixing large dips with placement/delay rather than boost.`
      : `The response is already within ±1 dB of the target in the selected range — no EQ needed.${rollText}`;
    this.renderList();
    this.dirty = true;
  }

  /**
   * Compare a new measurement (made with the EQ in place) with the prediction: both against the target, at the
   * same level, so what differs is what the EQ did differently from what was expected.
   */
  private runVerify(): void {
    const r = this.result;
    if (!r) return;
    const src = this.getSource(this.verifySource);
    if (!src) return this.app.toast('No data to check: start audio with the generator on, or pick a stored trace', 'warn');
    const target = findTarget(this.target) ?? TARGETS[0];
    const x = this.freqs;
    const sm = smoothCurve(src.freqs, Array.from(src.mag, (v) => Math.pow(10, v / 20)), 6);
    const fx = Array.from(src.freqs);
    const db = Array.from(sm, (v) => 20 * Math.log10(Math.max(v, 1e-9)));
    const eq = eqResponse(this.filters, x);
    const predicted = Float64Array.from(r.before, (v, i) => v + eq[i]);
    // Where both can be compared: the EQ's range, outside the roll-off
    const lo = Math.max(this.opt.fMin, r.rolloff.low ?? 0);
    const hi = Math.min(this.opt.fMax, r.rolloff.high ?? Infinity);
    const idx: number[] = [];
    for (let i = 0; i < x.length; i++) if (x[i] >= lo && x[i] <= hi && Number.isFinite(predicted[i])) idx.push(i);
    if (idx.length < 8) return this.app.toast('Not enough of the range to compare', 'warn');
    const raw = Float64Array.from(x, (f) => interpLog(fx, db, f) - target.at(f));
    // The same level as the prediction (median over the range)
    const median = (arr: number[]) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const shift = median(idx.map((i) => predicted[i])) - median(idx.map((i) => raw[i]));
    const dev = Float64Array.from(raw, (v) => v + shift);
    const rms = (arr: ArrayLike<number>) => Math.sqrt(idx.reduce((s, i) => s + arr[i] * arr[i], 0) / idx.length);
    let worst = idx[0];
    for (const i of idx) if (Math.abs(dev[i] - predicted[i]) > Math.abs(dev[worst] - predicted[worst])) worst = i;
    const diff = dev[worst] - predicted[worst];
    const fmt = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);
    this.verify = { name: src.name, dev };
    const measured = rms(dev);
    const before = rms(Float64Array.from(r.before));
    const good = Math.abs(diff) <= 2;
    this.verifyOut.replaceChildren(
      h('div', {}, `“${src.name}” with the EQ: `, h('b', {}, `±${measured.toFixed(1)} dB`), ` RMS from the target (predicted ±${rms(predicted).toFixed(1)} dB, before ±${before.toFixed(1)} dB).`),
      h(
        'div',
        { class: good ? 'ok-text' : 'warn-text' },
        good
          ? `Within 2 dB of the prediction everywhere (largest difference ${diff > 0 ? '+' : ''}${diff.toFixed(1)} dB at ${fmt(x[worst])}).`
          : `Largest difference from the prediction: ${diff > 0 ? '+' : ''}${diff.toFixed(1)} dB at ${fmt(x[worst])}. Check the filter near there on the console, and that the mic is where it was.`,
      ),
    );
    this.verifyOut.scrollIntoView({ block: 'nearest' });
    this.dirty = true;
  }

  /** The big-number window for entering the EQ on the console. */
  private board = new EqBoard();
  private boardInfo(): string {
    const t = findTarget(this.target);
    return [this.sourceName && `“${this.sourceName}”`, t && `→ ${t.label}`].filter(Boolean).join(' ');
  }
  openBoard(): void {
    if (!this.board.open(this.filters, this.profile, this.boardInfo())) this.app.toast('The window was blocked. Allow pop-ups for this app and try again.', 'warn');
  }

  /** Copy and export buttons: only useful once there are filters. */
  private copyBtns = [
    h('button', { class: 'btn small accent', dataset: { eqBoard: '' }, title: 'Every band in large type in its own window, to read from the console while entering it', onclick: () => this.openBoard() }, icon('popout', 13), 'EQ board'),
    h('button', { class: 'btn small', onclick: () => this.copy('text') }, 'Copy filter text'),
    h('button', { class: 'btn small', onclick: () => this.copy('csv') }, 'Copy CSV'),
    h('button', { class: 'btn small adv-only', dataset: { firExport: '' }, title: 'The EQ as an impulse response (WAV) for convolution in a DSP or player', onclick: () => showFirExport(this.app, this.filters, this.sourceName) }, icon('download', 13), 'Export FIR…'),
  ];

  private renderList(): void {
    clear(this.list);
    for (const b of this.copyBtns) b.disabled = !this.filters.length;
    if (!this.filters.length) {
      this.list.append(h('div', { class: 'empty' }, 'No filters yet: press Calculate EQ.'));
      return;
    }
    const p = this.profile;
    // In band order, as on the console (the high-pass first)
    this.filters.sort(byBand);
    const bands = this.filters.filter(isBand).length;
    if (bands > p.bands) this.list.append(h('div', { class: 'warn-text small' }, `${bands} filters, but this EQ has ${p.bands} bands: remove ${bands - p.bands}, or use an extra EQ (insert) for the rest.`));
    this.filters.forEach((f, i) => {
      if (f.type === 'highpass') return void this.list.append(this.hpfRow(f, i));
      const octaves = p.width === 'octaves';
      // Octave consoles: the width's unit, or its fraction of an octave where it is one (1/3, 1/6…)
      const unitText = () => (p.fractions && octaveFraction(qToOctaves(f.q))) || 'oct';
      const unit = h('span', { class: 'unit', title: 'Octaves (the fraction of an octave where it is one)' }, unitText());
      const inp = (key: 'f' | 'gain' | 'q', step: string) => {
        const shown = key === 'q' && octaves ? +qToOctaves(f.q).toFixed(2) : f[key];
        const el = h('input', { type: 'number', class: 'num', value: String(shown), step }) as HTMLInputElement;
        el.addEventListener('change', () => {
          const v = +el.value;
          if (!Number.isFinite(v) || v <= 0 && key !== 'gain') return;
          f[key] = key === 'q' ? widthToQ(v, p) : v;
          // Within the console's ranges
          Object.assign(f, fitToProfile(f, p));
          el.value = String(key === 'q' && octaves ? +qToOctaves(f.q).toFixed(2) : f[key]);
          unit.textContent = unitText();
          this.dirty = true;
        });
        return el;
      };
      this.list.append(
        h(
          'div',
          { class: 'peq' },
          h('span', { class: 'idx', title: p.bandNames[this.bandIndex(i)] ?? '' }, this.bandLabel(i)),
          h('label', {}, 'Fc', inp('f', '1')),
          h('label', {}, 'Gain', inp('gain', '0.1')),
          h(
            'label',
            { class: octaves ? 'peq-w' : '', title: octaves ? 'Width in octaves, as on the console' : 'Q, as on the console' },
            widthName(p),
            octaves ? h('span', { class: 'peq-width' }, inp('q', '0.01'), unit) : inp('q', '0.05'),
          ),
          h('button', { class: 'btn tiny ghost', title: 'Remove', onclick: () => { this.filters.splice(i, 1); this.renderList(); this.dirty = true; } }, icon('x', 12)),
        ),
      );
    });
  }

  private copy(fmt: 'text' | 'csv'): void {
    if (!this.filters.length) return;
    const text =
      fmt === 'text' && this.profile.id !== 'generic'
        ? consoleText(this.filters, this.profile)
        : fmt === 'text'
        ? this.filters.map((f, i) => (f.type === 'highpass' ? `Filter ${i + 1}: ON HP Fc ${f.f.toFixed(1)} Hz ${f.slope ?? 12} dB/oct` : `Filter ${i + 1}: ON PK Fc ${f.f.toFixed(1)} Hz Gain ${f.gain.toFixed(1)} dB Q ${f.q.toFixed(2)}`)).join('\n')
        : ['type,frequency_hz,gain_db,q,slope_db_oct', ...this.filters.map((f) => `${f.type},${f.f},${f.gain},${f.q},${f.type === 'highpass' ? (f.slope ?? 12) : ''}`)].join('\n');
    navigator.clipboard?.writeText(text).then(
      () => this.app.toast('Filters copied to clipboard', 'ok'),
      () => this.app.toast('Clipboard not available', 'warn'),
    );
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Which EQ band filter `i` is (the high-pass is not one). */
  private bandIndex(i: number): number {
    return this.filters.slice(0, i).filter(isBand).length;
  }

  /** A filter's label in the list and on the graph: the console's band name where it is short (LF, HM, L…), else its number; HP for the high-pass. */
  private bandLabel(i: number): string {
    if (this.filters[i] && !isBand(this.filters[i])) return 'HP';
    const b = this.bandIndex(i);
    const n = this.profile.bandNames[b];
    return n && n.length <= 3 ? n : String(b + 1);
  }

  /** The high-pass in the list: its frequency and slope (the slopes this console has). */
  private hpfRow(f: PeqFilter, i: number): HTMLElement {
    const p = this.profile;
    const fc = h('input', { type: 'number', class: 'num', value: String(f.f), step: '1', 'aria-label': 'High-pass frequency' }) as HTMLInputElement;
    fc.addEventListener('change', () => {
      const v = +fc.value;
      if (!Number.isFinite(v) || v <= 0) return void (fc.value = String(f.f));
      f.f = v;
      Object.assign(f, fitToProfile(f, p));
      fc.value = String(f.f);
      this.dirty = true;
    });
    const slopes = p.hpf.length ? p.hpf : [12];
    return h(
      'div',
      { class: 'peq peq-hp', dataset: { hpf: '' } },
      h('span', { class: 'idx', title: 'High-pass filter' }, 'HP'),
      h('label', {}, 'Fc', fc),
      h(
        'label',
        { class: 'peq-w', title: 'Slope, as the console offers it' },
        'Slope',
        select(slopes.map((s) => ({ value: s, label: `${s} dB/oct` })), f.slope ?? slopes[0], (v) => { f.slope = v; this.dirty = true; }, { 'aria-label': 'High-pass slope' }),
      ),
      h('button', { class: 'btn tiny ghost', title: 'Remove', onclick: () => { this.filters.splice(i, 1); this.renderList(); this.dirty = true; } }, icon('x', 12)),
    );
  }

  /** Choose the console: limits the options to its EQ and refits the current filters to its ranges. */
  setProfile(id: string): void {
    this.profile = profileById(id);
    this.app.settings.eqConsole = this.profile.id;
    this.app.save();
    this.limitOpts();
    this.filters = this.filters.map((f) => fitToProfile(f, this.profile));
    this.renderList();
    this.dirty = true;
  }

  /** The options within the console's EQ: as many filters as it has bands, boost and cut within its range. */
  private limitOpts(): void {
    const p = this.profile;
    this.opt.maxFilters = p.bands;
    this.opt.maxBoost = Math.min(this.opt.maxBoost, p.gainMax);
    this.opt.maxCut = Math.min(this.opt.maxCut, -p.gainMin);
    for (const k of ['maxFilters', 'maxBoost', 'maxCut'] as const) {
      const el = this.el.querySelector<HTMLInputElement>(`[data-eq-opt="${k}"]`);
      if (el) el.value = String(this.opt[k]);
    }
    const width = p.width === 'octaves' ? `width ${+qToOctaves(p.qMin).toFixed(2)} to ${+qToOctaves(p.qMax).toFixed(2)} octave` : `Q ${p.qMin}–${p.qMax}`;
    const gain = -p.gainMin === p.gainMax ? `±${p.gainMax} dB` : `${p.gainMin} to +${p.gainMax} dB`;
    this.profileInfo.replaceChildren(
      h('b', {}, p.id === 'generic' ? p.name : `${p.name}: ${p.section}`),
      h('br'),
      `${p.bands} bands, ${gain}, ${width}${p.hpf.length ? `, plus a high-pass (${p.hpf.join(', ')} dB/oct${p.id === 'generic' ? '' : ': check the slopes your console offers'})` : ''}. ${p.note} `,
      h('span', { class: p.source === 'documented' ? 'ok-text' : 'dim' }, p.source === 'documented' ? 'Ranges from the manufacturer’s documentation.' : 'Typical ranges: check them on your console.'),
    );
  }

  /** Add a filter from elsewhere (e.g. a notch from the feedback finder). */
  addFilter(f: PeqFilter): void {
    this.filters.push({ ...f });
    this.renderList();
    this.dirty = true;
  }

  /** The current EQ (for sessions and reports), or null before Calculate EQ. */
  snapshot(): EqSnapshot | null {
    const r = this.result;
    if (!r) return null;
    return {
      source: this.sourceName,
      target: this.target,
      targetLabel: findTarget(this.target)?.label ?? this.target,
      opt: { ...this.opt },
      freqs: Array.from(this.freqs),
      before: Array.from(r.before, (v) => (Number.isFinite(v) ? +v.toFixed(3) : null)),
      offset: r.offset,
      rmsBefore: r.rmsBefore,
      rmsAfter: r.rmsAfter,
      rolloff: r.rolloff,
      filters: this.filters.map((f) => ({ ...f })),
      console: this.profile.id,
      summary: this.summary.textContent ?? '',
    };
  }

  restore(snap: EqSnapshot | null): void {
    if (!snap) {
      this.result = null;
      this.filters = [];
      this.plot.series = [];
      this.plot.markers = [];
      this.eqPlot.series = [];
      this.eqPlot.pins = [];
      this.summary.textContent = 'Choose a source measurement and press Calculate EQ. Use a spatially averaged trace for best results.';
    } else {
      if (findTarget(snap.target)) this.target = snap.target;
      this.renderTargets();
      Object.assign(this.opt, snap.opt);
      this.freqs = snap.freqs;
      const before = Float64Array.from(snap.before, (v) => (v === null ? NaN : v));
      this.result = { filters: snap.filters, offset: snap.offset, before, after: before, rmsBefore: snap.rmsBefore, rmsAfter: snap.rmsAfter, rolloff: snap.rolloff ?? { low: null, high: null } };
      this.filters = snap.filters.map((f) => ({ ...f }));
      this.sourceName = snap.source;
      this.summary.textContent = snap.summary;
      if (snap.console) {
        this.profile = profileById(snap.console);
        this.consoleSel.value = this.profile.id;
        this.limitOpts();
      }
    }
    this.renderList();
    this.dirty = true;
  }

  /** The EQ graph's range: the filters' extremes with some room, at least −12…+6 dB. */
  private fitEqPlot(eq: ArrayLike<number>): void {
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < eq.length; i++) {
      lo = Math.min(lo, eq[i]);
      hi = Math.max(hi, eq[i]);
    }
    const yMin = Math.min(-12, Math.floor((lo - 3) / 3) * 3);
    const yMax = Math.max(6, Math.ceil((hi + 3) / 3) * 3);
    if (this.eqPlot.cfg.yMin !== yMin || this.eqPlot.cfg.yMax !== yMax) this.eqPlot.setDefaults({ yMin, yMax });
  }

  /** The EQ curve, filled towards 0 dB (cuts below, boosts above), with each filter numbered where it acts. */
  /** Outside the range, and the system's roll-off at its ends (not EQ'd), shaded. */
  private shades(): { x0: number; x1: number; color: string }[] {
    const ro = this.result?.rolloff;
    return [
      { x0: 20, x1: Math.max(this.opt.fMin, ro?.low ?? 0), color: CHART.shade },
      { x0: Math.min(this.opt.fMax, ro?.high ?? Infinity), x1: 20000, color: CHART.shade },
    ];
  }

  private drawEq(x: ArrayLike<number>): void {
    const eq = eqResponse(this.filters, x);
    this.fitEqPlot(eq);
    const zero = new Float64Array(x.length);
    this.eqPlot.series = [
      { id: 'eq-fill', label: '', x, y: eq, band: zero, color: CHART.warn, quiet: true },
      { id: 'eq', label: 'EQ', x, y: eq, color: CHART.warn, width: 2 },
    ];
    // A numbered point on the curve at each filter, instead of a line across the whole graph
    this.eqPlot.pins = this.filters.map((f, i) => ({ x: f.f, y: eqResponse(this.filters, [f.f])[0], label: this.bandLabel(i), color: CHART.warn }));
    this.eqPlot.shades = this.result ? this.shades() : [];
    this.eqPlot.draw();
  }

  /** Legend above the graphs: a line sample per curve, or a shaded swatch for the tolerance band. */
  private renderLegend(items: { label: string; color?: string; dash?: boolean; width?: number; band?: boolean }[]): void {
    this.legend.replaceChildren(
      ...items.map((it) =>
        h(
          'span',
          { class: `eq-legend-item${it.band ? ' tol' : ''}` },
          h('i', { style: it.band ? '' : `border-top: ${it.width ?? 2}px ${it.dash ? 'dashed' : 'solid'} ${it.color}` }),
          it.label,
        ),
      ),
    );
  }

  tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const r = this.result;
    this.verifyBox.hidden = !r;
    this.board.update(this.filters, this.profile, this.boardInfo());
    const day = CHART.bg === '#ffffff';
    if (r) {
      const x = this.freqs;
      const eq = eqResponse(this.filters, x);
      const after = Float64Array.from(r.before, (v, i) => v + eq[i]);
      const band = (arr: ArrayLike<number>) => Float64Array.from(arr, (v, i) => (x[i] < this.opt.fMin || x[i] > this.opt.fMax ? NaN : v));
      const ok = Float64Array.from(x, () => 3);
      this.plot.series = [
        // ±3 dB around the target: where the result should end up
        { id: 'tol', label: '', x, y: ok, band: ok.map((v) => -v), color: CHART.accent, quiet: true },
        { id: 'before', label: 'As measured', x, y: r.before, color: CHART.neutral, width: 1.3, dash: [5, 3] },
        { id: 'after', label: 'With EQ (predicted)', x, y: band(after), color: CHART.accent, width: 2.4, halo: day ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)' },
        ...(this.verify ? [{ id: 'verify', label: 'With EQ (measured)', x, y: band(this.verify.dev), color: day ? '#0a7d3b' : '#3ddc84', width: 2, halo: day ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)' }] : []),
      ];
      this.plot.markers = [];
      this.plot.shades = this.shades();
      this.drawEq(x);
      this.renderLegend([
        { label: 'As measured', color: CHART.neutral, dash: true, width: 2 },
        { label: 'With EQ (predicted)', color: CHART.accent, width: 3 },
        ...(this.verify ? [{ label: 'With EQ (measured)', color: day ? '#0a7d3b' : '#3ddc84', width: 3 }] : []),
        { label: '±3 dB of the target', band: true },
        { label: 'EQ (below)', color: CHART.warn, width: 2 },
      ]);
    } else if (this.filters.length) {
      // Filters without a calculated EQ (e.g. notches from the feedback finder): their curve alone
      this.plot.series = [];
      this.drawEq(this.app.grid);
      this.renderLegend([{ label: 'EQ (below)', color: CHART.warn, width: 2 }]);
    } else {
      this.eqPlot.series = [];
      this.eqPlot.pins = [];
      this.eqPlot.draw();
      this.legend.replaceChildren();
    }
    this.plot.draw();
  }

}
