import type { App, View } from '../app';
import { Spectrogram } from '../ui/spectrogram';
import { h, icon, select } from '../ui/dom';
import { SpectrumAnalyzer } from '../dsp/spectrum';

/** Scrolling spectrogram of any input channel (feedback hunting, noise identification, program monitoring). */
export class SpectrogramView implements View {
  id = 'spectrogram' as const;
  title = 'Spectrogram';
  icon = 'layers' as const;
  el = h('div', { class: 'single' });
  private sg = new Spectrogram();
  private sa: SpectrumAnalyzer | null = null;
  private channel = 0;
  private fft = 4096;
  private paused = false;
  private chSel: HTMLElement;
  /** Calibration offset the colour range is shifted by (the saved range is in dBFS). */
  private appliedCal = 0;
  private inputs: HTMLInputElement[] = [];
  private unit = h('span', { class: 'unit' }, 'dBFS');
  /** Recent levels (dB, as displayed) for the automatic range. */
  private recent: number[] = [];
  private autoFitted = false;

  constructor(private app: App) {
    const s = app.settings;
    this.chSel = h('span', {});
    const range = (idx: 0 | 1, label: string) => {
      const i = h('input', { type: 'number', class: 'num', step: '5' });
      // The inputs show the displayed unit (dB SPL when calibrated); the setting is kept in dBFS
      i.addEventListener('change', () => {
        s.spectrogramRange[idx] = +i.value - this.appliedCal;
        this.applyRange();
        app.save();
      });
      this.inputs[idx] = i;
      return h('label', { class: 'inline' }, h('span', { class: 'tb-label' }, label), i);
    };
    const pauseBtn = h('button', { class: 'btn small' }, icon('pause', 14), 'Pause');
    pauseBtn.addEventListener('click', () => {
      this.paused = !this.paused;
      pauseBtn.lastChild!.textContent = this.paused ? 'Resume' : 'Pause';
    });
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Channel'), this.chSel),
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Resolution'), select([2048, 4096, 8192, 16384].map((n) => ({ value: n, label: `${n / 1024}k FFT` })), this.fft, (v) => { this.fft = v; this.sa = null; })),
        h('div', { class: 'tb-group' }, range(0, 'Floor'), range(1, 'Top'), this.unit, h('button', { class: 'btn small', title: 'Fit the colour range to the current signal', onclick: () => this.autoRange() }, 'Auto')),
        h(
          'div',
          { class: 'tb-group' },
          h('span', { class: 'tb-label' }, 'Layout'),
          select(
            [
              { value: 'vertical' as const, label: 'Frequency ↑' },
              { value: 'horizontal' as const, label: 'Frequency →' },
            ],
            s.spectrogramLayout,
            (v) => {
              s.spectrogramLayout = v;
              this.sg.orientation = v;
              this.sg.invalidate();
              app.save();
            },
            { title: 'Frequency across (newest at the top) or up the side (newest at the right)' },
          ),
        ),
        h('div', { class: 'spacer' }),
        pauseBtn,
        h('button', { class: 'btn small', onclick: () => this.sg.clear() }, icon('trash', 14), 'Clear'),
      ),
      h('div', { class: 'pane fill' }, this.sg.el),
    );
    this.applyRange();
    this.sg.orientation = s.spectrogramLayout;
  }

  invalidate(): void {
    this.sg.invalidate();
  }

  private applyRange(): void {
    const r = this.app.settings.spectrogramRange;
    this.sg.dbMin = r[0] + this.appliedCal;
    this.sg.dbMax = r[1] + this.appliedCal;
    this.sg.invalidate();
    this.inputs.forEach((el, i) => (el.value = String(Math.round(r[i] + this.appliedCal))));
    this.unit.textContent = this.app.isCalibrated(this.channel) ? 'dB SPL' : 'dBFS';
  }

  /** Colour range from the recent signal: floor a little under the typical level, top just above the peaks. */
  autoRange(): boolean {
    const v = [...this.recent].sort((a, b) => a - b);
    if (v.length < 50) return false;
    const pick = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
    const top = Math.ceil((pick(0.995) + 3) / 5) * 5;
    const floor = Math.min(top - 30, Math.floor((pick(0.1) - 5) / 5) * 5);
    this.app.settings.spectrogramRange = [floor - this.appliedCal, top - this.appliedCal];
    this.applyRange();
    this.app.save();
    return true;
  }

  show(): void {
    this.chSel.replaceChildren(
      select(this.app.channelOptions(true), this.channel, (v) => {
        this.channel = v;
        this.sa = null;
      }),
    );
  }

  tick(): void {
    const e = this.app.engine;
    if (e.running && !this.paused) {
      const ring = e.ring(this.channel);
      if (ring) {
        if (!this.sa || this.sa.fs !== e.sampleRate) {
          this.sa = new SpectrumAnalyzer(e.sampleRate, this.fft, this.app.grid);
          this.sa.averaging = 1;
          this.sa.window = 'blackman-harris';
        }
        // The shown input's own mic calibration
        const offset = this.app.splOffsetFor(this.channel);
        // Calibration (possibly adopted from the measurement host) moves the levels: move the colour range with it
        if (offset !== this.appliedCal || !this.inputs[0].value) {
          this.appliedCal = offset;
          this.applyRange();
        }
        // One column per processed frame
        for (let i = 0; i < 8 && this.sa.process(ring, 1) > 0; i++) {
          this.sg.push(this.sa.instantaneous, e.sampleRate / this.fft, offset);
          this.sample(this.sa.instantaneous, e.sampleRate / this.fft, offset);
        }
        // Once, when the signal sits entirely outside the colour range (a solid colour), fit the range to it
        if (!this.autoFitted && this.recent.length >= 400) {
          this.autoFitted = true;
          const r = this.app.settings.spectrogramRange;
          const inside = this.recent.filter((d) => d > r[0] + offset && d < r[1] + offset).length;
          if (inside / this.recent.length < 0.2) this.autoRange();
        }
      }
    }
    this.sg.draw();
  }

  private sample(power: Float64Array, df: number, offset: number): void {
    // A spread of levels across the audio band (log-spaced bins) for the automatic range
    for (let f = 25; f < 18000; f *= 1.25) {
      const b = Math.round(f / df);
      if (b >= power.length) break;
      this.recent.push(10 * Math.log10(Math.max(power[b], 1e-30)) + offset);
    }
    if (this.recent.length > 4000) this.recent.splice(0, this.recent.length - 4000);
  }
}
