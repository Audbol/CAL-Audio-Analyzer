import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import type { Weighting } from '../dsp/weighting';

/** Sound level meter with Leq, Lmax, peak and a scrolling history graph. */
export class SplView implements View {
  id = 'spl' as const;
  title = 'SPL Meter';
  icon = 'clock' as const;
  el = h('div', { class: 'spl' });
  private big = h('div', { class: 'spl-big' });
  private stats = h('div', { class: 'spl-stats' });
  private history: Plot;
  private hist: { t: number; fast: number; leq: number }[] = [];
  private t0 = performance.now();
  private lastPush = 0;
  private chHost = h('span', {});

  constructor(private app: App) {
    const s = app.settings;
    this.history = new Plot({ xType: 'lin', xMin: -120, xMax: 0, yMin: 20, yMax: 120, yUnit: 'dB', xUnit: 's', yStep: 10, title: 'History (last 2 minutes)', yLimits: [-200, 200] });
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Channel'), this.chHost),
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Weighting'), select([{ value: 'A' as Weighting, label: 'A' }, { value: 'C' as Weighting, label: 'C' }, { value: 'Z' as Weighting, label: 'Z (flat)' }], s.splWeighting, (v) => { s.splWeighting = v; app.spl.setWeighting(v); app.save(); this.hist = []; })),
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Time'), select([{ value: 'fast' as const, label: 'Fast (125 ms)' }, { value: 'slow' as const, label: 'Slow (1 s)' }], s.splTime, (v) => { s.splTime = v; app.save(); })),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => { app.spl.resetLeq(); this.hist = []; this.t0 = performance.now(); } }, icon('reset', 14), 'Reset Leq / Max'),
        h('button', { class: 'btn small', onclick: () => app.setView('tools') }, icon('settings', 14), 'Calibrate…'),
      ),
      h('div', { class: 'spl-top' }, this.big, this.stats),
      h('div', { class: 'pane fill' }, this.history.el),
    );
  }

  show(): void {
    this.chHost.replaceChildren(
      select(this.app.channelOptions(false), this.app.settings.splChannel, (v) => {
        this.app.settings.splChannel = v;
        this.app.spl.resetLeq();
        this.app.save();
      }),
    );
  }

  tick(): void {
    const s = this.app.settings;
    const r = this.app.splReading;
    const unit = s.splCalibrated ? `dB(${s.splWeighting})` : `dBFS(${s.splWeighting})`;
    const run = this.app.engine.running && r;
    this.big.innerHTML = `<div class="val">${run ? r!.level.toFixed(1) : '—'}</div><div class="unit">${unit} · ${s.splTime === 'fast' ? 'Fast' : 'Slow'}</div>${s.splCalibrated ? '' : '<div class="warn-text small">Uncalibrated</div>'}`;
    const fmt = (v: number | undefined) => (run && v !== undefined && Number.isFinite(v) ? v.toFixed(1) : '—');
    const dur = r ? r.duration : 0;
    this.stats.innerHTML = [
      ['L<sub>eq</sub>', fmt(r?.leq), `over ${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`],
      ['L<sub>max</sub> (F)', fmt(r?.max), 'since reset'],
      ['Peak (Z)', fmt(r?.peakHold), r && r.peakHold > (s.splCalibrated ? s.splOffset - 1 : -1) ? '<span class="warn-text">near clipping</span>' : 'since reset'],
      ['Fast / Slow', `${fmt(r?.fast)} / ${fmt(r?.slow)}`, unit],
    ]
      .map(([k, v, sub]) => `<div class="stat"><span>${k}</span><b>${v}</b><em>${sub}</em></div>`)
      .join('');
    const now = (performance.now() - this.t0) / 1000;
    if (run && now - this.lastPush > 0.1) {
      this.lastPush = now;
      this.hist.push({ t: now, fast: r!.fast, leq: r!.leq });
      while (this.hist.length && this.hist[0].t < now - 120) this.hist.shift();
    }
    const x = this.hist.map((p) => p.t - now);
    this.history.series = [
      { id: 'lf', label: `L${s.splWeighting}F`, x, y: this.hist.map((p) => p.fast), color: '#2dd4bf', width: 1.4, fill: true },
      { id: 'leq', label: `L${s.splWeighting}eq`, x, y: this.hist.map((p) => p.leq), color: '#f59e0b', width: 1.6 },
    ];
    if (!s.splCalibrated && this.history.cfg.yMin > -20) this.history.setDefaults({ yMin: -100, yMax: 0 });
    if (s.splCalibrated && this.history.cfg.yMax < 60) this.history.setDefaults({ yMin: 20, yMax: 120 });
    this.history.draw();
  }
}
