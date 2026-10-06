import type { App } from '../app';
import type { MicProfile } from '../state';
import { h, icon, select } from '../ui/dom';
import { parseMicCal } from '../dsp/calibration';
import { WeightingFilter } from '../dsp/weighting';

/**
 * Tools card: the microphone inventory. Each mic is set up once (name, model and serial, correction file, SPL
 * calibration) and chosen for a measurement in the sidebar; it then follows that measurement's input. The
 * spectrum, transfer function, sweeps, spectrogram and SPL meter use the mic on their input.
 */
export class MicsCard {
  readonly el = h('section', { class: 'tool-card mics-card' });
  private list = h('div', { class: 'mic-list' });
  private refLevel = h('input', { type: 'number', class: 'num', value: '94', step: '0.1', title: 'Calibrator level (or the reading of a reference sound level meter)', dataset: { mic: 'ref' } });

  constructor(private app: App) {
    this.el.append(
      h('h4', {}, icon('mic', 15), ' Microphones (inventory)'),
      h('p', { class: 'dim small' }, 'Set up each measurement mic once: its correction file and an SPL calibration. Then choose it for a measurement (Add, or the Microphone menu on a measurement in the sidebar): it follows that measurement’s input. Calibrate with the calibrator on the mic (or a reference meter next to it), at the preamp gain you will measure with.'),
      h('div', { class: 'row gap8 wrap' }, h('span', {}, 'Reference level'), this.refLevel, h('span', { class: 'unit' }, 'dB SPL'), h('div', { class: 'spacer' }), h('button', { class: 'btn small', dataset: { mic: 'add' }, onclick: () => this.add() }, icon('plus', 14), 'Add microphone')),
      this.list,
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('button', { class: 'btn small ghost', title: 'Save the inventory (names, correction files, calibrations) as a file, e.g. for another computer', onclick: () => this.exportInventory() }, icon('download', 13), 'Export inventory'),
        h('button', { class: 'btn small ghost', title: 'Add the mics from an inventory file', onclick: () => this.importInventory() }, icon('upload', 13), 'Import…'),
      ),
    );
    this.render();
  }

  private get mics(): MicProfile[] {
    return this.app.settings.mics;
  }

  /** Apply a change: every view picks up the mic on its input. */
  private changed(): void {
    this.app.syncCal();
    this.app.save();
    this.app.renderMeasurements();
    for (const v of this.app.views) v.invalidate?.();
    this.render();
  }

  private add(): void {
    const used = new Set(this.mics.map((m) => m.channel));
    const n = Math.max(this.app.engine.channelCount, 2);
    let ch = -1;
    for (let c = 0; c < n; c++) if (!used.has(c)) { ch = c; break; }
    this.mics.push({ id: `mic${Date.now().toString(36)}`, name: `Mic ${this.mics.length + 1}`, channel: ch, micCal: null, splOffset: 0, splCalibrated: false });
    this.changed();
  }

  /**
   * Level of an input over the last second (dBFS, sine-referenced), with the SPL meter's frequency weighting so a
   * calibration made against a reference meter reads the same (with a 1 kHz calibrator A, C and Z agree).
   */
  private levelOf(channel: number): number | null {
    const e = this.app.engine;
    const ring = e.running ? e.ring(channel) : null;
    const settle = Math.round(e.sampleRate * 0.25);
    const n = Math.round(e.sampleRate);
    if (!ring || ring.written < n + settle) return null;
    const buf = new Float32Array(n + settle);
    ring.read(ring.written - n - settle, n + settle, buf);
    const out = new Float64Array(buf.length);
    new WeightingFilter(this.app.settings.splWeighting, e.sampleRate).process(buf, out);
    let ms = 0;
    for (let i = settle; i < out.length; i++) ms += out[i] * out[i];
    return 10 * Math.log10(Math.max((ms / n) * 2, 1e-20));
  }

  private calibrate(m: MicProfile): void {
    const app = this.app;
    if (m.channel < 0) return app.toast(`Choose the input ${m.name} is plugged into first.`, 'warn');
    const raw = this.levelOf(m.channel);
    if (raw === null) return app.toast('Start audio with the calibrator running first.', 'warn');
    if (raw < -80) return app.toast(`The level on In ${m.channel + 1} is too low for calibration: check the mic, its input and the gain.`, 'warn');
    if (raw > -1) return app.toast(`In ${m.channel + 1} is clipping: lower the preamp gain and calibrate again.`, 'warn');
    const level = this.refLevel.value.trim() === '' ? NaN : +this.refLevel.value;
    if (!Number.isFinite(level) || level < 40 || level > 150) return app.toast('Enter the reference level first (e.g. 94 or 114 dB SPL for a calibrator).', 'warn');
    m.splOffset = level - raw;
    m.splCalibrated = true;
    m.calibratedAt = Date.now();
    m.calLevel = level;
    app.toast(`${m.name} calibrated: ${raw.toFixed(1)} dBFS(${app.settings.splWeighting}) = ${level.toFixed(1)} dB SPL on In ${m.channel + 1}`, 'ok');
    this.changed();
  }

  private loadFile(m: MicProfile): void {
    const input = h('input', { type: 'file', accept: '.txt,.cal,.frd,.csv', style: 'display:none' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        m.micCal = parseMicCal(await f.text(), f.name);
        this.app.toast(`${m.name}: correction ${f.name} (${m.micCal.freqs.length} points)`, 'ok');
        this.changed();
      } catch (e) {
        this.app.toast((e as Error).message, 'warn');
      }
    });
    document.body.append(input);
    input.click();
  }

  render(): void {
    const app = this.app;
    const rows = this.mics.map((m) => {
      const name = h('input', { type: 'text', class: 'text mic-name', value: m.name, 'aria-label': 'Microphone name', dataset: { mic: 'name' } });
      name.addEventListener('change', () => {
        // Also fires when the field is replaced while focused: only act on a real rename
        const v = name.value.trim();
        if (!v || v === m.name) return;
        m.name = v;
        queueMicrotask(() => this.changed());
      });
      const taken = new Set(this.mics.filter((x) => x !== m).map((x) => x.channel));
      const chOpts = [{ value: -1, label: 'Not connected' }, ...app.channelOptions(false).map((o) => ({ value: o.value, label: `In ${o.value + 1}${taken.has(o.value) ? ' (in use)' : ''}` }))];
      if (m.channel >= 0 && !chOpts.some((o) => o.value === m.channel)) chOpts.push({ value: m.channel, label: `In ${m.channel + 1}` });
      const chSel = select(chOpts, m.channel, (v) => {
        // One mic per input: a mic moved onto a used input takes it over
        for (const x of this.mics) if (x !== m && x.channel === v && v >= 0) x.channel = -1;
        m.channel = v;
        // The measurements stay in step: the one that used this mic follows it, and the one on its new input uses it
        for (const cfg of app.settings.measurements) {
          if (cfg.micId === m.id && v < 0) delete cfg.micId;
          else if (cfg.micId === m.id) cfg.mic = v;
          else if (cfg.mic === v) cfg.micId = m.id;
        }
        if (m.splCalibrated) app.toast(`${m.name} moved to a new input: check its calibration (the gain may differ).`, 'info');
        this.changed();
      }, { dataset: { mic: 'channel' }, title: 'Input the mic is plugged into' });
      const cal = m.splCalibrated
        ? h('span', { class: 'mic-state ok' }, icon('check', 12), `0 dBFS = ${m.splOffset.toFixed(1)} dB SPL`, m.calibratedAt ? h('em', {}, ` · ${new Date(m.calibratedAt).toLocaleDateString()}`) : null)
        : h('span', { class: 'mic-state' }, 'Not calibrated (dBFS)');
      const corr = m.micCal ? h('span', { class: 'mic-state ok', title: m.micCal.name }, icon('check', 12), m.micCal.name) : h('span', { class: 'mic-state' }, 'No correction file');
      const ident = h('input', { type: 'text', class: 'text mic-ident', value: [m.model, m.serial].filter(Boolean).join(' · '), placeholder: 'Model · serial number', 'aria-label': 'Model and serial number', dataset: { mic: 'ident' } }) as HTMLInputElement;
      ident.addEventListener('change', () => {
        const [model, ...rest] = ident.value.split('·').map((x) => x.trim());
        m.model = model || undefined;
        m.serial = rest.join(' ').trim() || undefined;
        app.save();
      });
      const users = app.settings.measurements.filter((c) => c.micId === m.id);
      const usedBy = users.length
        ? h('span', { class: 'mic-used', title: 'The measurements that use this mic' }, icon('wave', 11), users.map((c) => c.name).join(', '))
        : h('span', { class: 'mic-used dim' }, 'Not used by a measurement');
      return h(
        'div',
        { class: 'mic-row', dataset: { micId: m.id } },
        h('div', { class: 'mic-head' }, name, chSel, h('button', { class: 'btn tiny ghost', title: `Remove ${m.name}`, onclick: () => { this.app.settings.mics = this.mics.filter((x) => x !== m); this.changed(); } }, icon('trash', 13))),
        h('div', { class: 'mic-line' }, ident, usedBy),
        h(
          'div',
          { class: 'mic-line' },
          h('span', { class: 'mic-label' }, 'SPL'),
          cal,
          h('div', { class: 'spacer' }),
          m.splCalibrated ? h('button', { class: 'btn tiny ghost', title: 'Forget the SPL calibration', onclick: () => { m.splCalibrated = false; m.splOffset = 0; this.changed(); } }, 'Reset') : null,
          h('button', { class: 'btn tiny accent', onclick: () => this.calibrate(m), dataset: { mic: 'calibrate' } }, icon('target', 12), 'Calibrate'),
        ),
        h(
          'div',
          { class: 'mic-line' },
          h('span', { class: 'mic-label' }, 'Response'),
          corr,
          h('div', { class: 'spacer' }),
          m.micCal ? h('button', { class: 'btn tiny ghost', onclick: () => { m.micCal = null; this.changed(); } }, 'Remove') : null,
          h('button', { class: 'btn tiny', onclick: () => this.loadFile(m), title: 'Load the mic’s correction file (.txt, .cal, .frd, .csv)' }, icon('upload', 12), 'Load file…'),
        ),
      );
    });
    this.list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, 'No microphones yet. Add one for each measurement mic you own.')]));
  }

  /** The inventory as a file (without the inputs, which belong to this setup). */
  private exportInventory(): void {
    if (!this.mics.length) return this.app.toast('The inventory is empty.', 'warn');
    const data = { format: 'cal-mics', version: 1, mics: this.mics.map(({ channel: _c, ...m }) => m) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'microphones.calmics.json' }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Add the mics of an inventory file (a mic with the same id replaces the one here). */
  private importInventory(): void {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        const data = JSON.parse(await f.text()) as { format?: string; mics?: Partial<MicProfile>[] };
        if (data.format !== 'cal-mics' || !Array.isArray(data.mics)) throw new Error(`${f.name} is not a microphone inventory`);
        let n = 0;
        for (const raw of data.mics) {
          if (typeof raw.id !== 'string' || typeof raw.name !== 'string') continue;
          const mic: MicProfile = { id: raw.id, name: raw.name, model: raw.model, serial: raw.serial, channel: -1, micCal: raw.micCal ?? null, splOffset: Number(raw.splOffset) || 0, splCalibrated: !!raw.splCalibrated, calibratedAt: raw.calibratedAt, calLevel: raw.calLevel };
          const i = this.mics.findIndex((x) => x.id === mic.id);
          if (i >= 0) this.mics[i] = { ...mic, channel: this.mics[i].channel };
          else this.mics.push(mic);
          n++;
        }
        this.app.toast(`${n} microphone${n === 1 ? '' : 's'} imported`, 'ok');
        this.changed();
      } catch (e) {
        this.app.toast((e as Error).message, 'warn');
      }
    });
    document.body.append(input);
    input.click();
  }
}
