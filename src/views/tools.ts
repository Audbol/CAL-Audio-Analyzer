import type { App, View } from '../app';
import { h, icon, numberInput, select } from '../ui/dom';
import { speedOfSound } from '../dsp/delay';
import { GEN_CHANNEL } from '../audio/engine';
import { weightingDb } from '../dsp/weighting';
import { RemoteCard } from './remote-card';
import { NativeCard } from './native-card';
import { MicsCard } from './mics-card';
import { RoomModesCard } from './modes';
import { modal } from '../ui/dialogs';
import { applySession, buildSession, downloadText, parseSession, sessionFileName, type SessionFile } from '../session';
import { openReport } from '../report';
import { replaceSettings } from '../state';
import { DEFAULT_PROFILES, resetToProfile } from '../defaults';

/** Tools sections: one at a time, picked from the list on the left (a row of chips on small screens). */
export type ToolsSection = 'setup' | 'session' | 'remote' | 'display' | 'calc' | 'data';
const SECTIONS: { id: ToolsSection; label: string; icon: Parameters<typeof icon>[0]; hint: string }[] = [
  { id: 'setup', label: 'Setup', icon: 'mic', hint: 'Reference signal, microphones and calibration, audio interface' },
  { id: 'session', label: 'Session & report', icon: 'layers', hint: 'Save or open a job, create a report' },
  { id: 'remote', label: 'Remote access', icon: 'wifi', hint: 'Phones, tablets and other computers' },
  { id: 'display', label: 'Display & performance', icon: 'sliders', hint: 'Graph quality, battery saver, bass resolution' },
  { id: 'calc', label: 'Calculators', icon: 'clock', hint: 'Room modes; delay, distance and wavelength; weighting table' },
  { id: 'data', label: 'Data & reset', icon: 'trash', hint: 'Delete traces, reset settings' },
];

/** Setup, sessions, remote access, display settings, calculators and data, in sections. */
export class ToolsView implements View {
  id = 'tools' as const;
  title = 'Tools';
  icon = 'settings' as const;
  el = h('div', { class: 'tools' });
  private nav = h('nav', { class: 'tools-nav', 'aria-label': 'Tools sections' });
  private body = h('div', { class: 'tools-body' });
  private cards = new Map<ToolsSection, HTMLElement[]>();
  readonly micsCard: MicsCard;
  private modesCard: RoomModesCard;
  private delayOut = h('div', { class: 'calc-out' });
  private dirty = true;
  private remoteCard: RemoteCard;
  readonly nativeCard: NativeCard;
  private nativeTick = 0;

