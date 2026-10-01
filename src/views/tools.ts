import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, numberInput, clear, select } from '../ui/dom';
import { roomModes, schroederFrequency, criticalDistance, type RoomMode } from '../dsp/acoustics';
import { speedOfSound } from '../dsp/delay';
import { weightingDb } from '../dsp/weighting';
import { RemoteCard } from './remote-card';
import { NativeCard } from './native-card';
import { MicsCard } from './mics-card';
import { modal } from '../ui/dialogs';
import { applySession, buildSession, downloadText, parseSession, sessionFileName, type SessionFile } from '../session';
import { openReport } from '../report';
import { replaceSettings } from '../state';
import { DEFAULT_PROFILES, resetToProfile } from '../defaults';

/** Calibration, room-mode calculator and handy system-alignment calculators. */
export class ToolsView implements View {
  id = 'tools' as const;
  title = 'Tools';
  icon = 'settings' as const;
  el = h('div', { class: 'tools' });
  private room = { L: 6.5, W: 4.2, H: 2.7, rt: 0.5 };
  private modesPlot: Plot;
  private modesTable = h('div', { class: 'modes-table' });
  readonly micsCard: MicsCard;
  private delayOut = h('div', { class: 'calc-out' });
  private dirty = true;
  private remoteCard: RemoteCard;
  readonly nativeCard: NativeCard;
  private nativeTick = 0;

  constructor(private app: App) {
    this.remoteCard = new RemoteCard(app);
    this.nativeCard = new NativeCard(app);
    this.micsCard = new MicsCard(app);
    this.modesPlot = new Plot({ xType: 'log', xMin: 15, xMax: 400, yMin: 0, yMax: 3.4, yUnit: '', title: 'Room modes (axial ▮ tangential ▮ oblique ▮)', yLimits: [0, 4] });
    this.build();
  }

