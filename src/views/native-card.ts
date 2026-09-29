import type { App } from '../app';
import { h, icon, select } from '../ui/dom';
import { NativeAudio } from '../native/client';

/**
 * Tools card for native audio (desktop app, ASIO): sample rate, driver buffer size, the generator safety
 * margin, the driver's own control panel and live stream status. Hidden where native audio isn't available.
 */
export class NativeCard {
  readonly el = h('section', { class: 'tool-card native-card', style: 'display:none' });
  private status = h('div', { class: 'dim small native-status' });
  private panelBtn: HTMLButtonElement;
  private lastUnderruns = 0;

  constructor(private app: App) {
    const s = app.settings.nativeAudio;
    const restart = () => {
      app.save();
      if (app.engine.nativeInfo) void app.start();
    };
    this.panelBtn = h('button', { class: 'btn small', title: 'Open the driver’s own settings (buffer size, clock source, routing)', onclick: () => this.openPanel() }, icon('settings', 14), 'Driver control panel');
    this.el.append(
      h('h4', {}, icon('sliders', 15), ' Audio interface (ASIO)'),
      h('p', { class: 'dim small' }, 'Choose an ASIO driver as the input source (top left) for the lowest latency and every input and output channel of your interface. The generator’s own signal stays sample-aligned with the inputs as the internal reference.'),
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('span', {}, 'Sample rate'),
        select([44100, 48000, 88200, 96000, 176400, 192000].map((v) => ({ value: v, label: `${v / 1000} kHz` })), s.sampleRate, (v) => {
          s.sampleRate = v;
          restart();
        }, { dataset: { native: 'rate' } }),
        h('span', {}, 'Buffer'),
        select(
          [{ value: 0, label: 'Driver setting' }, ...[64, 128, 256, 512, 1024, 2048].map((v) => ({ value: v, label: `${v} samples` }))],
          s.bufferFrames,
          (v) => {
            s.bufferFrames = v;
            restart();
          },
          { title: 'Driver buffer size. Measurements don’t need a small buffer; larger is more robust.', dataset: { native: 'buffer' } },
        ),
      ),
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('span', {}, 'Safety margin'),
        select(
          [20, 40, 80, 150, 300].map((v) => ({ value: v, label: `${v} ms` })),
          s.safetyMs,
          (v) => {
            s.safetyMs = v;
            app.save();
            app.engine.nativeLink?.setSafety(v);
          },
          { title: 'Generator signal prepared ahead of the driver. Raise it if the status reports dropouts.', dataset: { native: 'safety' } },
        ),
        this.panelBtn,
      ),
      this.status,
    );
    void NativeAudio.available().then((ok) => {
      if (ok) this.el.style.display = '';
    });
    this.update();
  }

  private async openPanel(): Promise<void> {
    if (!this.app.engine.nativeInfo) return this.app.toast('Start audio with an ASIO driver first.', 'warn');
    const ok = await this.app.engine.native.controlPanel().catch(() => false);
    if (!ok) this.app.toast('This driver has no control panel.', 'info');
  }

  /** Refresh the status line (called by the Tools view while visible, and on status updates). */
  update(): void {
    const eng = this.app.engine;
    const info = eng.nativeInfo;
    const st = eng.nativeLink?.status;
    this.panelBtn.disabled = !info;
    let text: string;
    if (!info) text = this.app.nativeSelection() ? 'Stopped. Press Start to open the driver.' : 'Not in use: the browser audio path is active.';
    else {
      const ms = (n: number) => `${((n / info.sampleRate) * 1000).toFixed(1)} ms`;
      text = `${info.name} · ${info.sampleRate / 1000} kHz · buffer ${info.bufferFrames} (${ms(info.bufferFrames)}) · ${info.inputs} in / ${info.outputs} out · driver latency ${ms(info.latency)}`;
      if (st) text += ` · generator ready ${st.queuedMs.toFixed(0)} ms · dropouts ${st.underruns}${st.overruns ? ` · input overruns ${st.overruns}` : ''}${st.xruns ? ` · driver xruns ${st.xruns}` : ''}`;
      if (st && st.underruns > this.lastUnderruns) {
        if (this.lastUnderruns === 0) this.app.toast('The generator signal had a dropout. If it repeats, raise the safety margin (Tools → Audio interface).', 'warn');
        this.lastUnderruns = st.underruns;
      }
      if (st && st.underruns < this.lastUnderruns) this.lastUnderruns = st.underruns;
    }
    if (this.status.textContent !== text) this.status.textContent = text;
  }
}
