import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, numberInput, clear, select } from '../ui/dom';
import { roomModes, schroederFrequency, criticalDistance, type RoomMode } from '../dsp/acoustics';
import { speedOfSound } from '../dsp/delay';
import { parseMicCal } from '../dsp/calibration';
import { weightingDb } from '../dsp/weighting';
import { RemoteCard } from './remote-card';

/** Calibration, room-mode calculator and handy system-alignment calculators. */
export class ToolsView implements View {
  id = 'tools' as const;
  title = 'Tools';
  icon = 'settings' as const;
  el = h('div', { class: 'tools' });
  private room = { L: 6.5, W: 4.2, H: 2.7, rt: 0.5 };
  private modesPlot: Plot;
  private modesTable = h('div', { class: 'modes-table' });
  private calStatus = h('div', { class: 'dim small' });
  private micStatus = h('div', { class: 'dim small' });
  private delayOut = h('div', { class: 'calc-out' });
  private dirty = true;
  private remoteCard: RemoteCard;

  constructor(private app: App) {
    this.remoteCard = new RemoteCard(app);
    this.modesPlot = new Plot({ xType: 'log', xMin: 15, xMax: 400, yMin: 0, yMax: 3.4, yUnit: '', title: 'Room modes (axial ▮ tangential ▮ oblique ▮)', yLimits: [0, 4] });
    this.build();
  }

