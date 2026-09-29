import type { App } from './app';
import { refLabel } from './state';
import { Plot, escapeHtml, type PlotConfig, type Series, type Marker } from './ui/plot';
import { applyChartTheme, chartTheme, seriesColor } from './ui/theme';
import { targetDeviation, targetLevel, targetShape } from './dsp/target';
import { eqResponse, TARGETS } from './dsp/eq';
import { formatFreq } from './dsp/freq';
import { KIND_INFO, recommend, type AlignView } from './views/align';
import type { EqView } from './views/eq';
import type { RoomView } from './views/room';
import { downloadText, sessionFileName } from './session';
import { WaterfallPlot } from './ui/waterfall-plot';
import type { WaterfallResult } from './dsp/waterfall';

const TARGET_COLOR = '#ffb020';

interface Figure {
  img: string;
  legend: { label: string; color: string; dash?: boolean }[];
}

function view<T>(app: App, id: string): T {
  return app.views.find((v) => v.id === id) as unknown as T;
}

/** Draw a plot off screen in the day (print) scheme and return it as a PNG data URL with its legend. */
function figure(cfg: PlotConfig, series: Series[], opts: { fit?: boolean; maxSpan?: number; shades?: Plot['shades']; markers?: Marker[] } = {}): Figure {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:960px;height:360px;';
  const p = new Plot({ ...cfg, title: undefined, autoFit: false });
  p.forceDpr = 2;
  p.el.style.cssText = 'position:absolute;inset:0;';
  host.append(p.el);
  document.body.append(host);
  p.series = series;
  p.shades = opts.shades ?? [];
  p.markers = opts.markers ?? [];
  p.resize();
  if (opts.fit) {
    p.fitY();
    // Keep the top of the data in view with a readable scale (roll-offs would stretch it to −180 dB)
    const span = opts.maxSpan ?? 60;
    if (p.cfg.yMax - p.cfg.yMin > span) p.setY(p.cfg.yMax - span, p.cfg.yMax);
    p.draw();
  }
  const img = p.canvas.toDataURL('image/png');
  p.dispose();
  host.remove();
  const legend = series.filter((s) => s.label && !s.quiet).map((s) => ({ label: s.label, color: seriesColor(s.color.slice(0, 7)), dash: !!s.dash }));
  return { img, legend };
}

/** The waterfall drawn off screen (day scheme) as a PNG data URL. */
function waterfallImage(data: WaterfallResult): string {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:960px;height:420px;';
  const p = new WaterfallPlot();
  p.forceDpr = 2;
  p.el.style.cssText = 'position:absolute;inset:0;';
  host.append(p.el);
  document.body.append(host);
  p.data = data;
  p.resize();
  const img = p.canvas.toDataURL('image/png');
  p.dispose();
  host.remove();
  return img;
}

function figHtml(title: string, f: Figure, caption = ''): string {
  const legend = f.legend.map((l) => `<span class="lg"><i style="border-top:3px ${l.dash ? 'dashed' : 'solid'} ${l.color}"></i>${escapeHtml(l.label)}</span>`).join('');
  return `<figure><figcaption><b>${escapeHtml(title)}</b>${caption ? ` <span class="dim">${escapeHtml(caption)}</span>` : ''}</figcaption><img src="${f.img}" alt="${escapeHtml(title)}"><div class="legend">${legend}</div></figure>`;
}

const fmt = (v: number, d = 1, unit = '') => (Number.isFinite(v) ? `${v.toFixed(d)}${unit}` : '—');

/** The chosen target curve name, shape and tolerance (null when off). */
function targetInfo(app: App, freqs: ArrayLike<number>): { name: string; shape: Float64Array; tol: number } | null {
  const s = app.settings;
  const trace = s.targetCurve.startsWith('trace:') ? app.traces.traces.find((t) => t.id === s.targetCurve.slice(6)) : null;
  const shape = targetShape(s.targetCurve, freqs, trace);
  if (!shape) return null;
  const name = trace ? `Trace “${trace.name}”` : (TARGETS.find((t) => t.id === s.targetCurve)?.label ?? s.targetCurve);
  return { name, shape, tol: s.targetTolerance };
}

