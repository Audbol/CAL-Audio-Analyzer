import type { App } from '../app';
import { allTargets, customCurve, CUSTOM_PREFIX, findTarget, type CustomTarget } from '../dsp/eq';
import { CHART } from './theme';
import { h, icon, select } from './dom';
import { modal } from './dialogs';
import { Plot } from './plot';
import { downloadText } from '../session';

/** Where a target is sampled when a custom one starts from it (about 1/3 to 2/3 octave apart, denser in the bass). */
const START_FREQS = [20, 31.5, 50, 63, 80, 100, 125, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000];

const newId = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Points from a text file: one "frequency level" pair per line (comma, semicolon, tab or space between). */
export function parseTargetText(text: string): [number, number][] {
  const pts: [number, number][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)[\s,;]+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
    if (m) pts.push([+m[1], +m[2]]);
  }
  return cleanPoints(pts);
}

/** In rising frequency, within 10 Hz–24 kHz and ±40 dB, one level per frequency. */
export function cleanPoints(pts: [number, number][]): [number, number][] {
  const out = pts
    .filter(([f, v]) => Number.isFinite(f) && Number.isFinite(v) && f >= 10 && f <= 24000)
    .map(([f, v]) => [f, Math.max(-40, Math.min(40, v))] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0]);
}

/**
 * Custom target curves: make one from scratch or starting from any target, as levels at frequencies (joined
 * smoothly on a log scale); import and export them as text. `onDone` gets the id of the target to use (or null).
 */
