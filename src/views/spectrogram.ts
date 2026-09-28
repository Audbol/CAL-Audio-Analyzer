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

  constructor(private app: App) {
    const s = app.settings;
    this.sg.dbMin = s.spectrogramRange[0];
    this.sg.dbMax = s.spectrogramRange[1];
    this.chSel = h('span', {});
    const range = (idx: 0 | 1, label: string) => {
      const i = h('input', { type: 'number', class: 'num', step: '5', value: String(s.spectrogramRange[idx]) });
      i.addEventListener('change', () => {
        s.spectrogramRange[idx] = +i.value;
        this.sg.dbMin = s.spectrogramRange[0];
        this.sg.dbMax = s.spectrogramRange[1];
        app.save();
      });
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
        h('div', { class: 'tb-group' }, range(0, 'Floor'), range(1, 'Top'), h('span', { class: 'unit' }, 'dB')),
        h('div', { class: 'spacer' }),
        pauseBtn,
        h('button', { class: 'btn small', onclick: () => this.sg.clear() }, icon('trash', 14), 'Clear'),
      ),
      h('div', { class: 'pane fill' }, this.sg.el),
    );
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
        const offset = this.app.settings.splCalibrated ? this.app.settings.splOffset : 0;
        // One column per processed frame
        for (let i = 0; i < 8 && this.sa.process(ring, 1) > 0; i++) this.sg.push(this.sa.instantaneous, e.sampleRate / this.fft, offset);
      }
    }
    this.sg.draw();
  }
}