  constructor(private app: App) {
    this.remoteCard = new RemoteCard(app);
    this.nativeCard = new NativeCard(app);
    this.micsCard = new MicsCard(app);
    this.modesCard = new RoomModesCard(app);
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
    const temp = numberInput(s.tempC, (v) => { s.tempC = v; this.app.save(); update(); this.dirty = true; this.modesCard.invalidate(); }, { class: 'num', step: '1', 'aria-label': 'Air temperature (°C)' });
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
      app.remote
        ? null
        : h(
            'div',
            { class: 'row gap8' },
            h('span', {}, 'Analysis'),
            select(
              [
                { value: 'worker' as const, label: 'Background thread (smoother)' },
                { value: 'main' as const, label: 'Main thread' },
              ],
              s.analysisThread,
              (v) => {
                s.analysisThread = v;
                app.save();
                app.analysisWorker.setEnabled(v === 'worker');
              },
              { dataset: { setting: 'analysisThread' }, title: 'Background thread: the spectrum and transfer function are analysed beside the drawing, so neither waits for the other. Main thread: as in earlier versions.' },
            ),
          ),
      h(
        'div',
        { class: 'row gap8' },
        h('span', {}, 'Assistant'),
        select(
          [
            { value: 'on' as const, label: 'Show tips in the sidebar' },
            { value: 'off' as const, label: 'Hidden' },
          ],
          s.showAssistant ? 'on' : 'off',
          (v) => app.setAssistant(v === 'on'),
          { dataset: { assistant: '' }, 'aria-label': 'Assistant' },
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
    this.cards.set('setup', [this.referenceCard(), this.micsCard.el, this.nativeCard.el]);
    this.cards.set('session', [this.sessionCard()]);
    this.cards.set('remote', [this.remoteCard.el]);
    this.cards.set('display', [perfCard]);
    this.cards.set('calc', [this.modesCard.el, delayCard, wCard]);
    this.cards.set('data', [dataCard]);
    this.el.append(this.nav, this.body);
    this.open((SECTIONS.find((x) => x.id === s.toolsSection)?.id ?? 'setup') as ToolsSection);
    this.renderStatus();
  }

  /** Show one section (also from links elsewhere, e.g. SPL → Calibrate opens Setup). */
  open(section: ToolsSection): void {
    this.app.settings.toolsSection = section;
    this.nav.replaceChildren(
      ...SECTIONS.map((x) =>
        h(
          'button',
          { class: `tools-nav-item${x.id === section ? ' on' : ''}`, title: x.hint, 'aria-current': x.id === section ? 'page' : null, dataset: { section: x.id }, onclick: () => { this.open(x.id); this.app.save(); } },
          icon(x.icon, 15),
          h('span', {}, x.label),
        ),
      ),
    );
    const sec = SECTIONS.find((x) => x.id === section)!;
    this.body.replaceChildren(h('h3', { class: 'tools-title' }, sec.label), h('div', { class: 'tool-grid' }, ...(this.cards.get(section) ?? [])));
    this.body.scrollTop = 0;
    if (section === 'calc') this.modesCard.invalidate();
    this.syncAssistant();
    this.dirty = true;
  }

  private refHost = h('div', { class: 'ref-card-body' });

  /**
   * Reference signal for every measurement: the generator's own signal (internal, works with any interface) or a
   * loopback input (the signal sent to the system, patched back into the interface; needed to measure with a
   * mixing console or program material in the chain). Per measurement it can also be set in the sidebar.
   */
  private referenceCard(): HTMLElement {
    this.renderReference();
    return h(
      'section',
      { class: 'tool-card ref-card' },
      h('h4', {}, icon('wave', 15), ' Reference signal'),
      h('p', { class: 'dim small' }, 'The transfer function compares each mic with a reference: the signal sent to the system. Use the generator’s own signal (works with any interface), or a loopback input when a mixer or program material is in the chain.'),
      this.refHost,
    );
  }

  private renderReference(): void {
    const app = this.app;
    const ms = app.settings.measurements;
    const refs = new Set(ms.map((m) => m.ref));
    const mode: 'internal' | 'loopback' | 'mixed' = refs.size > 1 ? 'mixed' : ms[0]?.ref === GEN_CHANNEL ? 'internal' : 'loopback';
    // Inputs that can be a loopback: any input that isn't a measurement mic
    const mics = new Set(ms.map((m) => m.mic));
    const inputs = app.channelOptions(false).filter((o) => !mics.has(o.value));
    const current = mode === 'loopback' ? ms[0].ref : (app.settings.loopbackInput ?? inputs[0]?.value ?? 1);
    const seg = (id: 'internal' | 'loopback', label: string, title: string) =>
      h('button', { class: `seg${mode === id ? ' on' : ''}`, 'aria-pressed': String(mode === id), title, dataset: { ref: id }, onclick: () => this.setReference(id === 'internal' ? GEN_CHANNEL : current) }, label);
    const inputSel = select(inputs.length ? inputs : [{ value: current, label: `In ${current + 1}` }], current, (v) => {
      app.settings.loopbackInput = v;
      if (mode !== 'internal') this.setReference(v);
      else app.save();
    }, { 'aria-label': 'Loopback input', dataset: { ref: 'input' } });
    this.refHost.replaceChildren(
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Reference signal' }, seg('internal', 'Internal (generator)', 'Compare with the generator’s own signal'), seg('loopback', 'Loopback input', 'Compare with an input carrying the signal sent to the system')),
      h('div', { class: 'row gap8 ref-input-row' }, h('span', { class: 'dim small' }, 'Loopback input'), inputSel),
      h(
        'p',
        { class: 'small' },
        mode === 'mixed'
          ? 'Measurements use different references (set per measurement in the sidebar). Choose one here to use it for all.'
          : mode === 'internal'
            ? 'All measurements compare the mic with the generator’s own signal. Turn the generator on to measure.'
            : `All measurements compare the mic with In ${ms[0].ref + 1}.`,
      ),
    );
  }

  /** Use one reference for every measurement; the delay changes with it, so it is measured again. */
  private setReference(ref: number): void {
    const app = this.app;
    if (ref !== GEN_CHANNEL) app.settings.loopbackInput = ref;
    for (const c of app.settings.measurements) c.ref = ref;
    for (const m of app.measurements) {
      m.cfg.ref = ref;
      m.reset();
    }
    app.save();
    app.renderMeasurements();
    this.renderReference();
    const gen = app.settings.generator.type !== 'off';
    app.toast(ref === GEN_CHANNEL ? `Reference: the internal generator${gen ? '. Measuring the delay again…' : '. Turn the generator on (Space), then Find delay (D).'}` : `Reference: In ${ref + 1}${gen ? '. Measuring the delay again…' : '. Play the signal, then Find delay (D).'}`, 'info');
    // The path (and so the delay) to the mic differs between the two references
    if (app.engine.running && (gen || ref !== GEN_CHANNEL)) setTimeout(() => app.measurements.forEach((m) => m.cfg.enabled && app.findDelay(m)), 1200);
  }

  private renderStatus(): void {
    this.micsCard.render();
  }

  show(): void {
    this.renderStatus();
    this.renderReference();
    this.dirty = true;
  }

  invalidate(): void {
    this.modesCard.invalidate();
    this.dirty = true;
  }

  /** The Assistant can also be hidden from its own close button: keep the Display setting in step. */
  private syncAssistant(): void {
    const assistant = this.el.querySelector<HTMLSelectElement>('select[data-assistant]');
    const shown = this.app.settings.showAssistant ? 'on' : 'off';
    if (assistant && assistant.value !== shown) assistant.value = shown;
  }

  tick(): void {
    if ((this.nativeTick = (this.nativeTick + 1) % 15) === 0) this.nativeCard.update();
    if (this.app.settings.toolsSection === 'calc') this.modesCard.tick();
    this.syncAssistant();
    if (!this.dirty) return;
    this.dirty = false;
    this.remoteCard.render();
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