export function showTargetEditor(app: App, onDone?: (id: string | null) => void, current?: string): void {
  const s = app.settings;
  const fromCurrent = current?.startsWith(CUSTOM_PREFIX) ? s.customTargets.find((t) => CUSTOM_PREFIX + t.id === current) : undefined;
  let draft: CustomTarget = fromCurrent
    ? JSON.parse(JSON.stringify(fromCurrent))
    : { id: newId(), name: `My target ${s.customTargets.length + 1}`, points: START_FREQS.map((f) => [f, +(findTarget(current ?? '')?.at(f) ?? 0).toFixed(1)]) };

  const plot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -15, yMax: 15, yUnit: 'dB', yStep: 3, title: 'Target curve', yLimits: [-45, 45] });
  const name = h('input', { type: 'text', class: 'text', maxlength: '40', 'aria-label': 'Target name', dataset: { targetEdit: 'name' } }) as HTMLInputElement;
  name.addEventListener('input', () => (draft.name = name.value));
  const rows = h('div', { class: 'tgt-points', dataset: { targetEdit: 'points' } });
  const pickHost = h('span', {});
  const status = h('p', { class: 'dim small tgt-status' });

  const draw = () => {
    const c = customCurve(draft);
    const x = Array.from({ length: 241 }, (_, i) => 20 * Math.pow(1000, i / 240));
    const y = x.map((f) => c.at(f));
    const lo = Math.min(-6, ...y);
    const hi = Math.max(6, ...y);
    const yMin = Math.floor((lo - 3) / 3) * 3;
    const yMax = Math.ceil((hi + 3) / 3) * 3;
    if (plot.cfg.yMin !== yMin || plot.cfg.yMax !== yMax) plot.setDefaults({ yMin, yMax });
    plot.series = [{ id: 'tgt', label: draft.name, x, y, color: '#ffb020', width: 2.2 }];
    plot.pins = draft.points.map(([f, v]) => ({ x: f, y: v, label: '', color: CHART.warn }));
    plot.draw();
    status.textContent = draft.points.length < 2 ? 'Add at least two points.' : `${draft.points.length} points, joined smoothly; the level stays the same beyond the first and last point.`;
  };

  const renderRows = () => {
    rows.replaceChildren(
      h('div', { class: 'tgt-row tgt-head' }, h('span', {}, 'Frequency'), h('span', {}, 'Level'), h('span', {})),
      ...draft.points.map((p, i) => {
        const num = (k: 0 | 1, step: string, label: string, unit: string) => {
          const el = h('input', { type: 'number', class: 'num', value: String(p[k]), step, 'aria-label': `${label} of point ${i + 1}` }) as HTMLInputElement;
          el.addEventListener('change', () => {
            const v = +el.value;
            if (!Number.isFinite(v)) return void (el.value = String(p[k]));
            p[k] = v;
            draft.points = cleanPoints(draft.points);
            renderRows();
            draw();
          });
          return h('label', { class: 'tgt-cell' }, el, h('span', { class: 'unit' }, unit));
        };
        return h(
          'div',
          { class: 'tgt-row' },
          num(0, '1', 'Frequency', 'Hz'),
          num(1, '0.5', 'Level', 'dB'),
          h('button', { class: 'btn tiny ghost', title: 'Remove this point', 'aria-label': `Remove point ${i + 1}`, onclick: () => { draft.points.splice(i, 1); renderRows(); draw(); } }, icon('x', 12)),
        );
      }),
      h('button', { class: 'btn small ghost', dataset: { targetEdit: 'add-point' }, onclick: () => {
        // Halfway (on a log scale) into the widest gap, at the curve's level there
        const pts = draft.points;
        let at = 1000;
        let gap = 0;
        for (let i = 1; i < pts.length; i++) if (Math.log(pts[i][0] / pts[i - 1][0]) > gap) (gap = Math.log(pts[i][0] / pts[i - 1][0])), (at = Math.sqrt(pts[i][0] * pts[i - 1][0]));
        draft.points = cleanPoints([...pts, [Math.round(at), +customCurve(draft).at(at).toFixed(1)]]);
        renderRows();
        draw();
      } }, icon('plus', 13), 'Add point'),
    );
  };

  /** Which target the dialog edits: one of yours, or a new one. */
  const renderPick = () => {
    const opts = [...s.customTargets.map((t) => ({ value: t.id, label: t.name })), { value: '__new', label: 'New target' }];
    const saved = s.customTargets.some((t) => t.id === draft.id);
    pickHost.replaceChildren(
      select(opts, saved ? draft.id : '__new', (v) => {
        const t = s.customTargets.find((x) => x.id === v);
        draft = t ? JSON.parse(JSON.stringify(t)) : { id: newId(), name: `My target ${s.customTargets.length + 1}`, points: START_FREQS.map((f) => [f, 0]) };
        load();
      }, { 'aria-label': 'Target to edit', dataset: { targetEdit: 'pick' } }),
    );
    del.disabled = !saved;
  };

  const load = () => {
    name.value = draft.name;
    renderPick();
    renderRows();
    draw();
  };

  const startFrom = select(
    [{ value: '', label: 'Start from…' }, ...allTargets().map((t) => ({ value: t.id, label: t.label, title: t.note }))],
    '',
    (v) => {
      const t = findTarget(v);
      if (!t) return;
      draft.points = START_FREQS.map((f) => [f, +t.at(f).toFixed(1)]);
      startFrom.value = '';
      renderRows();
      draw();
    },
    { 'aria-label': 'Start from a target', title: 'Replace the points with another target’s shape, to change it from there', dataset: { targetEdit: 'start' } },
  );

  const file = h('input', { type: 'file', accept: '.txt,.csv,.json,.frd,text/plain,application/json', hidden: true, dataset: { targetEdit: 'file' } }) as HTMLInputElement;
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      let pts: [number, number][];
      let nm = f.name.replace(/\.(caltarget\.json|json|txt|csv|frd)$/i, '');
      if (/^\s*\{/.test(text)) {
        const j = JSON.parse(text) as { format?: string; name?: string; points?: [number, number][] };
        if (j.format !== 'cal-target' || !Array.isArray(j.points)) throw new Error('not a target file');
        pts = cleanPoints(j.points);
        nm = j.name || nm;
      } else pts = parseTargetText(text);
      if (pts.length < 2) throw new Error('no frequency / level pairs found');
      draft = { id: newId(), name: nm.slice(0, 40), points: pts };
      load();
      app.toast(`Imported “${draft.name}” (${pts.length} points): save it to keep it`, 'ok');
    } catch (e) {
      app.toast(`${f.name}: ${(e as Error).message}`, 'warn');
    }
  });

  const del = h('button', { class: 'btn small ghost', dataset: { targetEdit: 'delete' }, onclick: () => {
    if (!confirm(`Delete the target “${draft.name}”?`)) return;
    s.customTargets = s.customTargets.filter((t) => t.id !== draft.id);
    app.targetsChanged();
    draft = { id: newId(), name: `My target ${s.customTargets.length + 1}`, points: START_FREQS.map((f) => [f, 0]) };
    load();
  } }, icon('trash', 13), 'Delete');

  const body = h(
    'div',
    { class: 'tgt-editor' },
    h('p', { class: 'dim small' }, 'Your own target curve: a level at each frequency, joined smoothly. Start from any target and change it, type the points, or import a text file with one “frequency level” pair per line.'),
    h('div', { class: 'row gap8 wrap' }, pickHost, h('label', { class: 'cmp-field tgt-name' }, h('span', {}, 'Name'), name), startFrom),
    h('div', { class: 'tgt-body' }, h('div', { class: 'fir-plot tgt-plot' }, plot.el), rows),
    status,
    h(
      'div',
      { class: 'row gap8 wrap' },
      h('button', { class: 'btn small ghost', onclick: () => file.click() }, icon('upload', 13), 'Import…'),
      h('button', { class: 'btn small ghost', dataset: { targetEdit: 'export' }, onclick: () => {
        const lines = [`# ${draft.name} — target curve (frequency in Hz, level in dB)`, ...cleanPoints(draft.points).map(([f, v]) => `${f}\t${v}`)];
        downloadText(`${draft.name.replace(/[^\w\- ]+/g, '').trim() || 'target'}.txt`, lines.join('\n') + '\n', 'text/plain');
      } }, icon('download', 13), 'Export'),
      del,
      file,
    ),
  );

  const save = h('button', { class: 'btn accent', dataset: { targetEdit: 'save' }, onclick: () => {
    draft.points = cleanPoints(draft.points);
    if (draft.points.length < 2) return app.toast('A target needs at least two points', 'warn');
    draft.name = draft.name.trim() || 'My target';
    s.customTargets = [...s.customTargets.filter((t) => t.id !== draft.id), JSON.parse(JSON.stringify(draft))];
    app.targetsChanged();
    done = true;
    close();
    app.toast(`Target “${draft.name}” saved`, 'ok');
    onDone?.(CUSTOM_PREFIX + draft.id);
  } }, icon('check', 14), 'Save and use');
  let done = false;
  const { el, close } = modal('Custom target curves', body, [h('div', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Close'), save]);
  el.classList.add('fir-modal', 'tgt-modal');
  new MutationObserver((_, obs) => {
    if (el.isConnected) return;
    obs.disconnect();
    plot.dispose();
    if (!done) onDone?.(null);
  }).observe(document.body, { childList: true });
  load();
  requestAnimationFrame(() => {
    plot.resize();
    draw();
  });
}
