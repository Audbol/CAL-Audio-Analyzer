import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import { alignSubMain, type AlignInput, type AlignResult } from '../dsp/align';
import { speedOfSound } from '../dsp/delay';

const MAIN_COLOR = '#4da3ff';
const SUB_COLOR = '#ff6b6b';
const BEFORE_COLOR = '#9aa4b2';
const AFTER_COLOR = '#3ddc84';

type Part = 'main' | 'sub';

type Arr = (number | null)[];
export interface AlignSnapshot {
  names: { main: string; sub: string };
  delayMs: number;
  polarity: 1 | -1;
  region: [number, number];
  crossover: number;
  before: number;
  after: number;
  gainDb: number;
  cancellations: number[];
  freqs: number[];
  mainDb: Arr;
  subDb: Arr;
  sumBeforeDb: Arr;
  sumAfterDb: Arr;
  mainPhase: Arr;
  subPhase: Arr;
}

/**
 * Sub / main alignment assistant: measure the mains alone and the sub alone (same mic position, same
 * reference), and it finds the delay and polarity for the sub that make the two add up best through the
 * crossover, with the predicted sum before and after.
 */
export class AlignView implements View {
  id = 'align' as const;
  readonly needs = { tf: true };
  title = 'Align';
  icon = 'target' as const;
  el = h('div', { class: 'align' });
  private mag: Plot;
  private phase: Plot;
  private sources: Record<Part, string> = { main: '', sub: '' };
  private srcHost: Record<Part, HTMLElement> = { main: h('span', {}), sub: h('span', {}) };
  private rangeMs = 20;
  private regionMode: 'auto' | 'manual' = 'auto';
  private region: [number, number] = [60, 150];
  private summary = h('div', { class: 'info-strip' });
  private cards = h('div', { class: 'cards' });
  private tracesVersion = -1;
  private dirty = true;
  /** The last alignment (for sessions and reports). */
  result: AlignResult | null = null;
  resultNames: { main: string; sub: string } | null = null;