  /** Session details, save / open a session file and the printable report. */
  private sessionCard(): HTMLElement {
    const app = this.app;
    const sess = app.settings.session;
    const field = (key: 'name' | 'venue', label: string, placeholder: string) => {
      const i = h('input', { type: 'text', class: 'text', value: sess[key], placeholder, dataset: { session: key } });
      i.addEventListener('input', () => {
        app.settings.session[key] = i.value;
        app.save();
      });
      return h('label', { class: 'field' }, h('span', {}, label), i);
    };
    const notes = h('textarea', { class: 'text', rows: '3', placeholder: 'System, positions, changes made…', dataset: { session: 'notes' } }) as HTMLTextAreaElement;
    notes.value = sess.notes;
    notes.addEventListener('input', () => {
      app.settings.session.notes = notes.value;
      app.save();
    });
    const file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none', dataset: { session: 'file' } });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        this.confirmOpen(parseSession(await f.text()));
      } catch (e) {
        app.toast((e as Error).message, 'warn');
      }
    });
    this.sessionFields = () => {
      for (const i of this.el.querySelectorAll<HTMLInputElement>('input[data-session="name"], input[data-session="venue"]')) i.value = app.settings.session[i.dataset.session as 'name' | 'venue'];
      notes.value = app.settings.session.notes;
    };
    return h(
      'section',
      { class: 'tool-card session-card' },
      h('h4', {}, icon('layers', 15), ' Session & report'),
      h('p', { class: 'dim small' }, 'Save everything for this job in one file (traces, sweep, EQ, alignment, calibration and measurement setup) to continue later or on another computer, and create a printable report.'),
      h('div', { class: 'session-fields' }, field('name', 'Session', 'e.g. Main PA tuning'), field('venue', 'Venue', 'e.g. City Hall')),
      h('label', { class: 'field' }, h('span', {}, 'Notes'), notes),
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('button', { class: 'btn small', onclick: () => this.saveSession() }, icon('download', 14), 'Save session'),
        h('button', { class: 'btn small', onclick: () => (app.remote ? app.toast('Open sessions on the measurement host.', 'warn') : file.click()) }, icon('upload', 14), 'Open session…'),
        h('button', { class: 'btn small accent', onclick: () => openReport(app) }, icon('list', 14), 'Create report'),
      ),
      file,
    );
  }

  private sessionFields: () => void = () => {};

  private saveSession(): void {
    const app = this.app;
    downloadText(sessionFileName(app.settings.session), JSON.stringify(buildSession(app)));
    app.toast('Session saved', 'ok');
  }

  private confirmOpen(f: SessionFile): void {
    const app = this.app;
    const what = [`${f.traces.length} trace${f.traces.length === 1 ? '' : 's'}`, f.sweep ? 'a sweep' : '', f.eq ? 'EQ' : '', f.align ? 'a sub alignment' : ''].filter(Boolean);
    const title = [f.session.name, f.session.venue].filter(Boolean).join(' · ') || 'Untitled session';
    const open = h('button', { class: 'btn accent' }, 'Open session');
    const cancel = h('button', { class: 'btn' }, 'Cancel');
    const { close } = modal(
      'Open session',
      h(
        'div',
        {},
        h('p', {}, h('b', {}, title), f.saved ? h('span', { class: 'dim' }, ` · saved ${new Date(f.saved).toLocaleString()}`) : null),
        h('p', {}, `Contains ${what.join(', ')}, plus the calibration and measurement setup.`),
        h('p', { class: 'warn-text small' }, 'This replaces the current traces, sweep, EQ and alignment. Save the current session first if you want to keep it.'),
      ),
      [cancel, open],
    );
    cancel.addEventListener('click', close);
    open.addEventListener('click', () => {
      close();
      applySession(app, f);
      this.sessionFields();
      this.renderStatus();
      app.toast(`Opened “${title}”`, 'ok');
    });
  }

  private build(): void {
    const s = this.app.settings;
    // --- Delay / distance
    const dInput = h('input', { type: 'number', class: 'num', value: '10', step: '0.01' });
    const mInput = h('input', { type: 'number', class: 'num', value: '3.43', step: '0.01' });
    const fInput = h('input', { type: 'number', class: 'num', value: '100', step: '1' });
    const temp = numberInput(s.tempC, (v) => { s.tempC = v; this.app.save(); update(); this.dirty = true; }, { class: 'num', step: '1', 'aria-label': 'Air temperature (°C)' });
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
      h('div', { class: 'row gap8' }, h('button', { class: 'btn small ghost', onclick: () => { if (confirm('Delete all stored traces?')) this.app.traces.clear(); } }, 'Delete all traces'), h('button', { class: 'btn small ghost', title: 'Everything back to the first start, including microphones, calibration and remote access', onclick: () => { if (confirm('Reset ALL settings, including microphones, calibrations and remote access, to the first start?')) { replaceSettings(null); location.reload(); } } }, 'Reset all settings')),
      this.resetRow(),
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
      h(
        'div',
        { class: 'row gap8' },
        h('span', {}, 'Battery saver'),
        select(
          [
            { value: 'auto' as const, label: 'Auto (on while on battery)' },
            { value: 'saver' as const, label: 'On' },
            { value: 'normal' as const, label: 'Off' },
          ],
          s.powerMode,
          (v) => app.setPowerMode(v),
          { dataset: { setting: 'powerMode' }, title: 'Fewer screen updates (≈15 per second) and new spectra (10 per second), standard graph resolution. Measurements stay exact: every sample is still analysed.' },
        ),
      ),
      h(
        'div',
        { class: 'row gap8' },
        h('span', {}, 'Bass resolution'),
        select(
          [
            { value: 'standard' as const, label: 'Standard (fastest response)' },
            { value: 'high' as const, label: 'High (0.7 Hz, ≈1.4 s)' },
            { value: 'max' as const, label: 'Maximum (0.4 Hz, ≈2.7 s)' },
          ],
          s.lfResolution,
          (v) => {
            s.lfResolution = v;
            app.applyAnalysisSettings();
          },
          { dataset: { setting: 'lfResolution' } },
        ),
      ),
      h('p', { class: 'dim small' }, 'Finer detail in the low end (room modes, subwoofer alignment) for the spectrum below 160 Hz and the transfer function below 90 Hz. The bass then reacts more slowly: it needs a longer stretch of signal. Mids and highs are not affected, and the extra processing is only a few percent.'),
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
    this.el.append(h('div', { class: 'tool-grid' }, this.sessionCard(), this.micsCard.el, this.nativeCard.el, this.remoteCard.el, perfCard, delayCard, wCard, modesCard, dataCard));
    this.renderStatus();
  }

  private renderStatus(): void {
    this.micsCard.render();
  }

  show(): void {
    this.renderStatus();
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  tick(): void {
    if ((this.nativeTick = (this.nativeTick + 1) % 15) === 0) this.nativeCard.update();
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

  /** Reset the analysis and display settings to a profile, keeping the setup (mics, calibration, inputs, remote). */
  private resetRow(): HTMLElement {
    let profile = DEFAULT_PROFILES[0].id;
    const sel = select(
      DEFAULT_PROFILES.map((p) => ({ value: p.id, label: p.label })),
      profile,
      (v) => {
        profile = v;
        sel.title = DEFAULT_PROFILES.find((p) => p.id === v)!.description;
      },
      { title: DEFAULT_PROFILES[0].description, dataset: { reset: 'profile' } },
    );
    const go = () => {
      const p = DEFAULT_PROFILES.find((x) => x.id === profile)!;
      if (!confirm(`Reset the analysis and display settings to “${p.label}”?\n\nMicrophones, calibrations, inputs, remote access and saved workspaces stay as they are. The app reloads.`)) return;
      replaceSettings(resetToProfile(this.app.settings, profile));
      location.reload();
    };
    return h(
      'div',
      { class: 'row gap8 wrap' },
      h('span', {}, 'Reset analysis & display to'),
      sel,
      h('button', { class: 'btn small', onclick: go, dataset: { reset: 'go' }, title: 'Keeps microphones, calibrations, inputs, remote access and workspaces' }, icon('reset', 14), 'Reset'),
    );
  }
}
