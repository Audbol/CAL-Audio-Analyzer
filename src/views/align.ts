import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import { alignFullRange, alignSubMain, type AlignInput, type AlignResult } from '../dsp/align';
import { speedOfSound } from '../dsp/delay';
import { optionsMenu, optRow, optHead } from '../ui/popover';

const MAIN_COLOR = '#4da3ff';
const PART_COLOR = '#ff6b6b';
const BEFORE_COLOR = '#9aa4b2';
const AFTER_COLOR = '#3ddc84';

/** What a system part is: it decides how it is aligned to the mains. */
export type ElementKind = 'sub' | 'frontfill' | 'outfill' | 'delay' | 'other';

export const KIND_INFO: Record<ElementKind, { label: string; name: string; precedence: number; hint: string }> = {
  sub: { label: 'Sub', name: 'Sub', precedence: 0, hint: 'Summed with the mains through the crossover: measure both at a position where they overlap in level.' },
  frontfill: { label: 'Front fill', name: 'Front fill', precedence: 0, hint: 'Aligned to the mains at the handoff: the first rows where both cover about equally.' },
  outfill: { label: 'Out fill', name: 'Out fill', precedence: 0, hint: 'Aligned to the mains at the handoff: where the mains and the out fill cover about equally.' },
  delay: { label: 'Delay speaker', name: 'Delay', precedence: 5, hint: 'Aligned to the mains where the delay speaker takes over, then set a few ms later so the sound still seems to come from the stage.' },
  other: { label: 'Other speaker', name: 'Speaker', precedence: 0, hint: 'A full-range speaker aligned to the mains where both cover.' },
};

/** One part of the system aligned to the reference (the mains). */
export interface AlignElement {
  id: string;
  name: string;
  kind: ElementKind;
  /** 'trace:<id>' or 'live:<measurement id>'. */
  source: string;
  /** The mains measured at this part's position ('' = the mains chosen in the toolbar). */
  ref: string;
  /** Fills / delays: how much later than the mains they should arrive (ms). */
  precedenceMs: number;
  result: AlignResult | null;
  /** Names of the two measurements the result came from. */
  names: { main: string; sub: string } | null;
  error?: string;
}

type Arr = (number | null)[];
interface ResultSnapshot {
  delayMs: number;
  polarity: 1 | -1;
  region: [number, number];
  crossover: number;
  before: number;
  after: number;
  gainDb: number;
  levelDb?: number;
  cancellations: number[];
  freqs: number[];
  mainDb: Arr;
  subDb: Arr;
  sumBeforeDb: Arr;
  sumAfterDb: Arr;
  mainPhase: Arr;
  subPhase: Arr;
}

/** Sessions: the system and every part's result. (Version 1 held one sub/main result: see restore.) */
export interface AlignSnapshot {
  version: 2;
  reference: string;
  selected: string;
  elements: { id: string; name: string; kind: ElementKind; source: string; ref?: string; precedenceMs: number; names: { main: string; sub: string } | null; result: ResultSnapshot | null }[];
}
type LegacySnapshot = ResultSnapshot & { names: { main: string; sub: string } };

