import { CHART, BAND_COLORS } from '../ui/theme';
import type { App, View } from '../app';
import { Plot, escapeHtml } from '../ui/plot';
import { h, icon, select, clear } from '../ui/dom';
import { logSweep, deconvolve, linearIR, harmonicDistortion, spectrumOf, type SweepSpec, type Deconvolution } from '../dsp/sweep';
import { roomAcoustics, energyTimeCurve, schroederFrequency, type AcousticsResult, type BandAcoustics } from '../dsp/acoustics';
import { LogSmoother, type Smoothing } from '../dsp/freq';
import { nextPow2 } from '../dsp/fft';

interface SweepResult {
  spec: SweepSpec;
  d: Deconvolution;
  ir: Float64Array;
  t0: number;
  fr: Float64Array;
  thd: Float64Array;
  h2: Float64Array;
  h3: Float64Array;
  acoustics: AcousticsResult;
  etc: Float64Array;
  peakDb: number;
  noiseDb: number;
  channel: number;
  when: Date;
}

/**
 * Log-sweep measurement: impulse response, frequency response, harmonic distortion and ISO 3382 room acoustic
 * parameters (EDT, T20, T30, C50, C80, D50, Ts) per octave or third-octave band.
 */
export class RoomView implements View {
  id = 'room' as const;
  title = 'Sweep & Room';
  icon = 'home' as const;
  el = h('div', { class: 'room' });
  private opts = { duration: 4, level: -12, repeats: 1, f1: 20, f2: 20000, fraction: 1 as 1 | 3, window: 500, smoothing: 6 as Smoothing, measIdx: 0 };
  private running: { cancelled: boolean } | null = null;
  private progress = h('div', { class: 'progress' }, h('i', {}));
  private statusText = h('span', { class: 'dim' }, 'Ready.');
  private measureBtn!: HTMLButtonElement;
  private result: SweepResult | null = null;
  private fr: Plot;
  private irPlot: Plot;
  private decay: Plot;
  private table = h('div', { class: 'rt-table' });
  private cards = h('div', { class: 'cards' });
  private tab: 'fr' | 'ir' | 'rt' = 'fr';
  private tabHost = h('div', { class: 'subtabs' });
  private content = h('div', { class: 'room-content' });
  private selHost = h('span', {});
  private dirty = true;