  constructor(private app: App) {
    this.mag = new Plot({ xType: 'log', xMin: 20, xMax: 1000, yMin: -30, yMax: 12, yUnit: 'dB', yStep: 6, title: 'Magnitude: mains, sub and their predicted sum', showNote: true, yLimits: [-120, 120] });
    this.phase = new Plot({ xType: 'log', xMin: 20, xMax: 1000, yMin: -180, yMax: 180, yUnit: 'deg', yStep: 45, title: 'Phase: mains and aligned sub (they should track through the crossover)', yLimits: [-540, 540] });
    const num = (value: number, step: string, onChange: (v: number) => void, attrs: Record<string, string> = {}) => {
      const i = h('input', { type: 'number', class: 'num', value: String(value), step, ...attrs });
      i.addEventListener('change', () => onChange(+i.value));
      return i;
    };
    const manual = h('span', { class: 'align-manual' },
      num(this.region[0], '1', (v) => (this.region[0] = v), { 'aria-label': 'Region from (Hz)' }),
      h('span', { class: 'unit' }, '–'),
      num(this.region[1], '1', (v) => (this.region[1] = v), { 'aria-label': 'Region to (Hz)' }),
      h('span', { class: 'unit' }, 'Hz'),
    );
    manual.style.display = 'none';
    this.el.append(
      h(
        'div',
        { class: 'toolbar wrap' },
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Mains'), this.srcHost.main, h('button', { class: 'btn small', title: 'Store the live transfer function as the mains measurement', onclick: () => this.capture('main') }, icon('camera', 14), 'Capture mains')),
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Sub'), this.srcHost.sub, h('button', { class: 'btn small', title: 'Store the live transfer function as the sub measurement', onclick: () => this.capture('sub') }, icon('camera', 14), 'Capture sub')),
        h(
          'div',
          { class: 'tb-group' },
          h('span', { class: 'tb-label' }, 'Region'),
          select(
            [
              { value: 'auto' as const, label: 'Automatic' },
              { value: 'manual' as const, label: 'Manual' },
            ],
            this.regionMode,
            (v) => {
              this.regionMode = v;
              manual.style.display = v === 'manual' ? '' : 'none';
            },
            { title: 'Crossover region to optimise (automatic: where the two are within 10 dB of each other)' },
          ),
          manual,
          h('span', { class: 'tb-label' }, 'Range ±'),
          num(this.rangeMs, '1', (v) => (this.rangeMs = Math.min(50, Math.max(1, v || 20))), { min: '1', max: '50', title: 'Delay search range' }),
          h('span', { class: 'unit' }, 'ms'),
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', title: 'Store the predicted aligned sum as a trace', onclick: () => this.saveSum() }, icon('download', 14), 'Save sum'),
        h('button', { class: 'btn accent', onclick: () => this.run() }, icon('sparkle', 15), 'Calculate alignment'),
      ),
      this.summary,
      this.cards,
      h('div', { class: 'panes align-panes' }, h('div', { class: 'pane big' }, this.mag.el), h('div', { class: 'pane' }, this.phase.el)),
    );
    this.summary.innerHTML =
      'Measure at the same mic position with the same reference: <b>mains alone</b> (sub muted) and capture, then <b>sub alone</b> (mains muted) and capture, then press Calculate alignment. Leave the measurement delay as found for the mains; both captures remember it.';
  }

  show(): void {
    this.renderSources();
    this.dirty = true;
  }

  /** Transfer-function choices: live measurements and stored transfer functions with phase. */
  private renderSources(): void {
    const app = this.app;
    this.tracesVersion = app.traces.version;
    const opts = [
      ...app.measurements.map((m) => ({ value: `live:${m.cfg.id}`, label: `Live: ${m.cfg.name}` })),
      ...app.traces.traces.filter((t) => t.kind !== 'rta' && t.phase).map((t) => ({ value: `trace:${t.id}`, label: `Trace: ${t.name}` })),
    ];
    if (!opts.length) opts.push({ value: '', label: '(capture a transfer function)' });
    for (const part of ['main', 'sub'] as const) {
      if (!opts.some((o) => o.value === this.sources[part])) {
        // Default: the newest trace named after the part, else the first trace, else live
        const named = [...app.traces.traces].reverse().find((t) => t.phase && new RegExp(part === 'main' ? '^main' : '^sub', 'i').test(t.name));
        this.sources[part] = named ? `trace:${named.id}` : opts[0].value;
      }
      this.srcHost[part].replaceChildren(select(opts, this.sources[part], (v) => (this.sources[part] = v), { dataset: { align: part } }));
    }
  }

  private capture(part: Part): void {
    const app = this.app;
    const cur = this.sources[part];
    const m = (cur.startsWith('live:') && app.measurements.find((x) => `live:${x.cfg.id}` === cur)) || app.measurements.find((x) => x.cfg.enabled) || app.measurements[0];
    if (!m) return app.toast('Add a measurement first.', 'warn');
    const t = app.captureTrace(m, 'tf');
    if (!t) return;
    app.traces.update(t.id, { name: `${part === 'main' ? 'Mains' : 'Sub'} ${t.name.slice(m.cfg.name.length + 1)}`, color: part === 'main' ? MAIN_COLOR : SUB_COLOR });
    this.sources[part] = `trace:${t.id}`;
    this.renderSources();
  }

  private input(part: Part): (AlignInput & { name: string }) | null {
    const app = this.app;
    const [kind, id] = [this.sources[part].slice(0, this.sources[part].indexOf(':')), this.sources[part].slice(this.sources[part].indexOf(':') + 1)];
    if (kind === 'live') {
      const m = app.measurements.find((x) => x.cfg.id === id);
      if (!m || !m.tfReady) return null;
      return { name: m.cfg.name, freqs: app.grid, mag: m.mag, phase: m.phase, coh: m.result.coh, delayMs: (m.cfg.delay / m.fs) * 1000 };
    }
    const t = app.traces.traces.find((x) => x.id === id);
    if (!t || !t.phase) return null;
    return { name: t.name, freqs: t.freqs, mag: t.offset ? t.mag.map((v) => v + t.offset) : t.mag, phase: t.phase, coh: t.coh ?? null, delayMs: t.delayMs ?? 0 };
  }

  run(): void {
    const app = this.app;
    const main = this.input('main');
    const sub = this.input('sub');
    if (!main || !sub) return app.toast('Choose a mains and a sub measurement (capture them, or start audio for a live one).', 'warn');
    if (this.sources.main === this.sources.sub) return app.toast('Mains and sub are the same measurement: capture each one on its own.', 'warn');
    try {
      const region = this.regionMode === 'manual' ? ([Math.min(...this.region), Math.max(...this.region)] as [number, number]) : null;
      this.result = alignSubMain(main, sub, { rangeMs: this.rangeMs, region });
      this.resultNames = { main: main.name, sub: sub.name };
    } catch (e) {
      this.result = null;
      this.resultNames = null;
      this.cards.replaceChildren();
      this.summary.innerHTML = '';
      this.summary.append(h('span', { class: 'warn-text' }, (e as Error).message));
      this.dirty = true;
      return;
    }
    this.renderResult();
    this.dirty = true;
  }

  /** Human-readable recommendation for a result. */
  static describe(r: AlignResult, tempC: number): { delay: string; where: string; polarity: string; distance: string } {
    const ms = Math.abs(r.delayMs);
    const metres = (ms / 1000) * speedOfSound(tempC);
    return {
      delay: ms < 0.05 ? '0 ms' : `${ms.toFixed(2)} ms`,
      where: ms < 0.05 ? 'No delay change needed' : r.delayMs > 0 ? 'Delay the sub' : 'Delay the mains',
      polarity: r.polarity === 1 ? 'Normal' : 'Inverted',
      distance: `${metres.toFixed(2)} m / ${(metres * 3.2808).toFixed(1)} ft`,
    };
  }

  private renderResult(): void {
    const r = this.result;
    if (!r) return;
    const d = AlignView.describe(r, this.app.settings.tempC);
    const card = (label: string, value: string, sub: string, hint: string, cls = '') => h('div', { class: `card ${cls}`, title: hint }, h('span', {}, label), h('b', {}, value), h('em', {}, sub));
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    this.cards.replaceChildren(
      card(d.where, d.delay, d.distance, 'Delay to add (the equivalent distance at the current temperature)', 'align-delay'),
      card('Sub polarity', d.polarity, r.polarity === 1 ? 'leave as is' : 'invert the sub', 'Polarity for the sub'),
      card('Crossover', `${Math.round(r.crossover)} Hz`, `optimised ${Math.round(r.region[0])}–${Math.round(r.region[1])} Hz`, 'Where the two are closest in level, and the region optimised'),
      card('Summation', `${pct(r.before)} → ${pct(r.after)}`, 'before → after (100% = perfect)', 'How completely the two add up in the crossover region'),
      card('Gain at crossover', `${r.gainDb >= 0 ? '+' : ''}${r.gainDb.toFixed(1)} dB`, 'over the louder part (ideal +6 dB)', 'Level gain of the aligned sum over the louder of the two at the crossover'),
    );
    const notes: string[] = [];
    if (r.after < 0.8) notes.push('Summation stays incomplete: the phase slopes differ through the crossover. Consider changing the crossover filters (slope or frequency), then measure again.');
    if (r.cancellations.length) notes.push(`The aligned sum still dips ≥ 3 dB near ${fmtFreqs(r.cancellations)}.`);
    if (Math.abs(r.delayMs) > this.rangeMs - 0.5) notes.push('The best delay is at the edge of the search range: check that both were measured with the same reference and delay, or widen the range.');
    this.summary.innerHTML = '';
    this.summary.append(
      h('b', {}, `${d.where}${Math.abs(r.delayMs) >= 0.05 ? ` by ${d.delay}` : ''}, ${r.polarity === 1 ? 'normal' : 'inverted'} polarity.`),
      ` Mains: ${this.resultNames?.main ?? ''} · Sub: ${this.resultNames?.sub ?? ''}. `,
      notes.length ? h('span', { class: 'warn-text' }, notes.join(' ')) : 'Phase tracks through the crossover.',
    );
  }

  private saveSum(): void {
    const r = this.result;
    if (!r) return this.app.toast('Calculate the alignment first.', 'warn');
    this.app.traces.add({ name: `Sub + mains aligned (${(r.delayMs >= 0 ? '+' : '') + r.delayMs.toFixed(2)} ms${r.polarity < 0 ? ', inv' : ''})`, kind: 'tf', freqs: Array.from(r.freqs), mag: Array.from(r.sumAfterDb, (v) => +v.toFixed(3)), color: AFTER_COLOR });
    this.app.toast('Stored the predicted sum as a trace', 'ok');
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** The last alignment as plain data (for sessions), or null. */
  snapshot(): AlignSnapshot | null {
    const r = this.result;
    if (!r) return null;
    const arr = (a: Float64Array) => Array.from(a, (v) => (Number.isFinite(v) ? +v.toFixed(3) : null));
    return {
      names: this.resultNames ?? { main: '', sub: '' },
      delayMs: r.delayMs,
      polarity: r.polarity,
      region: r.region,
      crossover: r.crossover,
      before: r.before,
      after: r.after,
      gainDb: r.gainDb,
      cancellations: r.cancellations,
      freqs: Array.from(r.freqs),
      mainDb: arr(r.mainDb),
      subDb: arr(r.subDb),
      sumBeforeDb: arr(r.sumBeforeDb),
      sumAfterDb: arr(r.sumAfterDb),
      mainPhase: arr(r.mainPhase),
      subPhase: arr(r.subPhase),
    };
  }

  restore(snap: AlignSnapshot | null): void {
    if (!snap) {
      this.result = null;
      this.resultNames = null;
      this.cards.replaceChildren();
    } else {
      const f64 = (a: (number | null)[]) => Float64Array.from(a, (v) => (v === null ? NaN : v));
      this.result = {
        ...snap,
        freqs: Float64Array.from(snap.freqs),
        mainDb: f64(snap.mainDb),
        subDb: f64(snap.subDb),
        sumBeforeDb: f64(snap.sumBeforeDb),
        sumAfterDb: f64(snap.sumAfterDb),
        mainPhase: f64(snap.mainPhase),
        subPhase: f64(snap.subPhase),
      };
      this.resultNames = snap.names;
      this.renderResult();
    }
    this.dirty = true;
  }

  tick(): void {
    if (this.app.traces.version !== this.tracesVersion) this.renderSources();
    const live = this.sources.main.startsWith('live:') || this.sources.sub.startsWith('live:');
    if (!this.dirty && !live) return;
    this.dirty = false;
    const r = this.result;
    const mag: Series[] = [];
    const ph: Series[] = [];
    if (r) {
      const f = r.freqs;
      mag.push(
        { id: 'main', label: 'Mains', x: f, y: r.mainDb, color: MAIN_COLOR, width: 1.6 },
        { id: 'sub', label: 'Sub', x: f, y: r.subDb, color: SUB_COLOR, width: 1.6 },
        { id: 'before', label: 'Sum as measured', x: f, y: r.sumBeforeDb, color: BEFORE_COLOR, width: 1.4, dash: [5, 3] },
        { id: 'after', label: 'Sum aligned', x: f, y: r.sumAfterDb, color: AFTER_COLOR, width: 2.4 },
      );
      ph.push(
        { id: 'main', label: 'Mains', x: f, y: r.mainPhase, color: MAIN_COLOR, width: 1.6, wrap: 180 },
        { id: 'sub', label: 'Sub (aligned)', x: f, y: r.subPhase, color: SUB_COLOR, width: 1.6, dash: [6, 4], wrap: 180 },
      );
    } else {
      for (const part of ['main', 'sub'] as const) {
        const src = this.input(part);
        if (!src) continue;
        const c = part === 'main' ? MAIN_COLOR : SUB_COLOR;
        mag.push({ id: part, label: src.name, x: src.freqs, y: src.mag, color: c, width: 1.6 });
        ph.push({ id: part, label: src.name, x: src.freqs, y: src.phase, color: c, width: 1.4, wrap: 180 });
      }
    }
    this.mag.series = mag;
    this.phase.series = ph;
    // Optimised region shaded, crossover marked
    const shades = r ? [{ x0: r.region[0], x1: r.region[1], color: 'rgba(61,220,132,0.07)' }] : [];
    const markers = r ? [{ x: r.crossover, label: `${Math.round(r.crossover)} Hz`, color: AFTER_COLOR }] : [];
    for (const p of [this.mag, this.phase]) {
      p.shades = shades;
      p.markers = markers;
    }
    this.mag.draw();
    this.phase.draw();
  }
}

function fmtFreqs(fs: number[]): string {
  // Group neighbouring frequencies into ranges
  const out: string[] = [];
  let start = fs[0];
  let prev = fs[0];
  for (let i = 1; i <= fs.length; i++) {
    const f = fs[i];
    if (i < fs.length && f / prev < 1.1) {
      prev = f;
      continue;
    }
    out.push(start === prev ? `${Math.round(start)} Hz` : `${Math.round(start)}–${Math.round(prev)} Hz`);
    start = prev = f;
  }
  return out.slice(0, 4).join(', ');
}
