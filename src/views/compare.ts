import type { App } from '../app';
import type { CompareSettings } from '../state';
import type { Trace } from '../traces';
import { h, select } from '../ui/dom';
import { modal } from '../ui/dialogs';
import { Plot, type Series } from '../ui/plot';
import { TARGETS } from '../dsp/eq';
import { targetShape } from '../dsp/target';
import { compareCurves, type CompareResult } from '../dsp/compare';
/** Round frequencies as people say them: 40 Hz, 8 kHz, 2.5 kHz. */
const formatFreq = (f: number) => (f < 1000 ? `${Math.round(f)} Hz` : `${+(f / 1000).toFixed(f < 10000 ? 1 : 0)} kHz`);

const TARGET_COLOR = '#ffb020';
const RANGE_LO = [20, 30, 40, 60, 80, 100];
const RANGE_HI = [1000, 4000, 8000, 12000, 16000, 20000];

/** The comparable traces (transfer functions and sweeps; spectra only with spectra). */
function candidates(app: App): Trace[] {
  return app.traces.traces;
}

/** Default pair: the two selected traces (older = before), else the two newest. */
function defaultPair(app: App, selected: string[]): [string, string] | null {
  const all = candidates(app);
  const pick = selected.length >= 2 ? all.filter((t) => selected.includes(t.id)) : all;
  if (pick.length < 2) return null;
  const sorted = [...pick].sort((a, b) => a.created - b.created);
  return [sorted[sorted.length - 2].id, sorted[sorted.length - 1].id];
}

export interface CompareOutcome {
  cfg: CompareSettings;
  before: Trace;
  after: Trace;
  grid: Float64Array;
  result: CompareResult;
  targetName: string;
}

/** Run the stored comparison (for the dialog and the report); null when its traces are gone. */
export function runCompare(app: App, cfg: CompareSettings): CompareOutcome | null {
  const before = app.traces.traces.find((t) => t.id === cfg.before);
  const after = app.traces.traces.find((t) => t.id === cfg.after);
  if (!before || !after) return null;
  const grid = app.grid;
  const shape = targetShape(cfg.target, grid);
  const result = compareCurves(grid, before, after, shape, { fMin: cfg.fMin, fMax: cfg.fMax, tolerance: app.settings.targetTolerance || 3, matchLevels: cfg.matchLevels });
  return { cfg, before, after, grid, result, targetName: TARGETS.find((t) => t.id === cfg.target)?.label.replace(/ \(.*\)$/, '') ?? 'Target' };
}

/** One-line verdict, e.g. "±4.1 dB → ±1.8 dB RMS from 40 Hz to 8 kHz (56 % closer to the target)". */
export function compareSummary(o: CompareOutcome): string {
  const b = o.result.devBefore;
  const a = o.result.devAfter;
  const range = `from ${formatFreq(o.cfg.fMin)} to ${formatFreq(o.cfg.fMax)}`;
  if (!b || !a) return `No target: the graph shows the change ${range}.`;
  const better = (1 - a.rms / b.rms) * 100;
  const verdict = Math.abs(better) < 5 ? 'about the same' : better > 0 ? `${better.toFixed(0)} % closer to the target` : `${(-better).toFixed(0)} % further from the target`;
  return `±${b.rms.toFixed(1)} dB → ±${a.rms.toFixed(1)} dB RMS ${range} (${verdict})`;
}

/** Series for the comparison graph (also used by the report). */
export function compareSeries(o: CompareOutcome): { curves: Series[]; change: Series[] } {
  const { result: r, grid, before, after } = o;
  const curves: Series[] = [];
  if (r.targetAfter) curves.push({ id: 'target', label: o.targetName, x: grid, y: r.targetAfter, color: TARGET_COLOR, width: 1.2, dash: [6, 4] });
  curves.push({ id: 'before', label: `Before: ${before.name}${o.cfg.matchLevels && Math.abs(r.shift) > 0.05 ? ` (${r.shift > 0 ? '+' : ''}${r.shift.toFixed(1)} dB to match)` : ''}`, x: grid, y: r.before, color: '#8a94a6', width: 1.6, dash: [5, 3] });
  curves.push({ id: 'after', label: `After: ${after.name}`, x: grid, y: r.after, color: '#2ec4b6', width: 2 });
  const change: Series[] = [{ id: 'diff', label: 'Change (after − before)', x: grid, y: r.diff, color: '#b18cff', width: 1.8 }];
  return { curves, change };
}

/**
 * Before / after comparison: two traces on one graph, the change between them and how close each is to the target
 * (RMS deviation and the share within the tolerance band). The last comparison is kept for the report.
 */