  constructor(private app: App) {
    this.fr = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -50, yMax: 10, yUnit: 'dB', yStep: 6, title: 'Frequency response & harmonic distortion', showNote: true, yLimits: [-200, 100] });
    this.irPlot = new Plot({ xType: 'lin', xMin: -5, xMax: 300, yMin: -90, yMax: 3, yUnit: 'dB', xUnit: 'ms', yStep: 10, title: 'Energy-time curve', yLimits: [-200, 20] });
    this.decay = new Plot({ xType: 'lin', xMin: 0, xMax: 1500, yMin: -70, yMax: 2, yUnit: 'dB', xUnit: 'ms', yStep: 10, title: 'Schroeder decay curves', yLimits: [-200, 20] });
    this.build();
  }

  private build(): void {
    const o = this.opts;
    this.measureBtn = h('button', { class: 'btn accent big', onclick: () => (this.running ? this.cancel() : this.measure()) });
    this.setMeasureLabel();
    const lvl = h('input', { type: 'number', class: 'num', value: String(o.level), min: '-60', max: '0', step: '1' });
    lvl.addEventListener('change', () => (o.level = Math.min(0, Math.max(-60, +lvl.value))));
    const settings = h(
      'div',
      { class: 'toolbar wrap' },
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Measurement'), this.selHost),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Sweep'), select([1, 2, 4, 8, 16].map((v) => ({ value: v, label: `${v} s` })), o.duration, (v) => (o.duration = v))),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Level'), lvl, h('span', { class: 'unit' }, 'dBFS')),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Repeats'), select([1, 2, 4, 8].map((v) => ({ value: v, label: `${v}×` })), o.repeats, (v) => (o.repeats = v))),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Range'), select([{ value: 20, label: '20 Hz' }, { value: 10, label: '10 Hz' }, { value: 40, label: '40 Hz' }, { value: 80, label: '80 Hz' }], o.f1, (v) => (o.f1 = v)), select([{ value: 20000, label: '20 kHz' }, { value: 16000, label: '16 kHz' }, { value: 10000, label: '10 kHz' }, { value: 1000, label: '1 kHz (sub)' }], o.f2, (v) => (o.f2 = v))),
      h('div', { class: 'spacer' }),
      this.measureBtn,
    );
    const analysis = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'FR window'), select([{ value: 5, label: '5 ms (gated)' }, { value: 20, label: '20 ms' }, { value: 100, label: '100 ms' }, { value: 500, label: '500 ms' }, { value: 2000, label: 'Full' }], o.window, (v) => { o.window = v; this.recompute(); })),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Smoothing'), select([48, 24, 12, 6, 3, 1].map((v) => ({ value: v as Smoothing, label: `1/${v} oct` })), o.smoothing, (v) => { o.smoothing = v; this.recompute(); })),
      h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Bands'), select([{ value: 1 as const, label: 'Octave' }, { value: 3 as const, label: '1/3 octave' }], o.fraction, (v) => { o.fraction = v; this.recompute(true); })),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => this.saveTrace(), title: 'Store the frequency response as a trace' }, icon('camera', 14), 'Save FR as trace'),
      h('button', { class: 'btn small', onclick: () => this.exportIr(), title: 'Download the impulse response as a WAV file' }, icon('download', 14), 'IR .wav'),
    );
    const bar = h('div', { class: 'progress-row' }, this.progress, this.statusText);
    this.renderTabs();
    this.el.append(settings, bar, analysis, this.cards, this.tabHost, this.content);
    this.showTab();
  }

  private setMeasureLabel(): void {
    clear(this.measureBtn);
    this.measureBtn.append(icon(this.running ? 'stop' : 'play', 16), h('span', {}, this.running ? 'Cancel' : 'Measure sweep'));
  }

  private renderTabs(): void {
    clear(this.tabHost);
    const tabs: { id: 'fr' | 'ir' | 'rt'; label: string }[] = [
      { id: 'fr', label: 'Frequency response' },
      { id: 'ir', label: 'Impulse / ETC' },
      { id: 'rt', label: 'Reverberation (RT60)' },
    ];
    for (const t of tabs) {
      this.tabHost.append(h('button', { class: `chip${this.tab === t.id ? ' on' : ''}`, onclick: () => { this.tab = t.id; this.renderTabs(); this.showTab(); } }, t.label));
    }
  }

  private showTab(): void {
    clear(this.content);
    if (this.tab === 'fr') this.content.append(h('div', { class: 'pane fill' }, this.fr.el));
    else if (this.tab === 'ir') this.content.append(h('div', { class: 'pane fill' }, this.irPlot.el));
    else this.content.append(h('div', { class: 'rt-split' }, h('div', { class: 'pane' }, this.decay.el), this.table));
    this.dirty = true;
  }

  show(): void {
    const opts = this.app.measurements.length
      ? this.app.measurements.map((m, i) => ({ value: i, label: `${m.cfg.name} (In ${m.cfg.mic + 1})` }))
      : this.app.settings.measurements.map((m, i) => ({ value: i, label: `${m.name} (In ${m.mic + 1})` }));
    this.selHost.replaceChildren(select(opts, this.opts.measIdx, (v) => (this.opts.measIdx = v)));
    this.dirty = true;
  }

  private cancel(): void {
    if (this.running) this.running.cancelled = true;
    this.app.engine.stopPlayback();
  }

  private setProgress(frac: number, text: string): void {
    (this.progress.firstChild as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
    this.statusText.textContent = text;
  }

  async measure(): Promise<void> {
    const app = this.app;
    const e = app.engine;
    if (!e.running) {
      await app.start();
      if (!e.running) return;
    }
    const cfg = app.settings.measurements[this.opts.measIdx] ?? app.settings.measurements[0];
    const ring = e.ring(cfg.mic);
    if (!ring) return app.toast('Measurement channel not available', 'warn');
    const fs = e.sampleRate;
    const spec: SweepSpec = { fs, f1: this.opts.f1, f2: Math.min(this.opts.f2, fs / 2 - 500), duration: this.opts.duration, amplitude: Math.pow(10, this.opts.level / 20) };
    const sweep = logSweep(spec);
    const tail = Math.round(fs * 2.5);
    const buf = new Float32Array(sweep.length + tail);
    buf.set(sweep);
    const sum = new Float64Array(buf.length);
    const token = { cancelled: false };
    this.running = token;
    app.busy = true;
    this.setMeasureLabel();
    const wasGen = app.settings.generator.type;
    if (wasGen !== 'off') app.engine.setGenerator({ ...app.settings.generator, type: 'off' });
    try {
      for (let r = 0; r < this.opts.repeats; r++) {
        this.setProgress(r / this.opts.repeats, `Playing sweep ${r + 1}/${this.opts.repeats}… keep quiet!`);
        const t0 = performance.now();
        const timer = setInterval(() => {
          const frac = Math.min(1, (performance.now() - t0) / 1000 / (buf.length / fs));
          this.setProgress((r + frac) / this.opts.repeats, `Sweep ${r + 1}/${this.opts.repeats} · ${Math.round(frac * 100)}%${frac > sweep.length / buf.length ? ' · recording decay' : ''}`);
        }, 100);
        const { start } = await e.play(buf);
        clearInterval(timer);
        if (token.cancelled) throw new Error('cancelled');
        await e.waitForFrame(start + buf.length, token);
        const rec = new Float64Array(buf.length);
        ring.read(start, buf.length, rec);
        for (let i = 0; i < rec.length; i++) sum[i] += rec[i] / this.opts.repeats;
      }
      this.setProgress(1, 'Analysing…');
      await new Promise((r) => setTimeout(r, 20));
      const d = deconvolve(sum, sweep, spec);
      this.result = this.analyse(d, spec, cfg.mic);
      this.renderResults();
      const bb = this.result.acoustics.broadband;
      this.setProgress(1, `Done · peak-to-noise ${this.result.peakDb.toFixed(0)} dB · T30 ${fmtS(bb.t30.rt)} · EDT ${fmtS(bb.edt.rt)}`);
      if (this.result.peakDb < 40) app.toast('Low signal-to-noise ratio: raise the level, use a longer sweep or more repeats for reliable RT60.', 'warn');
    } catch (err) {
      if ((err as Error).message !== 'cancelled') app.toast(`Sweep failed: ${(err as Error).message}`, 'warn');
      this.setProgress(0, 'Cancelled.');
    } finally {
      this.running = null;
      app.busy = false;
      this.setMeasureLabel();
      if (wasGen !== 'off') app.engine.setGenerator(app.settings.generator);
    }
  }

  private analyse(d: Deconvolution, spec: SweepSpec, channel: number): SweepResult {
    const { ir, t0 } = linearIR(d, 5, Math.min(3, d.ir.length / d.fs / 2));
    const acoustics = roomAcoustics(ir, d.fs, this.opts.fraction);
    const etc = energyTimeCurve(ir);
    let peak = 0;
    for (const v of ir) peak = Math.max(peak, v * v);
    let noise = 0;
    const tailN = Math.round(ir.length * 0.1);
    for (let i = ir.length - tailN; i < ir.length; i++) noise += ir[i] * ir[i];
    noise /= tailN;
    const grid = this.app.grid;
    const hd = harmonicDistortion(d, spec, grid, 5);
    const res: SweepResult = {
      spec,
      d,
      ir,
      t0,
      fr: new Float64Array(grid.length),
      thd: hd.thd,
      h2: hd.harmonics[0],
      h3: hd.harmonics[1],
      acoustics,
      etc,
      peakDb: 10 * Math.log10(peak / Math.max(noise, 1e-30)),
      noiseDb: 10 * Math.log10(Math.max(noise, 1e-30)),
      channel,
      when: new Date(),
    };
    this.computeFr(res);
    return res;
  }

  private computeFr(r: SweepResult): void {
    const fs = r.d.fs;
    const winN = Math.min(r.ir.length, r.t0 + Math.round((this.opts.window / 1000) * fs));
    const w = r.ir.slice(0, winN);
    // Half-Hann fade-out over the last 20% of the window
    const fade = Math.max(1, Math.round((winN - r.t0) * 0.2));
    for (let i = 0; i < fade; i++) w[winN - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    const size = Math.max(nextPow2(winN), 32768);
    const sp = spectrumOf(w, fs, size);
    const pow = Float64Array.from(sp.mag, (m) => m * m);
    const grid = this.app.grid;
    new LogSmoother(grid, fs / size, sp.mag.length).apply(pow, this.opts.smoothing, r.fr);
    const cal = this.app.cal;
    for (let i = 0; i < grid.length; i++) {
      r.fr[i] = 10 * Math.log10(Math.max(r.fr[i], 1e-30)) + (cal ? cal[i] : 0);
      if (grid[i] < r.spec.f1 || grid[i] > r.spec.f2) r.fr[i] = NaN;
    }
  }

  private recompute(bands = false): void {
    if (!this.result) return;
    this.computeFr(this.result);
    if (bands) this.result.acoustics = roomAcoustics(this.result.ir, this.result.d.fs, this.opts.fraction);
    this.renderResults();
  }

  private renderResults(): void {
    const r = this.result;
    if (!r) return;
    const grid = this.app.grid;
    // Level-normalise FR display so the median of 200 Hz–5 kHz sits at 0 dB
    const mid: number[] = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] > 200 && grid[i] < 5000 && Number.isFinite(r.fr[i])) mid.push(r.fr[i]);
    mid.sort((a, b) => a - b);
    const ref = mid.length ? mid[Math.floor(mid.length / 2)] : 0;
    const fr = Float64Array.from(r.fr, (v) => v - ref);
    // Only show distortion where the fundamental is strong enough for a meaningful ratio
    const valid = (i: number) => grid[i] * 2 <= r.spec.f2 && Number.isFinite(fr[i]) && fr[i] > -15;
    const hdOffset = (arr: Float64Array) => Float64Array.from(arr, (v, i) => (valid(i) ? v - ref : NaN));
    // THD drawn as a level on the same scale as the response and harmonics
    const thdDb = Float64Array.from(r.thd, (v, i) => fr[i] + 20 * Math.log10(Math.max(v / 100, 1e-6)));
    this.fr.series = [
      { id: 'fr', label: 'Response', x: grid, y: fr, color: CHART.accent, width: 2 },
      { id: 'h2', label: 'H2', x: grid, y: smoothDb(hdOffset(r.h2)), color: CHART.warn, width: 1.2 },
      { id: 'h3', label: 'H3', x: grid, y: smoothDb(hdOffset(r.h3)), color: '#ff5c7a', width: 1.2 },
      { id: 'thd', label: 'THD', unit: 'dB', x: grid, y: smoothDb(Float64Array.from(thdDb, (v, i) => (valid(i) ? v : NaN))), color: '#b18cff', width: 1.2, dash: [4, 3] },
    ];
    const t = Float64Array.from(r.etc, (_, i) => ((i - r.t0) / r.d.fs) * 1000);
    this.irPlot.series = [{ id: 'etc', label: 'ETC', x: t, y: r.etc, color: CHART.accent, width: 1.2, fill: true }];
    const ac = r.acoustics;
    const colors = BAND_COLORS;
    const decaySeries = ac.bands.map((b, i) => ({
      id: `d${i}`,
      label: `${b.label} Hz`,
      x: Float64Array.from(b.decay, (_, k) => k * ac.decayStep * 1000),
      y: b.decay,
      color: colors[Math.round((i / Math.max(1, ac.bands.length - 1)) * (colors.length - 1))],
      width: 1,
    }));
    decaySeries.push({ id: 'bb', label: 'Broadband', x: Float64Array.from(ac.broadband.decay, (_, k) => k * ac.decayStep * 1000), y: ac.broadband.decay, color: CHART.white, width: 2 });
    this.decay.series = decaySeries;
    this.renderCards(r);
    this.renderTable(ac);
    this.dirty = true;
  }

  private renderCards(r: SweepResult): void {
    const bb = r.acoustics.broadband;
    const mids = r.acoustics.bands.filter((b) => b.centre > 400 && b.centre < 1300);
    const tMid = mids.length ? mids.reduce((s, b) => s + (Number.isFinite(b.t30.rt) ? b.t30.rt : b.t20.rt), 0) / mids.length : bb.t30.rt;
    const card = (label: string, value: string, sub: string, hint: string) => h('div', { class: 'card', title: hint }, h('span', {}, label), h('b', {}, value), h('em', {}, sub));
    clear(this.cards);
    this.cards.append(
      card('T30 (broadband)', fmtS(bb.t30.rt), `r = ${bb.t30.r ? bb.t30.r.toFixed(3) : '—'}`, 'Reverberation time from the −5…−35 dB slope, extrapolated to 60 dB'),
      card('T20', fmtS(bb.t20.rt), `EDT ${fmtS(bb.edt.rt)}`, 'T20 uses −5…−25 dB; EDT uses 0…−10 dB and correlates with perceived reverberance'),
      card('Tmid (500–1k)', fmtS(tMid), roomCharacter(tMid), 'Average of the 500 Hz and 1 kHz octave bands'),
      card('C50 speech', `${fmtDb(bb.c50)}`, `D50 ${Number.isFinite(bb.d50) ? bb.d50.toFixed(0) : '—'} %`, 'Clarity for speech: early (0–50 ms) to late energy ratio. > 0 dB is good'),
      card('C80 music', `${fmtDb(bb.c80)}`, `Ts ${bb.ts.toFixed(0)} ms`, 'Clarity for music: early (0–80 ms) to late energy. −2…+4 dB typical for concert halls'),
      card('Peak-to-noise', `${r.peakDb.toFixed(0)} dB`, r.peakDb > 45 ? 'reliable' : r.peakDb > 35 ? 'T20 only' : 'too noisy', 'ISO 3382 needs ≥ 45 dB for T30 and ≥ 35 dB for T20'),
    );
  }

  private renderTable(ac: AcousticsResult): void {
    const rows: { label: string; get: (b: BandAcoustics) => string; tip: string }[] = [
      { label: 'EDT (s)', get: (b) => fit(b.edt), tip: 'Early decay time' },
      { label: 'T20 (s)', get: (b) => fit(b.t20), tip: 'Reverberation time from 20 dB decay' },
      { label: 'T30 (s)', get: (b) => fit(b.t30), tip: 'Reverberation time from 30 dB decay' },
      { label: 'C50 (dB)', get: (b) => fmtDb(b.c50), tip: 'Speech clarity' },
      { label: 'C80 (dB)', get: (b) => fmtDb(b.c80), tip: 'Music clarity' },
      { label: 'D50 (%)', get: (b) => (Number.isFinite(b.d50) ? b.d50.toFixed(0) : '—'), tip: 'Definition' },
      { label: 'INR (dB)', get: (b) => b.inr.toFixed(0), tip: 'Impulse-to-noise ratio' },
    ];
    const head = `<tr><th></th>${ac.bands.map((b) => `<th>${escapeHtml(b.label)}</th>`).join('')}<th>Broadband</th></tr>`;
    const body = rows.map((r) => `<tr><th title="${r.tip}">${r.label}</th>${ac.bands.map((b) => `<td>${r.get(b)}</td>`).join('')}<td class="bb">${r.get(ac.broadband)}</td></tr>`).join('');
    const tmid = ac.bands.filter((b) => b.centre > 400 && b.centre < 1300).map((b) => b.t30.rt).filter(Number.isFinite);
    const note =
      tmid.length > 0
        ? `<p class="dim small">Values shown faded have a poor linear fit (r &lt; 0.98) or insufficient dynamic range. Schroeder frequency for a 200 m³ room with this RT: ${schroederFrequency(tmid.reduce((a, b) => a + b, 0) / tmid.length, 200).toFixed(0)} Hz — below it, individual room modes dominate.</p>`
        : '';
    this.table.innerHTML = `<table>${head}${body}</table>${note}`;
  }

  private saveTrace(): void {
    const r = this.result;
    if (!r) return this.app.toast('Run a sweep first', 'warn');
    const grid = this.app.grid;
    const idx: number[] = [];
    grid.forEach((_, i) => Number.isFinite(r.fr[i]) && idx.push(i));
    this.app.traces.add({
      name: `Sweep In${r.channel + 1} ${r.when.toLocaleTimeString()}`,
      kind: 'sweep',
      freqs: idx.map((i) => grid[i]),
      mag: idx.map((i) => +r.fr[i].toFixed(2)),
      note: `${r.spec.duration}s log sweep, ${this.opts.window} ms window, 1/${this.opts.smoothing} oct`,
    });
    this.app.toast('Frequency response saved as trace', 'ok');
  }

  private exportIr(): void {
    const r = this.result;
    if (!r) return this.app.toast('Run a sweep first', 'warn');
    let pk = 0;
    for (const v of r.ir) pk = Math.max(pk, Math.abs(v));
    const data = Float32Array.from(r.ir, (v) => (v / (pk || 1)) * 0.9);
    const blob = encodeWav(data, r.d.fs);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `impulse-response-${Date.now()}.wav` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.fr.draw();
    this.irPlot.draw();
    this.decay.draw();
    if (!this.result) {
      this.table.innerHTML = `<div class="empty big">Run a sweep to see reverberation time, clarity and definition per ${this.opts.fraction === 1 ? 'octave' : 'third-octave'} band.</div>`;
    }
  }
}

