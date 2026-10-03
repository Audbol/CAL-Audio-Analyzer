import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot, type Series } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import type { DockLayout } from '../ui/dock';
import { DockedView } from './docked';
import { optionsMenu, optHead } from '../ui/popover';
import type { Weighting } from '../dsp/weighting';
import type { SplReading } from '../dsp/spl';

export function defaultSplLayout(): DockLayout {
  return { order: ['meter', 'history', 'log'], sizes: { meter: 0.62, history: 1, log: 1.15 }, hidden: [], floating: {} };
}

/**
 * Sound level meter with Leq, Lmax, peak, a 2-minute history and the noise log. Each of the three is a panel:
 * rearrange, resize, float or detach them (e.g. the level readout on a second screen) like on the Spectrum tab.
 */
export class SplView extends DockedView implements View {
  id = 'spl' as const;
  title = 'SPL';
  icon = 'clock' as const;
  private big = h('div', { class: 'spl-big' });
  private stats = h('div', { class: 'spl-stats' });
  private history: Plot;
  private histDirty = true;
  private weightSel: HTMLSelectElement | null = null;
  private chHost = h('span', {});
  private logPlot!: Plot;
  private logBtn = h('button', { class: 'btn small accent', dataset: { log: 'toggle' } });
  private logStatus = h('div', { class: 'log-status' });
  private logVersion = -1;
  private logSpan = 10;