export function showCompare(app: App, selected: string[]): void {
  const s = app.settings;
  const prev = s.compare && runCompare(app, s.compare) ? s.compare : null;
  const pair = prev ? [prev.before, prev.after] : defaultPair(app, selected);
  if (!pair) {
    app.toast('Save two traces first (for example a sweep before and after EQ), then compare them', 'warn');
    return;
  }
  const preferredTarget = [s.roomTargetCurve, s.targetCurve].find((t) => TARGETS.some((x) => x.id === t)) ?? 'flat';
  const cfg: CompareSettings = prev
    ? { ...prev }
    : { before: pair[0], after: pair[1], target: preferredTarget, fMin: 40, fMax: 8000, matchLevels: true, report: true };

  const plot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -30, yMax: 12, yUnit: 'dB', yStep: 6, yLimits: [-200, 200] });
  const changePlot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -15, yMax: 15, yUnit: 'dB', yStep: 5, yLimits: [-100, 100] });
  const scores = h('div', { class: 'cmp-scores' });
  const summary = h('p', { class: 'cmp-summary', role: 'status' });
  const legend = h('div', { class: 'cmp-legend' });
  const traceOpts = () => candidates(app).map((t) => ({ value: t.id, label: `${t.name} (${t.kind.toUpperCase()})` }));

  const score = (title: string, d: CompareResult['devBefore'], cls: string) =>
    h(
      'div',
      { class: `cmp-score ${cls}` },
      h('span', { class: 'cmp-score-title' }, title),
      d ? h('b', {}, `±${d.rms.toFixed(1)} dB`) : h('b', {}, '–'),
      d ? h('span', { class: 'dim small' }, `${Math.round(d.within * 100)} % within ±${s.targetTolerance || 3} dB · worst ${d.worst.dev > 0 ? '+' : ''}${d.worst.dev.toFixed(1)} dB at ${formatFreq(d.worst.f)}`) : h('span', { class: 'dim small' }, 'Choose a target to score'),
    );

  let fitted = false;
  const update = () => {
    s.compare = { ...cfg };
    app.save();
    const o = runCompare(app, cfg);
    if (!o) return;
    const { curves, change } = compareSeries(o);
    const band = { x0: cfg.fMin, x1: cfg.fMax };
    plot.shades = [{ ...band, color: 'rgba(120,140,170,0.07)' }];
    changePlot.shades = plot.shades;
    plot.series = curves;
    changePlot.series = [...change, { id: 'zero', label: '', x: [20, 20000], y: [0, 0], color: '#8a94a6', width: 1, quiet: true }];
    if (!fitted) {
      plot.fitY();
      fitted = true;
    }
    plot.draw();
    changePlot.draw();
    summary.textContent = compareSummary(o);
    legend.replaceChildren(...curves.map((c) => h('span', { class: 'lg' }, h('i', { style: `border-top: 2px ${c.dash ? 'dashed' : 'solid'} ${c.color}` }), c.label)));
    scores.replaceChildren(score('Before', o.result.devBefore, 'before'), h('span', { class: 'cmp-arrow', 'aria-hidden': 'true' }, '→'), score('After', o.result.devAfter, 'after'));
  };

  const beforeSel = select(traceOpts(), cfg.before, (v) => { cfg.before = v; fitted = false; update(); }, { 'aria-label': 'Before', dataset: { compare: 'before' } });
  const afterSel = select(traceOpts(), cfg.after, (v) => { cfg.after = v; fitted = false; update(); }, { 'aria-label': 'After', dataset: { compare: 'after' } });
  const swap = h('button', { class: 'btn small ghost', title: 'Swap before and after', onclick: () => {
    [cfg.before, cfg.after] = [cfg.after, cfg.before];
    beforeSel.value = cfg.before;
    afterSel.value = cfg.after;
    update();
  } }, '⇄');
  const match = h('input', { type: 'checkbox', checked: cfg.matchLevels });
  match.addEventListener('change', () => { cfg.matchLevels = match.checked; update(); });
  const inReport = h('input', { type: 'checkbox', checked: cfg.report });
  inReport.addEventListener('change', () => { cfg.report = inReport.checked; update(); });

  const body = h(
    'div',
    { class: 'cmp' },
    h('div', { class: 'cmp-row' }, h('label', { class: 'cmp-field' }, h('span', {}, 'Before'), beforeSel), swap, h('label', { class: 'cmp-field' }, h('span', {}, 'After'), afterSel)),
    h(
      'div',
      { class: 'cmp-row' },
      h('label', { class: 'cmp-field' }, h('span', {}, 'Target'), select(TARGETS.map((t) => ({ value: t.id, label: t.label, title: t.note })), cfg.target, (v) => { cfg.target = v; update(); }, { 'aria-label': 'Target', dataset: { compare: 'target' } })),
      h(
        'label',
        { class: 'cmp-field' },
        h('span', {}, 'Score from'),
        select(RANGE_LO.map((f) => ({ value: f, label: formatFreq(f) })), cfg.fMin, (v) => { cfg.fMin = v; update(); }, { 'aria-label': 'Score from' }),
        h('span', {}, 'to'),
        select(RANGE_HI.map((f) => ({ value: f, label: formatFreq(f) })), cfg.fMax, (v) => { cfg.fMax = v; update(); }, { 'aria-label': 'Score to' }),
      ),
      h('label', { class: 'cmp-check', title: 'Move “before” to the level of “after” (250 Hz–4 kHz), so the change shows only the shape' }, match, 'Match levels'),
    ),
    scores,
    summary,
    legend,
    h('div', { class: 'cmp-plot' }, plot.el),
    h('div', { class: 'cmp-plot small' }, changePlot.el),
    h('label', { class: 'cmp-check' }, inReport, 'Include in the report'),
  );
  const done = h('button', { class: 'btn accent' }, 'Done');
  const { el, close } = modal('Compare before / after', body, [h('div', { class: 'spacer' }), done]);
  done.addEventListener('click', close);
  el.classList.add('cmp-modal');
  // Free the plots when the dialog goes (Escape, the close button, a click outside or Done)
  new MutationObserver((_, obs) => {
    if (el.isConnected) return;
    obs.disconnect();
    plot.dispose();
    changePlot.dispose();
  }).observe(document.body, { childList: true });
  // Plots size themselves once they are in the page
  requestAnimationFrame(() => {
    plot.resize();
    changePlot.resize();
    update();
  });
}