function smoothDb(y: Float64Array): Float64Array {
  // Light 5-point moving average in dB for readability of harmonic traces
  const out = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = -4; k <= 4; k++) {
      const v = y[i + k];
      if (Number.isFinite(v)) {
        s += v;
        n++;
      }
    }
    out[i] = n ? s / n : NaN;
  }
  return out;
}

function fmtS(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(2)} s` : '—';
}
function fmtDb(v: number): string {
  return Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : '—';
}
function fit(f: { rt: number; r: number }): string {
  if (!Number.isFinite(f.rt)) return '<span class="dim">—</span>';
  return f.r < 0.98 ? `<span class="dim">${f.rt.toFixed(2)}</span>` : f.rt.toFixed(2);
}
function roomCharacter(rt: number): string {
  if (!Number.isFinite(rt)) return '';
  if (rt < 0.3) return 'very dry (studio / control room)';
  if (rt < 0.6) return 'dry (home theatre, meeting room)';
  if (rt < 1.0) return 'medium (classroom, club)';
  if (rt < 1.8) return 'live (theatre, concert hall)';
  return 'very live (church, arena)';
}

export function encodeWav(data: Float32Array, fs: number): Blob {
  const buf = new ArrayBuffer(44 + data.length * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, 1, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);
  str(36, 'data');
  v.setUint32(40, data.length * 4, true);
  for (let i = 0; i < data.length; i++) v.setFloat32(44 + i * 4, data[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}