  constructor(app: App) {
    super(app, 'splLayout', defaultSplLayout);
    this.el.classList.add('spl');
    const s = app.settings;
    this.history = new Plot({ xType: 'lin', xMin: -120, xMax: 0, yMin: 20, yMax: 120, yUnit: 'dB', xUnit: 's', yStep: 10, title: 'History (last 2 minutes)', yLimits: [-200, 200] });
    const logToolbar = this.logToolbar();
    const options = optionsMenu(
      [
        optHead('Panels'),
        h('div', { class: 'opt-ctl' }, this.panelChip('meter', 'Sound level', 'sound level'), this.panelChip('history', 'History', 'history'), this.panelChip('log', 'Noise log', 'noise log')),
        optHead('Layout'),
        h('div', { class: 'opt-ctl' }, this.resetLayoutButton()),
      ],
      { title: 'SPL options: panels and layout', id: 'spl' },
    );
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Channel'), this.chHost),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Weighting'), (this.weightSel = select([{ value: 'A' as Weighting, label: 'A' }, { value: 'C' as Weighting, label: 'C' }, { value: 'Z' as Weighting, label: 'Z (flat)' }], s.splWeighting, (v) => { s.splWeighting = v; app.spl.setWeighting(v); app.save(); }, { dataset: { setting: 'splWeighting' } }) as HTMLSelectElement)),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Time'), select([{ value: 'fast' as const, label: 'Fast (125 ms)' }, { value: 'slow' as const, label: 'Slow (1 s)' }], s.splTime, (v) => { s.splTime = v; app.save(); }, { dataset: { setting: 'splTime' } })),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => app.spl.resetLeq() }, icon('reset', 14), 'Reset Leq / Max'),
      h('button', { class: 'btn small', onclick: () => app.openTools('setup') }, icon('settings', 14), 'Calibrate…'),
      options,
    );
    this.mountDock(
      [
        // The readout scales with its panel (CSS container units): resize, float or detach it and the text follows
        { id: 'meter', title: 'Sound level', body: h('div', { class: 'spl-fit' }, h('div', { class: 'spl-top' }, this.big, this.stats)) },
        this.plotPanel('history', 'History (2 min)', this.history),
        { id: 'log', title: 'Noise log', body: h('div', { class: 'spl-log' }, logToolbar, this.logStatus, h('div', { class: 'pane-fill' }, this.logPlot.el)), onResize: () => this.logPlot.resize() },
      ],
      toolbar,
    );
    this.renderLogButton();
  }

  invalidate(): void {
    this.histDirty = true;
    this.logVersion = -1;
    this.shownKey = '';
  }

  /** Noise log controls: start / stop, interval, limit and rolling window, export. */
  private logToolbar(): HTMLElement {
    const app = this.app;
    const lg = app.logger;
    this.logPlot = new Plot({
      xType: 'lin',
      xMin: 0,
      xMax: 10,
      yMin: 40,
      yMax: 120,
      yUnit: 'dB',
      xUnit: 'min',
      yStep: 10,
      title: 'Noise log: Leq and Lmax per interval',
      yLimits: [-200, 200],
      formatX: (x) => {
        const t = new Date((lg.started || Date.now()) + x * 60000);
        const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        return this.logSpan < 10 ? `${hm}:${String(t.getSeconds()).padStart(2, '0')}` : hm;
      },
    });
    this.logBtn.addEventListener('click', () => {
      if (lg.running) lg.stop();
      else {
        if (!app.engine.running) return app.toast('Start audio first, then start logging.', 'warn');
        lg.start(app.spl, app.settings.splWeighting, app.settings.splCalibrated);
        if (!app.settings.splCalibrated) app.toast('Logging uncalibrated levels (dBFS). Calibrate the mic in Tools for dB SPL.', 'info');
      }
      this.renderLogButton();
      this.logVersion = -1;
    });
    const limit = h('input', { type: 'number', class: 'num', value: String(lg.config.limit || ''), placeholder: 'none', step: '0.5', title: 'Level limit (dB); empty = none', dataset: { log: 'limit' } });
    limit.addEventListener('change', () => {
      lg.config.limit = +limit.value || 0;
      lg.save();
      this.logVersion = -1;
    });
    return h(
      'div',
      { class: 'toolbar wrap log-bar' },
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Noise log'), this.logBtn),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'Every'),
        select(
          [
            { value: 1, label: '1 s' },
            { value: 10, label: '10 s' },
            { value: 60, label: '1 min' },
            { value: 300, label: '5 min' },
            { value: 900, label: '15 min' },
          ],
          lg.config.interval,
          (v) => lg.setInterval(v),
          { title: 'Logging interval: one Leq / Lmax row per interval', dataset: { log: 'interval' } },
        ),
      ),
      h(
        'div',
        { class: 'tb-group' },
        h('span', { class: 'tb-label' }, 'Limit'),
        limit,
        h('span', { class: 'unit' }, 'dB over'),
        select(
          [1, 5, 10, 15, 30, 60].map((v) => ({ value: v, label: `${v} min` })),
          lg.config.window,
          (v) => {
            lg.config.window = v;
            lg.save();
            this.logVersion = -1;
          },
          { title: 'The limit applies to the rolling Leq over this time', dataset: { log: 'window' } },
        ),
      ),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => this.exportLog() }, icon('download', 14), 'Export log CSV'),
      h('button', { class: 'btn small ghost', onclick: () => {
        if (lg.rows.length && !confirm('Clear the noise log?')) return;
        lg.clear();
        this.logVersion = -1;
      } }, icon('trash', 14), 'Clear'),
    );
  }

  private renderLogButton(): void {
    const on = this.app.logger.running;
    this.logBtn.replaceChildren(icon(on ? 'stop' : 'play', 14), on ? 'Stop logging' : 'Start logging');
    this.logBtn.classList.toggle('accent', !on);
    this.logBtn.classList.toggle('rec', on);
  }

  private exportLog(): void {
    const lg = this.app.logger;
    if (!lg.rows.length) return this.app.toast('The noise log is empty.', 'warn');
    const url = URL.createObjectURL(new Blob([lg.toCsv()], { type: 'text/csv' }));
    const d = new Date(lg.started);
    const a = h('a', { href: url, download: `noise-log-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Status line and log graph (the graph redraws when a row is added). */
  private tickLog(): void {
    const lg = this.app.logger;
    if (this.logBtn.classList.contains('rec') !== lg.running) this.renderLogButton();
    const unit = lg.calibrated ? 'dB' : 'dBFS';
    const w = lg.weighting;
    const sum = lg.summary();
    const roll = lg.rolling();
    const parts: string[] = [];
    if (lg.running || lg.rows.length) {
      const el = ((lg.running ? Date.now() : (lg.rows[lg.rows.length - 1]?.t ?? lg.started)) - lg.started) / 1000;
      parts.push(`${lg.running ? '<span class="rec-dot"></span>Logging' : 'Stopped'} · ${Math.floor(el / 3600)}:${String(Math.floor((el % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(el % 60)).padStart(2, '0')} · ${lg.rows.length} rows`);
      if (Number.isFinite(roll)) parts.push(`L<sub>${w}eq,${lg.config.window}min</sub> <b class="log-${lg.state}">${roll.toFixed(1)} ${unit}</b>${lg.config.limit ? ` / limit ${lg.config.limit}` : ''}`);
      if (sum) parts.push(`Overall L<sub>${w}eq</sub> <b>${sum.leq.toFixed(1)}</b> · L<sub>${w}Fmax</sub> <b>${Number.isFinite(sum.max) ? sum.max.toFixed(1) : '—'}</b>${lg.config.limit ? ` · over the limit ${sum.overMinutes.toFixed(1)} min` : ''}`);
    } else parts.push('Log Leq, Lmax and the third-octave spectrum over hours, with a level limit and alarms. Press Start logging.');
    const html = parts.join(' &nbsp;·&nbsp; ');
    if (this.logStatus.innerHTML !== html) this.logStatus.innerHTML = html;
    if (lg.version === this.logVersion) return;
    this.logVersion = lg.version;
    const x = lg.rows.map((r) => (r.t - lg.started) / 60000);
    // At least 20 intervals wide, so a new log isn't squeezed against the left edge
    const span = Math.max((lg.config.interval * 20) / 60, x.length ? x[x.length - 1] : 0);
    this.logSpan = span;
    this.logPlot.setDefaults({ xMin: 0, xMax: span * 1.02 });
    const series: Series[] = [
      { id: 'lmax', label: `L${w}Fmax`, x, y: lg.rows.map((r) => r.max), color: CHART.warn, width: 1.2, dash: [3, 3] },
      { id: 'leq', label: `L${w}eq`, x, y: lg.rows.map((r) => r.leq), color: CHART.accent, width: 2, fill: true },
    ];
    if (lg.config.limit) series.push({ id: 'limit', label: 'Limit', x: [0, span * 1.02], y: [lg.config.limit, lg.config.limit], color: '#ff4d5e', width: 1.6, dash: [8, 4] });
    this.logPlot.series = series;
    if (lg.calibrated && this.logPlot.cfg.yMax < 60) this.logPlot.setDefaults({ yMin: 30, yMax: 120 });
    if (!lg.calibrated && this.logPlot.cfg.yMin > -20) this.logPlot.setDefaults({ yMin: -100, yMax: 0 });
    this.logPlot.draw();
  }

  show(): void {
    this.chHost.replaceChildren(
      select(this.app.channelOptions(false), this.app.settings.splChannel, (v) => {
        this.app.settings.splChannel = v;
        this.app.syncCal(); // the meter uses the calibration of the mic on this input
        this.app.spl.resetLeq();
        this.app.save();
      }),
    );
  }

  /** While the noise log runs the weighting stays fixed, so every row of the log uses the same one. */
  private lockWeighting(): void {
    const sel = this.weightSel;
    if (!sel) return;
    const lock = this.app.logger.running;
    if (sel.disabled !== lock) {
      sel.disabled = lock;
      sel.title = lock ? 'Fixed while the noise log is running (stop logging to change it)' : 'Frequency weighting';
    }
    // The input (and so the mic and its calibration) stays fixed too
    const ch = this.chHost.querySelector('select');
    if (ch && ch.disabled !== lock) {
      ch.disabled = lock;
      ch.title = lock ? 'Fixed while the noise log is running (stop logging to change it)' : 'Input measured by the SPL meter';
    }
  }

  private shownReading: SplReading | null = null;
  private shownKey = '';
  private histCount = -1;

  tick(detachedOnly = false): void {
    this.detachedOnly = detachedOnly;
    const s = this.app.settings;
    // Numbers: the app's steady 4-per-second reading (never the frame rate)
    const r = this.app.splDisplay;
    const run = this.app.engine.running && r;
    // Rebuilt only when the reading or what it is shown in changed (not every frame while audio is stopped)
    const shownKey = `${!!run}|${s.splCalibrated}|${s.splOffset}|${s.splWeighting}|${s.splTime}`;
    if (this.visible('meter') && (r !== this.shownReading || shownKey !== this.shownKey)) {
      this.shownReading = r;
      this.shownKey = shownKey;
      const unit = s.splCalibrated ? `dB(${s.splWeighting})` : `dBFS(${s.splWeighting})`;
      this.big.innerHTML = `<div class="val">${run ? r!.level.toFixed(1) : '—'}</div><div class="unit">${unit} · ${s.splTime === 'fast' ? 'Fast' : 'Slow'}</div>${s.splCalibrated ? '' : '<div class="warn-text small">Uncalibrated</div>'}`;
      const fmt = (v: number | undefined) => (run && v !== undefined && Number.isFinite(v) ? v.toFixed(1) : '—');
      const dur = r ? r.duration : 0;
      this.stats.innerHTML = [
        ['L<sub>eq</sub>', fmt(r?.leq), `over ${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`],
        ['L<sub>max</sub> (F)', fmt(r?.max), 'since reset'],
        ['Peak (Z)', fmt(r?.peakHold), r && r.peakHold > (s.splCalibrated ? s.splOffset - 1 : -1) ? '<span class="warn-text">near clipping</span>' : 'since reset'],
        // The other time weighting than the big readout's (one number per card, so it fits when the panel shrinks)
        s.splTime === 'fast' ? ['Slow (1 s)', fmt(r?.slow), unit] : ['Fast (125 ms)', fmt(r?.fast), unit],
      ]
        .map(([k, v, sub]) => `<div class="stat"><span>${k}</span><b>${v}</b><em>${sub}</em></div>`)
        .join('');
    }
    // History: recorded by the meter every 100 ms of audio; redraw when a point was added
    const meter = this.app.spl;
    if (meter.historyCount !== this.histCount) {
      this.histCount = meter.historyCount;
      const hs = meter.history();
      this.history.series = [
        { id: 'lf', label: `L${s.splWeighting}F`, x: hs.t, y: hs.fast, color: CHART.accent, width: 1.4, fill: true },
        { id: 'leq', label: `L${s.splWeighting}eq (100 ms)`, x: hs.t, y: hs.leq, color: CHART.warn, width: 1.6 },
      ];
      this.histDirty = true;
    }
    if (!s.splCalibrated && this.history.cfg.yMin > -20) this.history.setDefaults({ yMin: -100, yMax: 0 });
    if (s.splCalibrated && this.history.cfg.yMax < 60) this.history.setDefaults({ yMin: 20, yMax: 120 });
    this.lockWeighting();
    if (this.visible('history') && this.histDirty) {
      this.history.draw();
      this.histDirty = false;
    }
    if (this.visible('log')) this.tickLog();
  }
}