export function snapResult(r: AlignResult): ResultSnapshot {
  const arr = (a: Float64Array) => Array.from(a, (v) => (Number.isFinite(v) ? +v.toFixed(3) : null));
  return {
    delayMs: r.delayMs,
    polarity: r.polarity,
    region: r.region,
    crossover: r.crossover,
    before: r.before,
    after: r.after,
    gainDb: r.gainDb,
    levelDb: r.levelDb,
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

function unsnapResult(s: ResultSnapshot): AlignResult {
  const f64 = (a: Arr) => Float64Array.from(a, (v) => (v === null ? NaN : v));
  return {
    ...s,
    levelDb: s.levelDb ?? 0,
    freqs: Float64Array.from(s.freqs),
    mainDb: f64(s.mainDb),
    subDb: f64(s.subDb),
    sumBeforeDb: f64(s.sumBeforeDb),
    sumAfterDb: f64(s.sumAfterDb),
    mainPhase: f64(s.mainPhase),
    subPhase: f64(s.subPhase),
  };
}

/** What to set for a part: the delay (and on which side), polarity and the level at the handoff. */
export interface Recommendation {
  /** Headline, e.g. "Delay the sub by 3.02 ms". */
  action: string;
  /** Delay to set on the part (ms; for a sub a negative value means delay the mains instead). */
  delayMs: number;
  where: 'part' | 'mains' | 'none' | 'impossible';
  polarity: string;
  distance: string;
  warning: string;
}

export function recommend(el: Pick<AlignElement, 'kind' | 'name' | 'precedenceMs'>, r: AlignResult, tempC: number): Recommendation {
  const c = speedOfSound(tempC);
  const dist = (ms: number) => {
    const m = (Math.abs(ms) / 1000) * c;
    return `${m.toFixed(2)} m / ${(m * 3.2808).toFixed(1)} ft`;
  };
  const polarity = r.polarity === 1 ? 'Normal' : 'Inverted';
  if (el.kind === 'sub') {
    const ms = r.delayMs;
    if (Math.abs(ms) < 0.05) return { action: 'No delay change needed', delayMs: 0, where: 'none', polarity, distance: dist(0), warning: '' };
    return ms > 0
      ? { action: `Delay the ${el.name.toLowerCase()} by ${ms.toFixed(2)} ms`, delayMs: ms, where: 'part', polarity, distance: dist(ms), warning: '' }
      : { action: `Delay the mains by ${(-ms).toFixed(2)} ms`, delayMs: ms, where: 'mains', polarity, distance: dist(ms), warning: '' };
  }
  // Fills and delay speakers are set to arrive with (or a little after) the mains; the mains are never delayed
  const set = r.delayMs + el.precedenceMs;
  if (set < -0.05)
    return {
      action: `Arrives ${(-set).toFixed(2)} ms after the mains`,
      delayMs: set,
      where: 'impossible',
      polarity,
      distance: dist(set),
      warning: 'This speaker is already late at this position: delay can’t make it earlier. Check the measurement position (use the handoff between the two), or re-aim / move the speaker.',
    };
  return { action: set < 0.05 ? 'No delay needed' : `Delay the ${el.name.toLowerCase()} by ${set.toFixed(2)} ms`, delayMs: Math.max(0, set), where: set < 0.05 ? 'none' : 'part', polarity, distance: dist(set), warning: '' };
}

/**
 * System alignment: the mains are the reference; subs, front and out fills and delay speakers are each measured
 * alone (same mic position as the mains measurement they are compared with, same reference) and aligned to the
 * mains. Subs are aligned for the best summation through the crossover, full-range parts for arrival across
 * their overlap band (plus an optional precedence so the mains are heard first).
 */
export class AlignView implements View {
  id = 'align' as const;
  readonly needs = { tf: true };
  title = 'Align';
  icon = 'target' as const;
  el = h('div', { class: 'align' });
  private mag: Plot;
  private phase: Plot;
  reference = '';
  private refHost = h('span', {});
  elements: AlignElement[] = [];
  selected = '';
  private list = h('div', { class: 'align-list' });
  private rangeMs = 20;
  private fullRangeMs = 30;
  private regionMode: 'auto' | 'manual' = 'auto';
  private region: [number, number] = [60, 150];
  private summary = h('div', { class: 'info-strip' });
  private cards = h('div', { class: 'cards' });
  private tracesVersion = -1;
  private dirty = true;

  constructor(private app: App) {
    this.mag = new Plot({ xType: 'log', xMin: 20, xMax: 1000, yMin: -30, yMax: 12, yUnit: 'dB', yStep: 6, title: 'Magnitude: mains, part and their predicted sum', showNote: true, yLimits: [-120, 120] });
    this.phase = new Plot({ xType: 'log', xMin: 20, xMax: 1000, yMin: -180, yMax: 180, yUnit: 'deg', yStep: 45, title: 'Phase: mains and the aligned part (they should track where both play)', yLimits: [-540, 540] });
    const num = (value: number, step: string, onChange: (v: number) => void, attrs: Record<string, string> = {}) => {
      const i = h('input', { type: 'number', class: 'num', value: String(value), step, ...attrs });
      i.addEventListener('change', () => onChange(+i.value));
      return i;
    };
    const manual = h(
      'span',
      { class: 'align-manual' },
      num(this.region[0], '1', (v) => (this.region[0] = v), { 'aria-label': 'Region from (Hz)' }),
      h('span', { class: 'unit' }, '–'),
      num(this.region[1], '1', (v) => (this.region[1] = v), { 'aria-label': 'Region to (Hz)' }),
      h('span', { class: 'unit' }, 'Hz'),
    );
    manual.style.display = 'none';
    const addMenu = optionsMenu(
      (Object.keys(KIND_INFO) as ElementKind[]).map((k) =>
        h('button', { class: 'btn small align-add', dataset: { add: k }, title: KIND_INFO[k].hint, onclick: () => { this.add(k); (document.activeElement as HTMLElement | null)?.blur(); } }, icon('plus', 13), KIND_INFO[k].label),
      ),
      { label: 'Add part', title: 'Add a sub, fill or delay speaker to align to the mains', id: 'align-add' },
    );
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Mains'), this.refHost, h('button', { class: 'btn small', title: 'Store the live transfer function as the mains measurement', onclick: () => this.captureRef() }, icon('camera', 14), 'Capture mains')),
        addMenu,
        optionsMenu(
          [
            optHead('Subs'),
            optRow(
              'Crossover region',
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
            ),
            optRow('Search range', h('span', { class: 'row gap4' }, '±', num(this.rangeMs, '1', (v) => (this.rangeMs = Math.min(50, Math.max(1, v || 20))), { min: '1', max: '50' }), h('span', { class: 'unit' }, 'ms'))),
            optHead('Fills & delay speakers'),
            optRow('Search range', h('span', { class: 'row gap4' }, '±', num(this.fullRangeMs, '1', (v) => (this.fullRangeMs = Math.min(300, Math.max(1, v || 30))), { min: '1', max: '300', title: 'Around the arrival difference known from the two measurements’ delays' }), h('span', { class: 'unit' }, 'ms'))),
          ],
          { title: 'Alignment options: sub crossover region, search ranges', id: 'align' },
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', title: 'Store the predicted aligned sum of the selected part as a trace', onclick: () => this.saveSum() }, icon('download', 14), 'Save sum'),
        h('button', { class: 'btn accent', onclick: () => this.run() }, icon('sparkle', 15), 'Calculate alignment'),
      ),
      h(
        'div',
        { class: 'align-body' },
        h('aside', { class: 'align-side' }, h('div', { class: 'align-side-head' }, 'System'), this.list),
        h('div', { class: 'align-main' }, this.summary, this.cards, h('div', { class: 'panes align-panes' }, h('div', { class: 'pane big' }, this.mag.el), h('div', { class: 'pane' }, this.phase.el))),
      ),
    );
    this.add('sub', false);
  }

  // Parts --------------------------------------------------------------------------------------------------

  private add(kind: ElementKind, render = true): AlignElement {
    const info = KIND_INFO[kind];
    const same = this.elements.filter((e) => e.kind === kind).length;
    const el: AlignElement = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: same ? `${info.name} ${same + 1}` : info.name, kind, source: '', ref: '', precedenceMs: info.precedence, result: null, names: null };
    this.elements.push(el);
    this.selected = el.id;
    if (render) {
      this.renderSources();
      this.renderSelected();
    }
    return el;
  }

  private get current(): AlignElement | null {
    return this.elements.find((e) => e.id === this.selected) ?? this.elements[0] ?? null;
  }

  /** The selected part's result (tests, report). */
  get result(): AlignResult | null {
    return this.current?.result ?? null;
  }

  get resultNames(): { main: string; sub: string } | null {
    return this.current?.names ?? null;
  }

  show(): void {
    this.renderSources();
    this.dirty = true;
  }

  private sourceOptions(): { value: string; label: string }[] {
    const app = this.app;
    const opts = [
      ...app.measurements.map((m) => ({ value: `live:${m.cfg.id}`, label: `Live: ${m.cfg.name}` })),
      ...app.traces.traces.filter((t) => t.kind !== 'rta' && t.phase).map((t) => ({ value: `trace:${t.id}`, label: t.name })),
    ];
    return opts.length ? opts : [{ value: '', label: '(capture a measurement)' }];
  }

  /** Default source: the newest trace whose name starts with the part's name. */
  private guess(name: string, opts: { value: string }[]): string {
    const t = [...this.app.traces.traces].reverse().find((x) => x.phase && x.name.toLowerCase().startsWith(name.toLowerCase()));
    return t ? `trace:${t.id}` : opts[0].value;
  }

  private renderSources(): void {
    this.tracesVersion = this.app.traces.version;
    const opts = this.sourceOptions();
    if (!opts.some((o) => o.value === this.reference)) this.reference = this.guess('Mains', opts);
    this.refHost.replaceChildren(select(opts, this.reference, (v) => { this.reference = v; this.dirty = true; }, { dataset: { align: 'ref' } }));
    for (const el of this.elements) {
      if (!opts.some((o) => o.value === el.source)) el.source = this.guess(el.name, opts);
      if (el.ref && !opts.some((o) => o.value === el.ref)) el.ref = '';
    }
    this.renderList(opts);
  }

  private renderList(opts = this.sourceOptions()): void {
    const cur = this.current;
    this.list.replaceChildren(
      ...this.elements.map((el) => {
        const name = h('input', { type: 'text', class: 'text align-name', value: el.name, 'aria-label': 'Name' });
        name.addEventListener('change', () => {
          // Also fires when the field is replaced while focused: only act on a real rename
          const v = name.value.trim();
          if (!v || v === el.name) return;
          el.name = v;
          queueMicrotask(() => this.renderSelected());
        });
        const r = el.result;
        const rec = r ? recommend(el, r, this.app.settings.tempC) : null;
        const line = r && rec
          ? h('div', { class: `align-res${rec.where === 'impossible' ? ' warn' : ''}` }, h('b', {}, rec.action), h('span', {}, ` · ${rec.polarity.toLowerCase()} polarity · ${r.levelDb >= 0 ? '+' : ''}${r.levelDb.toFixed(1)} dB · ${Math.round(r.after * 100)}%`))
          : el.error
            ? h('div', { class: 'align-res warn' }, el.error)
            : h('div', { class: 'align-res dim' }, 'Not aligned yet');
        const card = h(
          'div',
          { class: `align-el${cur === el ? ' on' : ''}`, dataset: { el: el.id, kind: el.kind }, onclick: (e: Event) => {
            if ((e.target as HTMLElement).closest('input, select, button')) return;
            this.selected = el.id;
            this.renderList();
            this.renderSelected();
          } },
          h('div', { class: 'align-el-head' }, h('span', { class: `kind-badge k-${el.kind}` }, KIND_INFO[el.kind].label), name, h('button', { class: 'btn tiny ghost', title: `Remove ${el.name}`, onclick: () => this.remove(el) }, icon('x', 12))),
          h(
            'div',
            { class: 'align-el-src' },
            select(opts, el.source, (v) => {
              el.source = v;
              el.result = null;
              el.names = null;
              this.selected = el.id;
              this.renderList();
              this.renderSelected();
            }, { dataset: { alignEl: el.id }, 'aria-label': `Measurement of ${el.name} alone` }),
            h('button', { class: 'btn tiny', title: `Store the live transfer function as the ${el.name.toLowerCase()} measurement`, onclick: () => this.captureEl(el) }, icon('camera', 12), 'Capture'),
          ),
          h(
            'div',
            { class: 'align-el-src' },
            h('span', { class: 'dim small align-vs' }, 'Mains here'),
            select([{ value: '', label: 'Toolbar mains' }, ...opts], el.ref, (v) => {
              el.ref = v;
              el.result = null;
              el.names = null;
              this.selected = el.id;
              this.renderList();
              this.renderSelected();
            }, { dataset: { alignRef: el.id }, title: 'The mains measured alone at this part’s position (the handoff)' }),
            h('button', { class: 'btn tiny', title: 'Store the live transfer function as the mains measured at this position', onclick: () => this.captureElRef(el) }, icon('camera', 12), 'Capture'),
          ),
          el.kind !== 'sub'
            ? h(
                'div',
                { class: 'align-el-prec' },
                h('span', { class: 'dim small' }, 'Arrive after mains'),
                select([0, 1, 2, 5, 10, 15, 20].map((v) => ({ value: v, label: `${v} ms` })), el.precedenceMs, (v) => {
                  el.precedenceMs = v;
                  this.renderList();
                  this.renderSelected();
                }, { title: 'Precedence: arriving a few ms after the mains keeps the sound on stage (delay speakers: 5–15 ms)', dataset: { precedence: el.id } }),
              )
            : null,
          line,
        );
        return card;
      }),
      h('p', { class: 'dim small align-help' }, 'For each part, measure the mains alone and the part alone at the position where the two meet (the handoff), with the same reference. Choose that mains measurement under “Mains here”, or leave it on the toolbar’s mains when all were measured at one position.'),
    );
  }

  private remove(el: AlignElement): void {
    this.elements = this.elements.filter((x) => x !== el);
    if (this.selected === el.id) this.selected = this.elements[0]?.id ?? '';
    this.renderList();
    this.renderSelected();
  }

  private captureTo(name: string, color: string): string | null {
    const app = this.app;
    const m = app.measurements.find((x) => x.cfg.enabled) ?? app.measurements[0];
    if (!m) {
      app.toast('Add a measurement first.', 'warn');
      return null;
    }
    const t = app.captureTrace(m, 'tf');
    if (!t) return null;
    app.traces.update(t.id, { name: `${name} ${t.name.slice(m.cfg.name.length + 1)}`, color });
    return `trace:${t.id}`;
  }

  private captureRef(): void {
    const src = this.captureTo('Mains', MAIN_COLOR);
    if (!src) return;
    this.reference = src;
    this.renderSources();
  }

  private captureElRef(el: AlignElement): void {
    const src = this.captureTo(`Mains at ${el.name.toLowerCase()}`, MAIN_COLOR);
    if (!src) return;
    el.ref = src;
    el.result = null;
    this.selected = el.id;
    this.renderSources();
    this.renderSelected();
  }

  private captureEl(el: AlignElement): void {
    const src = this.captureTo(el.name, PART_COLOR);
    if (!src) return;
    el.source = src;
    el.result = null;
    this.selected = el.id;
    this.renderSources();
    this.renderSelected();
  }

  private input(source: string): (AlignInput & { name: string }) | null {
    const app = this.app;
    const i = source.indexOf(':');
    const [kind, id] = [source.slice(0, i), source.slice(i + 1)];
    if (kind === 'live') {
      const m = app.measurements.find((x) => x.cfg.id === id);
      if (!m || !m.tfReady) return null;
      return { name: m.cfg.name, freqs: app.grid, mag: m.mag, phase: m.phase, coh: m.result.coh, delayMs: (m.cfg.delay / m.fs) * 1000 };
    }
    const t = app.traces.traces.find((x) => x.id === id);
    if (!t || !t.phase) return null;
    return { name: t.name, freqs: t.freqs, mag: t.offset ? t.mag.map((v) => v + t.offset) : t.mag, phase: t.phase, coh: t.coh ?? null, delayMs: t.delayMs ?? 0 };
  }

  /** Align every part to the mains (as measured at that part's position). */
  run(): void {
    const app = this.app;
    if (!this.elements.length) return app.toast('Add the parts to align (Add part).', 'warn');
    let done = 0;
    for (const el of this.elements) {
      el.error = undefined;
      const main = this.input(el.ref || this.reference);
      if (!main) {
        el.result = null;
        el.error = 'Choose or capture the mains measured at this position';
        continue;
      }
      const part = this.input(el.source);
      if (!part) {
        el.result = null;
        el.error = 'Choose or capture its measurement';
        continue;
      }
      if (el.source === (el.ref || this.reference)) {
        el.result = null;
        el.error = 'Same measurement as the mains: capture it on its own';
        continue;
      }
      try {
        if (el.kind === 'sub') {
          const region = this.regionMode === 'manual' ? ([Math.min(...this.region), Math.max(...this.region)] as [number, number]) : null;
          el.result = alignSubMain(main, part, { rangeMs: this.rangeMs, region });
        } else el.result = alignFullRange(main, part, { rangeMs: this.fullRangeMs });
        el.names = { main: main.name, sub: part.name };
        done++;
      } catch (e) {
        el.result = null;
        el.error = (e as Error).message;
      }
    }
    this.renderList();
    this.renderSelected();
    if (done > 1) app.toast(`Aligned ${done} parts to the mains`, 'ok');
  }

  /** Human-readable recommendation for a sub result (kept for older callers). */
  static describe(r: AlignResult, tempC: number): { delay: string; where: string; polarity: string; distance: string } {
    const rec = recommend({ kind: 'sub', name: 'Sub', precedenceMs: 0 }, r, tempC);
    const ms = Math.abs(r.delayMs);
    return { delay: ms < 0.05 ? '0 ms' : `${ms.toFixed(2)} ms`, where: rec.where === 'none' ? 'No delay change needed' : rec.where === 'part' ? 'Delay the sub' : 'Delay the mains', polarity: rec.polarity, distance: rec.distance };
  }

  private renderSelected(): void {
    const el = this.current;
    this.dirty = true;
    const card = (label: string, value: string, sub: string, hint: string, cls = '') => h('div', { class: `card ${cls}`, title: hint }, h('span', {}, label), h('b', {}, value), h('em', {}, sub));
    const r = el?.result;
    if (!el || !r) {
      this.cards.replaceChildren();
      this.summary.innerHTML = '';
      if (el?.error) this.summary.append(h('span', { class: 'warn-text' }, `${el.name}: ${el.error}`));
      else this.summary.append(el ? `${KIND_INFO[el.kind].hint} Then press Calculate alignment.` : 'Add the parts of the system (Add part), capture each one alone, then press Calculate alignment.');
      return;
    }
    const rec = recommend(el, r, this.app.settings.tempC);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const sub = el.kind === 'sub';
    this.cards.replaceChildren(
      card(rec.where === 'mains' ? 'Delay the mains' : rec.where === 'impossible' ? 'Arrives late' : `Delay the ${el.name.toLowerCase()}`, `${Math.abs(rec.delayMs).toFixed(2)} ms`, rec.distance, 'Delay to set (and the equivalent distance at the current temperature)', 'align-delay'),
      card('Polarity', rec.polarity, r.polarity === 1 ? 'leave as is' : `invert the ${el.name.toLowerCase()}`, `Polarity for the ${el.name.toLowerCase()}`),
      sub
        ? card('Crossover', `${Math.round(r.crossover)} Hz`, `optimised ${Math.round(r.region[0])}–${Math.round(r.region[1])} Hz`, 'Where the two are closest in level, and the region optimised')
        : card('Level vs mains', `${r.levelDb >= 0 ? '+' : ''}${r.levelDb.toFixed(1)} dB`, 'here (0 dB = equal at the handoff)', 'Level of this part relative to the mains at the measurement position, over the band where both play'),
      card('Summation', `${pct(r.before)} → ${pct(r.after)}`, 'before → after (100% = perfect)', 'How completely the two add up where both play'),
      sub ? card('Gain at crossover', `${r.gainDb >= 0 ? '+' : ''}${r.gainDb.toFixed(1)} dB`, 'over the louder part (ideal +6 dB)', 'Level gain of the aligned sum over the louder of the two at the crossover') : card('Time-aligned', `${r.delayMs >= 0 ? '+' : ''}${r.delayMs.toFixed(2)} ms`, el.precedenceMs ? `+ ${el.precedenceMs} ms precedence` : 'no precedence', 'Delay that lines the two up exactly; the precedence is added on top'),
    );
    const notes: string[] = [];
    if (rec.warning) notes.push(rec.warning);
    if (r.after < 0.8) notes.push(sub ? 'Summation stays incomplete: the phase slopes differ through the crossover. Consider changing the crossover filters, then measure again.' : 'Summation stays incomplete: the two responses differ a lot in phase over the overlap. Check the measurement position and the crossover/EQ of the part.');
    if (sub && r.cancellations.length) notes.push(`The aligned sum still dips ≥ 3 dB near ${fmtFreqs(r.cancellations)}.`);
    if (!sub && Math.abs(r.levelDb) > 6) notes.push(`The ${el.name.toLowerCase()} is ${Math.abs(r.levelDb).toFixed(1)} dB ${r.levelDb > 0 ? 'louder' : 'quieter'} than the mains here: for a smooth handoff they should be about equal at this position.`);
    this.summary.innerHTML = '';
    this.summary.append(h('b', {}, `${rec.action}, ${rec.polarity.toLowerCase()} polarity.`), ` Mains: ${el.names?.main ?? ''} · ${el.name}: ${el.names?.sub ?? ''}. `, notes.length ? h('span', { class: 'warn-text' }, notes.join(' ')) : sub ? 'Phase tracks through the crossover.' : 'They line up across the overlap band.');
  }

  private saveSum(): void {
    const el = this.current;
    const r = el?.result;
    if (!el || !r) return this.app.toast('Calculate the alignment first.', 'warn');
    this.app.traces.add({ name: `${el.name} + mains aligned (${(r.delayMs >= 0 ? '+' : '') + r.delayMs.toFixed(2)} ms${r.polarity < 0 ? ', inv' : ''})`, kind: 'tf', freqs: Array.from(r.freqs), mag: Array.from(r.sumAfterDb, (v) => +v.toFixed(3)), color: AFTER_COLOR });
    this.app.toast('Stored the predicted sum as a trace', 'ok');
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** The system and its results as plain data (sessions), or null when nothing was aligned. */
  snapshot(): AlignSnapshot | null {
    if (!this.elements.some((e) => e.result)) return null;
    return {
      version: 2,
      reference: this.reference,
      selected: this.selected,
      elements: this.elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind, source: e.source, ref: e.ref, precedenceMs: e.precedenceMs, names: e.names, result: e.result ? snapResult(e.result) : null })),
    };
  }

  restore(snap: AlignSnapshot | LegacySnapshot | null): void {
    if (!snap) {
      this.elements = [];
      this.add('sub', false);
    } else if ('version' in snap && snap.version === 2) {
      this.reference = snap.reference;
      this.elements = snap.elements.map((e) => ({ ...e, ref: e.ref ?? '', result: e.result ? unsnapResult(e.result) : null }));
      this.selected = snap.selected;
    } else {
      // Sessions from 1.7–1.8: one sub / main result
      const old = snap as LegacySnapshot;
      this.elements = [{ id: 'sub', name: 'Sub', kind: 'sub', source: '', ref: '', precedenceMs: 0, names: old.names, result: unsnapResult(old) }];
      this.selected = 'sub';
    }
    this.renderSources();
    this.renderSelected();
  }

  tick(): void {
    if (this.app.traces.version !== this.tracesVersion) this.renderSources();
    const el = this.current;
    const refSrc = el?.ref || this.reference;
    const live = refSrc.startsWith('live:') || !!el?.source.startsWith('live:');
    if (!this.dirty && !live) return;
    this.dirty = false;
    const r = el?.result ?? null;
    const sub = !el || el.kind === 'sub';
    const xMax = sub ? 1000 : 20000;
    for (const p of [this.mag, this.phase]) if (p.cfg.xMax !== xMax) p.setDefaults({ xMin: 20, xMax });
    const partName = el?.name ?? 'Part';
    const mag: Series[] = [];
    const ph: Series[] = [];
    if (r) {
      const f = r.freqs;
      mag.push(
        { id: 'main', label: 'Mains', x: f, y: r.mainDb, color: MAIN_COLOR, width: 1.6 },
        { id: 'sub', label: partName, x: f, y: r.subDb, color: PART_COLOR, width: 1.6 },
        { id: 'before', label: 'Sum as measured', x: f, y: r.sumBeforeDb, color: BEFORE_COLOR, width: 1.4, dash: [5, 3] },
        { id: 'after', label: 'Sum aligned', x: f, y: r.sumAfterDb, color: AFTER_COLOR, width: 2.4 },
      );
      ph.push(
        { id: 'main', label: 'Mains', x: f, y: r.mainPhase, color: MAIN_COLOR, width: 1.6, wrap: 180 },
        { id: 'sub', label: `${partName} (aligned)`, x: f, y: r.subPhase, color: PART_COLOR, width: 1.6, dash: [6, 4], wrap: 180 },
      );
    } else {
      const parts: [string, string, string][] = [[refSrc, 'main', MAIN_COLOR], [el?.source ?? '', 'sub', PART_COLOR]];
      for (const [source, id, c] of parts) {
        const src = source ? this.input(source) : null;
        if (!src) continue;
        mag.push({ id, label: src.name, x: src.freqs, y: src.mag, color: c, width: 1.6 });
        ph.push({ id, label: src.name, x: src.freqs, y: src.phase, color: c, width: 1.4, wrap: 180 });
      }
    }
    this.mag.series = mag;
    this.phase.series = ph;
    // Optimised region shaded, crossover marked
    const shades = r ? [{ x0: r.region[0], x1: r.region[1], color: 'rgba(61,220,132,0.07)' }] : [];
    const markers = r && sub ? [{ x: r.crossover, label: `${Math.round(r.crossover)} Hz`, color: AFTER_COLOR }] : [];
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