  private build(): void {
    const s = this.app.settings;
    // --- SPL calibration
    const calLevel = h('input', { type: 'number', class: 'num', value: '94', step: '0.1' });
    const calCard = h(
      'section',
      { class: 'tool-card' },
      h('h4', {}, icon('mic', 15), ' SPL calibration'),
      h('p', { class: 'dim small' }, 'Fit an acoustic calibrator (94 or 114 dB, 1 kHz) to the measurement mic, switch it on, then press Calibrate. Or place a reference SLM next to the mic and enter its reading.'),
      h('div', { class: 'row gap8' }, h('span', {}, 'Reference level'), calLevel, h('span', { class: 'unit' }, 'dB SPL'), h('button', { class: 'btn accent small', onclick: () => this.calibrate(+calLevel.value) }, icon('target', 14), 'Calibrate')),
      h('div', { class: 'row gap8' }, h('button', { class: 'btn small ghost', onclick: () => { s.splOffset = 0; s.splCalibrated = false; this.app.spl.offsetDb = 0; this.app.save(); this.renderStatus(); } }, 'Reset calibration')),
      this.calStatus,
    );
    // --- Mic calibration file
    const file = h('input', { type: 'file', accept: '.txt,.cal,.frd,.csv', style: 'display:none' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        s.micCal = parseMicCal(await f.text(), f.name);
        this.app.updateCal();
        this.app.save();
        this.app.toast(`Loaded mic calibration ${f.name} (${s.micCal.freqs.length} points)`, 'ok');
      } catch (e) {
        this.app.toast((e as Error).message, 'warn');
      }
      file.value = '';
      this.renderStatus();
    });
    const micCard = h(
      'section',
      { class: 'tool-card' },
      h('h4', {}, icon('upload', 15), ' Microphone calibration file'),
      h('p', { class: 'dim small' }, 'Load the frequency response file supplied with your measurement mic (miniDSP UMIK, Dayton, Sonarworks, REW/FRD text). The correction is applied to RTA, transfer function and sweep results.'),
      h('div', { class: 'row gap8' }, h('button', { class: 'btn small', onclick: () => file.click() }, icon('upload', 14), 'Load file…'), h('button', { class: 'btn small ghost', onclick: () => { s.micCal = null; this.app.updateCal(); this.app.save(); this.renderStatus(); } }, 'Remove')),
      this.micStatus,
      file,
    );
    // --- Delay / distance
    const dInput = h('input', { type: 'number', class: 'num', value: '10', step: '0.01' });
    const mInput = h('input', { type: 'number', class: 'num', value: '3.43', step: '0.01' });
    const fInput = h('input', { type: 'number', class: 'num', value: '100', step: '1' });
    const temp = numberInput(s.tempC, (v) => { s.tempC = v; this.app.save(); update(); }, { class: 'num', step: '1' });
    const update = () => {
      const c = speedOfSound(s.tempC);
      const f = +fInput.value || 100;
      this.delayOut.innerHTML = `Speed of sound <b>${c.toFixed(1)} m/s</b> · ${dInput.value} ms = <b>${((+dInput.value / 1000) * c).toFixed(3)} m</b> · ${mInput.value} m = <b>${((+mInput.value / c) * 1000).toFixed(2)} ms</b> · λ(${f} Hz) = <b>${(c / f).toFixed(3)} m</b>, period ${(1000 / f).toFixed(2)} ms, comb-filter first notch at delay → ${(1000 / (2 * +dInput.value)).toFixed(1)} Hz`;
    };
    for (const i of [dInput, mInput, fInput]) i.addEventListener('input', update);
    update();
    const delayCard = h(
      'section',
      { class: 'tool-card' },
      h('h4', {}, icon('clock', 15), ' Delay · distance · wavelength'),
      h('div', { class: 'row gap8 wrap' }, h('label', { class: 'inline' }, 'Temp', temp, h('span', { class: 'unit' }, '°C')), h('label', { class: 'inline' }, 'Delay', dInput, h('span', { class: 'unit' }, 'ms')), h('label', { class: 'inline' }, 'Distance', mInput, h('span', { class: 'unit' }, 'm')), h('label', { class: 'inline' }, 'Freq', fInput, h('span', { class: 'unit' }, 'Hz'))),
      this.delayOut,
    );
    // --- Room modes
    const r = this.room;
    const dim = (key: keyof typeof r, label: string, unit: string) => h('label', { class: 'inline' }, label, numberInput(r[key], (v) => { r[key] = Math.max(0.1, v); this.dirty = true; }, { class: 'num', step: '0.1' }), h('span', { class: 'unit' }, unit));
    const modesCard = h(
      'section',
      { class: 'tool-card wide' },
      h('h4', {}, icon('home', 15), ' Room mode calculator (rectangular room)'),
      h('div', { class: 'row gap8 wrap' }, dim('L', 'Length', 'm'), dim('W', 'Width', 'm'), dim('H', 'Height', 'm'), dim('rt', 'RT60', 's')),
      h('div', { class: 'modes-split' }, h('div', { class: 'pane', style: 'height:220px' }, this.modesPlot.el), this.modesTable),
    );
    // --- Weighting reference
    const wt = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const wCard = h(
      'section',
      { class: 'tool-card' },
      h('h4', {}, icon('info', 15), ' Weighting reference (IEC 61672)'),
      h('table', { class: 'mini-table', innerHTML: `<tr><th>Hz</th>${wt.map((f) => `<th>${f >= 1000 ? f / 1000 + 'k' : f}</th>`).join('')}</tr><tr><th>A</th>${wt.map((f) => `<td>${weightingDb('A', f).toFixed(1)}</td>`).join('')}</tr><tr><th>C</th>${wt.map((f) => `<td>${weightingDb('C', f).toFixed(1)}</td>`).join('')}</tr>` }),
    );
    // --- Data management
    const dataCard = h(
      'section',
      { class: 'tool-card' },
      h('h4', {}, icon('trash', 15), ' Data'),
      h('p', { class: 'dim small' }, 'Settings and traces are stored locally in this browser only.'),
      h('div', { class: 'row gap8' }, h('button', { class: 'btn small ghost', onclick: () => { if (confirm('Delete all stored traces?')) this.app.traces.clear(); } }, 'Delete all traces'), h('button', { class: 'btn small ghost', onclick: () => { if (confirm('Reset all settings to defaults?')) { localStorage.removeItem('cal-analyzer-settings-v1'); location.reload(); } } }, 'Reset settings')),
    );
    // --- Display & performance
    const app = this.app;
    const perfCard = h(
      'section',
      { class: 'tool-card perf-card' },
      h('h4', {}, icon('sliders', 15), ' Display & performance'),
      h('p', { class: 'dim small' }, 'On slow phones, tablets and older computers, lower the graph resolution. Auto does this by itself when drawing can’t keep up.'),
      h(
        'div',
        { class: 'row gap8' },
        h('span', {}, 'Graph quality'),
        select(
          [
            { value: 'auto' as const, label: 'Auto' },
            { value: 'high' as const, label: 'High (sharp)' },
            { value: 'fast' as const, label: 'Fast (low resolution)' },
          ],
          s.graphQuality,
          (v) => app.setGraphQualityMode(v),
          { dataset: { setting: 'graphQuality' } },
        ),
      ),
      app.remote
        ? h(
            'div',
            { class: 'row gap8' },
            h('span', {}, 'Analysis'),
            select(
              [
                { value: 'host' as const, label: 'On the measurement host (fast)' },
                { value: 'device' as const, label: 'On this device' },
              ],
              s.remoteProcessing,
              (v) => app.setProcessing(v),
              { dataset: { setting: 'remoteProcessing' } },
            ),
          )
        : null,
      app.remote
        ? h('p', { class: 'dim small' }, 'On the host: the measurement computer runs the FFTs and sends finished spectra, so every device shows the same result and slow devices only draw. Averaging and FFT size then follow the host. On this device: the full analysis runs here with its own averaging.')
        : null,
    );
    this.el.append(h('div', { class: 'tool-grid' }, this.remoteCard.el, perfCard, calCard, micCard, delayCard, wCard, modesCard, dataCard));
    this.renderStatus();
  }

  private calibrate(level: number): void {
    const app = this.app;
    const r = app.splReading;
    if (!app.engine.running || !r || !Number.isFinite(r.slow)) return app.toast('Start audio with the calibrator running first', 'warn');
    const raw = r.slow - app.spl.offsetDb;
    if (raw < -80) return app.toast('Input level too low for calibration — check the mic channel and gain', 'warn');
    const s = app.settings;
    s.splOffset = level - raw;
    s.splCalibrated = true;
    app.spl.offsetDb = s.splOffset;
    app.spl.resetLeq();
    app.save();
    app.toast(`Calibrated: ${raw.toFixed(1)} dBFS = ${level.toFixed(1)} dB SPL (offset ${s.splOffset.toFixed(1)} dB)`, 'ok');
    this.renderStatus();
  }

  private renderStatus(): void {
    const s = this.app.settings;
    this.calStatus.innerHTML = s.splCalibrated
      ? `<span class="ok-text">Calibrated</span> · 0 dBFS = ${s.splOffset.toFixed(1)} dB SPL (input ${s.splChannel + 1}). Don't change the preamp gain after calibrating.`
      : 'Not calibrated — levels are shown in dBFS.';
    this.micStatus.innerHTML = s.micCal
      ? `<span class="ok-text">Active:</span> ${s.micCal.name} · ${s.micCal.freqs.length} points${s.micCal.sensitivity !== undefined ? ` · sens. factor ${s.micCal.sensitivity} dB` : ''}`
      : 'No calibration file loaded.';
  }

  show(): void {
    this.renderStatus();
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  tick(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.remoteCard.render();
    const { L, W, H, rt } = this.room;
    const c = speedOfSound(this.app.settings.tempC);
    const modes = roomModes(L, W, H, c, 400);
    const V = L * W * H;
    const fs = schroederFrequency(rt, V);
    const color = (m: RoomMode) => (m.kind === 'axial' ? CHART.warn : m.kind === 'tangential' ? CHART.accent : '#b18cff');
    const height = (m: RoomMode) => (m.kind === 'axial' ? 3 : m.kind === 'tangential' ? 2 : 1);
    this.modesPlot.series = modes.map((m, i) => ({
      id: `m${i}`,
      label: `${m.n.join(',')} ${m.kind}`,
      x: [m.f * 0.999, m.f, m.f * 1.001],
      y: [0, height(m), 0],
      color: color(m),
      width: 1.5,
      quiet: true,
    }));
    this.modesPlot.markers = [{ x: fs, color: CHART.marker, label: `Schroeder ${fs.toFixed(0)} Hz` }];
    // Highlight clusters / gaps of axial modes (Bonello-style quick check)
    const axial = modes.filter((m) => m.kind === 'axial' && m.f < fs * 1.2);
    const rows = axial
      .slice(0, 18)
      .map((m) => `<tr><td>${m.f.toFixed(1)} Hz</td><td>${m.n.join(' · ')}</td><td>${m.n[0] ? 'length' : m.n[1] ? 'width' : 'height'}</td></tr>`)
      .join('');
    let issue = '';
    for (let i = 1; i < axial.length; i++) {
      if (axial[i].f - axial[i - 1].f < 2) {
        issue = `<p class="warn-text small">Coincident axial modes near ${axial[i].f.toFixed(0)} Hz — expect a strong resonance there.</p>`;
        break;
      }
    }
    clear(this.modesTable);
    this.modesTable.innerHTML = `<p class="small">Volume <b>${V.toFixed(1)} m³</b> · Schroeder frequency <b>${fs.toFixed(0)} Hz</b> · critical distance ≈ <b>${criticalDistance(V, rt).toFixed(2)} m</b> (Q=2)</p>${issue}<table class="mini-table"><tr><th>Axial mode</th><th>n</th><th>Dimension</th></tr>${rows}</table>`;
    this.modesPlot.draw();
  }
}