/** Target series (line and band) levelled to data, plus the levelled curve. */
function targetSeries(t: { shape: Float64Array; tol: number; name: string }, freqs: ArrayLike<number>, data: ArrayLike<number>, weight?: ArrayLike<number> | null): { series: Series[]; curve: Float64Array } | null {
  const lvl = targetLevel(freqs, data, t.shape, weight);
  if (lvl === null) return null;
  const curve = Float64Array.from(t.shape, (v) => v + lvl);
  const series: Series[] = [];
  if (t.tol > 0) series.push({ id: 'target-band', label: '', x: freqs, y: curve.map((v) => v + t.tol), band: curve.map((v) => v - t.tol), color: TARGET_COLOR, quiet: true });
  series.push({ id: 'target', label: `Target: ${t.name}${t.tol ? ` ±${t.tol} dB` : ''}`, x: freqs, y: curve, color: TARGET_COLOR, width: 1.8, dash: [7, 4] });
  return { series, curve };
}

export function buildReport(app: App): string {
  const prevTheme = chartTheme();
  applyChartTheme('day');
  try {
    return buildReportHtml(app);
  } finally {
    applyChartTheme(prevTheme);
  }
}

function buildReportHtml(app: App): string {
  const s = app.settings;
  const g = app.grid;
  const sess = s.session;
  const now = new Date();
  const running = app.engine.running;
  const sections: string[] = [];
  const spl = app.measurements.some((m) => m.cfg.enabled && app.isCalibrated(m.cfg.mic));

  // Setup -----------------------------------------------------------------------------------------------------
  const measRows = s.measurements
    .map((m, i) => {
      const live = app.measurements[i];
      const delayMs = live ? (m.delay / live.fs) * 1000 : m.delay / Math.max(1, app.fs || 48000) * 1000;
      return `<tr><td><i class="sw" style="background:${seriesColor(m.color)}"></i>${escapeHtml(m.name)}</td><td>In ${m.mic + 1}</td><td>${escapeHtml(refLabel(m.ref))}</td><td>${fmt(delayMs, 2, ' ms')}</td><td>${m.invert ? 'inverted' : 'normal'}</td><td>${m.enabled ? 'on' : 'off'}</td></tr>`;
    })
    .join('');
  sections.push(`<section><h2>Setup</h2>
    <table class="kv">
      <tr><th>Microphones</th><td>${
        s.mics.length
          ? s.mics
              .map((m) => `${escapeHtml(m.name)} on ${m.channel >= 0 ? `In ${m.channel + 1}` : '—'}: ${m.splCalibrated ? `SPL calibrated (0 dBFS = ${fmt(m.splOffset, 1, ' dB SPL')}${m.calibratedAt ? `, ${new Date(m.calibratedAt).toLocaleDateString()}` : ''})` : 'not SPL calibrated'}${m.micCal ? ` · correction “${escapeHtml(m.micCal.name)}”` : ''}`)
              .join('<br>')
          : 'No microphones set up (levels in dBFS, no correction)'
      }</td></tr>
      <tr><th>Temperature</th><td>${fmt(s.tempC, 1, ' °C')}</td></tr>
      <tr><th>Sample rate</th><td>${running ? `${app.fs} Hz` : '—'}</td></tr>
      <tr><th>Analysis</th><td>Transfer function 1/${s.tfSmoothing} oct, ${s.tfAveraging === 0 ? 'no' : s.tfAveraging} averages · RTA ${s.rtaSmoothing ? `1/${s.rtaSmoothing} oct` : 'narrow band'}, ${s.rtaFft / 1024}k FFT</td></tr>
    </table>
    <table class="grid"><tr><th>Measurement</th><th>Mic</th><th>Reference</th><th>Delay</th><th>Polarity</th><th>Shown</th></tr>${measRows}</table>
  </section>`);

  // Spectrum --------------------------------------------------------------------------------------------------
  {
    const series: Series[] = [];
    for (const t of app.traces.traces) {
      if (!t.visible || t.kind !== 'rta') continue;
      const add = t.offset + (t.dbfs ? app.splOffsetFor(t.channel ?? s.splChannel) : 0);
      series.push({ id: t.id, label: t.name, x: t.freqs, y: t.mag.map((v) => v + add), color: t.color, width: 1.4, dash: [5, 3] });
    }
    let ref: Float64Array | null = null;
    if (running) {
      for (const m of app.measurements) {
        if (!m.cfg.enabled || !m.rtaShown) continue;
        const avg = m.averageDb();
        const off = app.splOffsetFor(m.cfg.mic);
        const y = Float64Array.from(avg ?? m.rtaOut, (v) => v + off);
        ref ??= y;
        series.push({ id: m.cfg.id, label: `${m.cfg.name}${avg ? ' (average)' : ''}`, x: g, y, color: m.cfg.color, width: 1.8 });
      }
    }
    if (series.length) {
      const t = targetInfo(app, g);
      const ts = t && ref ? targetSeries(t, g, ref) : null;
      if (ts) series.unshift(...ts.series);
      const f = figure({ xType: 'log', xMin: 20, xMax: 20000, yMin: -100, yMax: 0, yUnit: spl ? 'dB SPL' : 'dBFS', yStep: 10 }, series, { fit: true });
      sections.push(`<section><h2>Spectrum</h2>${figHtml('Spectrum (RTA)', f, spl ? 'dB SPL' : 'dBFS')}</section>`);
    }
  }

  // Transfer function -----------------------------------------------------------------------------------------
  {
    const mag: Series[] = [];
    const ph: Series[] = [];
    const devRows: string[] = [];
    const t = targetInfo(app, g);
    let targetDone = false;
    const addDeviation = (name: string, freqs: ArrayLike<number>, data: ArrayLike<number>, coh: ArrayLike<number> | null) => {
      if (!t) return;
      const shape = freqs === g ? t.shape : targetShape(s.targetCurve, freqs, s.targetCurve.startsWith('trace:') ? app.traces.traces.find((x) => x.id === s.targetCurve.slice(6)) : null);
      if (!shape) return;
      const ts = targetSeries({ ...t, shape }, freqs, data, coh);
      if (!ts) return;
      if (!targetDone) {
        mag.unshift(...ts.series);
        targetDone = true;
      }
      const d = targetDeviation(freqs, data, ts.curve, t.tol || 3);
      if (d) devRows.push(`<tr><td>${escapeHtml(name)}</td><td>${fmt(d.rms, 1, ' dB')}</td><td>${Math.round(d.within * 100)}%</td><td>${d.worst.dev >= 0 ? '+' : ''}${fmt(d.worst.dev, 1, ' dB')} at ${formatFreq(d.worst.f)}</td></tr>`);
    };
    if (running) {
      for (const m of app.measurements) {
        if (!m.cfg.enabled || !m.tfReady) continue;
        const y = Float64Array.from(m.mag);
        mag.push({ id: m.cfg.id, label: m.cfg.name, x: g, y, color: m.cfg.color, width: 2 });
        ph.push({ id: m.cfg.id, label: m.cfg.name, x: g, y: Float64Array.from(m.phase), color: m.cfg.color, width: 1.6, wrap: 180 });
        addDeviation(m.cfg.name, g, y, m.result.coh);
      }
    }
    for (const tr of app.traces.traces) {
      if (!tr.visible || tr.kind === 'rta') continue;
      const y = tr.mag.map((v) => v + tr.offset);
      mag.push({ id: tr.id, label: tr.name, x: tr.freqs, y, color: tr.color, width: 1.4, dash: [5, 3] });
      if (tr.phase) ph.push({ id: tr.id, label: tr.name, x: tr.freqs, y: tr.phase, color: tr.color, width: 1.2, dash: [5, 3], wrap: 180 });
      if (s.targetCurve !== `trace:${tr.id}`) addDeviation(tr.name, tr.freqs, y, tr.coh ?? null);
    }
    if (mag.length) {
      const fm = figure({ xType: 'log', xMin: 20, xMax: 20000, yMin: -30, yMax: 18, yUnit: 'dB', yStep: 6 }, mag, { fit: true, maxSpan: 48 });
      const fp = ph.length ? figure({ xType: 'log', xMin: 20, xMax: 20000, yMin: -180, yMax: 180, yUnit: 'deg', yStep: 45 }, ph) : null;
      const dev = devRows.length
        ? `<table class="grid"><tr><th>Response vs target (40 Hz – 16 kHz)</th><th>RMS deviation</th><th>Within ±${t?.tol || 3} dB</th><th>Largest deviation</th></tr>${devRows.join('')}</table>`
        : '';
      sections.push(`<section><h2>Transfer function</h2>${figHtml('Magnitude', fm)}${dev}${fp ? figHtml('Phase', fp) : ''}</section>`);
    }
  }

  // Sweep & room ----------------------------------------------------------------------------------------------
  {
    const r = view<RoomView>(app, 'room').reportData();
    if (r) {
      const f = figure({ xType: 'log', xMin: 20, xMax: 20000, yMin: -30, yMax: 12, yUnit: 'dB', yStep: 6 }, [{ id: 'fr', label: 'Sweep frequency response', x: g, y: r.fr, color: '#00c8ff', width: 2 }], { fit: true });
      const cards = r.cards.map((c) => `<div class="card"><span>${escapeHtml(c.label)}</span><b>${escapeHtml(c.value)}</b><em>${escapeHtml(c.sub)}</em></div>`).join('');
      const wfData = view<RoomView>(app, 'room').waterfallData('bass');
      const wf = wfData ? waterfallImage(wfData) : null;
      sections.push(`<section><h2>Sweep &amp; room acoustics</h2>
        <p class="dim">${escapeHtml(`${r.spec.duration} s log sweep ${Math.round(r.spec.f1)} Hz – ${formatFreq(r.spec.f2)}, measured ${r.when.toLocaleString()} · ${r.window} ms window, 1/${r.smoothing} oct`)}</p>
        <div class="cards">${cards}</div>
        ${figHtml('Frequency response (level-normalised)', f)}
        <div class="rt">${r.tableHtml}</div>
        ${wf ? figHtml('Waterfall: room modes (cumulative spectral decay, 15–500 Hz)', { img: wf, legend: [] }, 'ridges reaching far back are modes that keep ringing') : ''}
      </section>`);
    }
  }

  // EQ --------------------------------------------------------------------------------------------------------
  {
    const e = view<EqView>(app, 'eq').snapshot();
    if (e) {
      const x = e.freqs;
      const before = e.before.map((v) => (v === null ? NaN : v));
      const eq = eqResponse(e.filters, x);
      const after = before.map((v, i) => (x[i] < e.opt.fMin || x[i] > e.opt.fMax ? NaN : v + eq[i]));
      const f = figure({ xType: 'log', xMin: 20, xMax: 20000, yMin: -18, yMax: 18, yUnit: 'dB', yStep: 3 }, [
        { id: 'before', label: 'Measured − target', x, y: before, color: '#8a94a6', width: 1.4 },
        { id: 'eq', label: 'EQ curve', x, y: eq, color: '#ffb020', width: 2 },
        { id: 'after', label: 'Predicted result', x, y: after, color: '#00c8ff', width: 2 },
      ], { markers: e.filters.map((fl, i) => ({ x: fl.f, color: '#ffb020', label: String(i + 1) })) });
      const rows = e.filters.map((fl, i) => `<tr><td>${i + 1}</td><td>${fl.type === 'peak' ? 'Peak' : fl.type === 'lowshelf' ? 'Low shelf' : 'High shelf'}</td><td>${fmt(fl.f, 1, ' Hz')}</td><td>${fl.gain >= 0 ? '+' : ''}${fmt(fl.gain, 1, ' dB')}</td><td>${fmt(fl.q, 2)}</td></tr>`).join('');
      sections.push(`<section><h2>EQ</h2>
        <p>Source “${escapeHtml(e.source)}” → target ${escapeHtml(e.targetLabel)}, ${Math.round(e.opt.fMin)} Hz – ${formatFreq(e.opt.fMax)}. RMS deviation ${fmt(e.rmsBefore, 1, ' dB')} → <b>${fmt(e.rmsAfter, 1, ' dB')}</b>.</p>
        ${figHtml('Deviation, EQ and predicted result', f)}
        ${rows ? `<table class="grid"><tr><th>#</th><th>Type</th><th>Frequency</th><th>Gain</th><th>Q</th></tr>${rows}</table>` : '<p>No filters.</p>'}
      </section>`);
    }
  }

  // Alignment -------------------------------------------------------------------------------------------------
  {
    const av = view<AlignView>(app, 'align');
    const done = av.elements.filter((e) => e.result);
    if (done.length) {
      const pct = (v: number) => `${Math.round(v * 100)}%`;
      const rows = done
        .map((e) => {
          const r = e.result!;
          const rec = recommend(e, r, s.tempC);
          return `<tr><td>${escapeHtml(e.name)}</td><td>${escapeHtml(KIND_INFO[e.kind].label)}</td><td><b>${escapeHtml(rec.action)}</b>${rec.where === 'impossible' ? ' ⚠' : ''}</td><td>${escapeHtml(rec.polarity)}</td><td>${e.kind === 'sub' ? `${Math.round(r.crossover)} Hz crossover` : `${r.levelDb >= 0 ? '+' : ''}${fmt(r.levelDb, 1, ' dB')} vs mains`}</td><td>${pct(r.before)} → ${pct(r.after)}</td></tr>`;
        })
        .join('');
      const figs = done
        .map((e) => {
          const r = e.result!;
          const sub = e.kind === 'sub';
          const shades = [{ x0: r.region[0], x1: r.region[1], color: 'rgba(0,160,90,0.08)' }];
          const markers = sub ? [{ x: r.crossover, label: `${Math.round(r.crossover)} Hz`, color: '#00a05a' }] : [];
          const f = figure({ xType: 'log', xMin: 20, xMax: sub ? 1000 : 20000, yMin: -30, yMax: 12, yUnit: 'dB', yStep: 6 }, [
            { id: 'main', label: 'Mains', x: r.freqs, y: r.mainDb, color: '#4da3ff', width: 1.6 },
            { id: 'sub', label: e.name, x: r.freqs, y: r.subDb, color: '#ff6b6b', width: 1.6 },
            { id: 'before', label: 'Sum as measured', x: r.freqs, y: r.sumBeforeDb, color: '#9aa4b2', width: 1.4, dash: [5, 3] },
            { id: 'after', label: 'Sum aligned', x: r.freqs, y: r.sumAfterDb, color: '#3ddc84', width: 2.4 },
          ], { fit: true, maxSpan: 42, shades, markers });
          return figHtml(`${e.name}: magnitude with the mains`, f, e.names ? `${e.names.main} / ${e.names.sub}` : '');
        })
        .join('');
      sections.push(`<section><h2>System alignment</h2>
        <p class="dim">Each part aligned to the mains, measured alone at the position where it meets the mains.${done.some((e) => e.kind !== 'sub' && e.precedenceMs) ? ' Fill and delay settings include the chosen precedence (arriving a little after the mains).' : ''}</p>
        <table class="grid"><tr><th>Part</th><th>Type</th><th>Setting</th><th>Polarity</th><th>At the position</th><th>Summation</th></tr>${rows}</table>
        ${figs}
      </section>`);
    }
  }

  // Noise log -------------------------------------------------------------------------------------------------
  {
    const lg = app.logger;
    const sum = lg.summary();
    if (sum) {
      const unit = lg.calibrated ? 'dB' : 'dBFS';
      const w = lg.weighting;
      const x = lg.rows.map((r) => (r.t - lg.started) / 60000);
      const span = Math.max(1, x[x.length - 1]);
      const series: Series[] = [
        { id: 'lmax', label: `L${w}Fmax`, x, y: lg.rows.map((r) => r.max), color: '#a64b00', width: 1.2, dash: [3, 3] },
        { id: 'leq', label: `L${w}eq per ${lg.config.interval >= 60 ? `${lg.config.interval / 60} min` : `${lg.config.interval} s`}`, x, y: lg.rows.map((r) => r.leq), color: '#0047c2', width: 2 },
      ];
      if (lg.config.limit) series.push({ id: 'limit', label: `Limit ${lg.config.limit} ${unit} (L${w}eq,${lg.config.window}min)`, x: [0, span], y: [lg.config.limit, lg.config.limit], color: '#d0021b', width: 1.6, dash: [8, 4] });
      const start = new Date(lg.started);
      const f = figure(
        { xType: 'lin', xMin: 0, xMax: span, yMin: 40, yMax: 120, yUnit: unit, xUnit: 'min', yStep: 10, formatX: (m) => { const t = new Date(lg.started + m * 60000); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; } },
        series,
        { fit: true, maxSpan: 60 },
      );
      const hms = (secs: number) => `${Math.floor(secs / 3600)} h ${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')} min`;
      sections.push(`<section><h2>Noise log</h2>
        <table class="kv">
          <tr><th>Period</th><td>${start.toLocaleString()} · ${hms(sum.duration)} logged</td></tr>
          <tr><th>Overall L<sub>${w}eq</sub></th><td>${fmt(sum.leq, 1, ` ${unit}`)}</td></tr>
          <tr><th>Highest L<sub>${w}Fmax</sub></th><td>${fmt(sum.max, 1, ` ${unit}`)}</td></tr>
          ${lg.config.limit ? `<tr><th>Limit</th><td>${lg.config.limit} ${unit} L<sub>${w}eq</sub> over ${lg.config.window} min · intervals above it: ${sum.overMinutes.toFixed(1)} min</td></tr>` : ''}
        </table>
        ${figHtml('Level over time', f)}
      </section>`);
    }
  }

  // Traces ----------------------------------------------------------------------------------------------------
  if (app.traces.traces.length) {
    const kind = { tf: 'Transfer function', rta: 'Spectrum', sweep: 'Sweep' } as const;
    const rows = app.traces.traces.map((t) => `<tr><td><i class="sw" style="background:${seriesColor(t.color)}"></i>${escapeHtml(t.name)}</td><td>${kind[t.kind]}</td><td>${new Date(t.created).toLocaleString()}</td><td>${t.offset ? `${t.offset > 0 ? '+' : ''}${t.offset} dB` : ''}</td><td>${escapeHtml(t.note ?? '')}</td></tr>`).join('');
    // Photos of the measurement positions
    const photos = app.traces.traces
      .filter((t) => t.photo?.startsWith('data:image/'))
      .map((t) => `<figure class="photo"><img src="${escapeHtml(t.photo!)}" alt="${escapeHtml(t.name)}"><figcaption><b>${escapeHtml(t.name)}</b>${t.note ? ` · ${escapeHtml(t.note)}` : ''}</figcaption></figure>`)
      .join('');
    sections.push(`<section><h2>Stored traces</h2><table class="grid"><tr><th>Name</th><th>Type</th><th>Captured</th><th>Offset</th><th>Note</th></tr>${rows}</table>${photos ? `<h3>Measurement positions</h3><div class="photos">${photos}</div>` : ''}</section>`);
  }

  if (sess.notes.trim()) sections.push(`<section><h2>Notes</h2><p class="notes">${escapeHtml(sess.notes)}</p></section>`);

  const title = sess.name || 'Measurement report';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}${sess.venue ? ` · ${escapeHtml(sess.venue)}` : ''}</title>
<style>${REPORT_CSS}</style></head>
<body>
<div class="bar noprint"><button id="print">Print / save as PDF</button><button id="save">Download .html</button></div>
<header>
  <div class="logo">CAL</div>
  <div><h1>${escapeHtml(title)}</h1>
  <p class="dim">${sess.venue ? `${escapeHtml(sess.venue)} · ` : ''}${now.toLocaleString()} · CAL Audio Analyzer ${escapeHtml(__APP_VERSION__)}</p></div>
</header>
${sections.join('\n')}
${sections.length <= 1 ? '<p class="dim">No measurements yet: start audio, capture traces, run a sweep, EQ or alignment, then create the report again.</p>' : ''}
</body></html>`;
}

/** Build the report and open it in a new window (or download it when pop-ups are blocked). */
export function openReport(app: App): void {
  let html: string;
  try {
    html = buildReport(app);
  } catch (e) {
    app.toast(`Could not create the report: ${(e as Error).message}`, 'warn');
    return;
  }
  const name = sessionFileName(app.settings.session, 'report.html');
  const win = window.open('', '_blank');
  if (!win) {
    downloadText(name, html, 'text/html');
    app.toast('Report downloaded (allow pop-ups to open it directly)', 'ok');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.document.getElementById('print')?.addEventListener('click', () => win.print());
  win.document.getElementById('save')?.addEventListener('click', () => downloadText(name, html, 'text/html'));
  app.lastReport = html;
}

const REPORT_CSS = `
*{box-sizing:border-box}
body{font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;background:#fff;margin:0 auto;max-width:1000px;padding:24px}
h1{font-size:24px;margin:0}
h2{font-size:17px;margin:0 0 10px;padding-bottom:4px;border-bottom:2px solid #111}
section{margin:26px 0;break-inside:auto}
figure{margin:12px 0;break-inside:avoid}
figure img{width:100%;height:auto;border:1px solid #ccc;border-radius:4px;display:block}
figcaption{margin-bottom:4px}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;margin-top:4px}
.lg{display:inline-flex;align-items:center;gap:6px}
.lg i{display:inline-block;width:22px}
.dim{color:#555}
header{display:flex;gap:14px;align-items:center;border-bottom:3px solid #111;padding-bottom:12px}
.logo{font-weight:800;font-size:18px;background:#111;color:#fff;border-radius:6px;padding:8px 10px;letter-spacing:.05em}
table{border-collapse:collapse;margin:10px 0;font-size:13px}
table.grid{width:100%}
table.grid th,table.grid td{border:1px solid #ccc;padding:4px 8px;text-align:left}
table.grid th{background:#f0f0f0}
table.kv th{text-align:left;padding:2px 16px 2px 0;font-weight:600;vertical-align:top}
table.kv td{padding:2px 0}
.rt table{width:100%}
.rt th,.rt td{border:1px solid #ccc;padding:3px 6px;text-align:center;font-variant-numeric:tabular-nums}
.rt td.bb{font-weight:700}
.rt .dim{color:#999}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:baseline}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:10px 0}
.card{border:1px solid #ccc;border-radius:6px;padding:6px 10px;display:flex;flex-direction:column}
.card span,.card em{font-size:11px;color:#555;font-style:normal}
.card b{font-size:18px}
.notes{white-space:pre-wrap}
h3{font-size:14px;margin:14px 0 6px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
figure.photo img{border-radius:6px;max-height:260px;object-fit:cover}
figure.photo figcaption{font-size:12px;margin-top:4px}
.bar{position:sticky;top:0;display:flex;gap:8px;justify-content:flex-end;padding:8px 0;background:#fff}
.bar button{font:inherit;padding:6px 12px;border:1px solid #111;border-radius:6px;background:#111;color:#fff;cursor:pointer}
.bar button+button{background:#fff;color:#111}
@media print{.noprint{display:none}body{padding:0;max-width:none}section{margin:18px 0}}
`;
