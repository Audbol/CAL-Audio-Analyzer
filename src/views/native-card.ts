import type { App } from '../app';
import { h, icon, select } from '../ui/dom';
import { NativeAudio } from '../native/client';
import type { NativeHostState, NativeSettings } from '../remote/protocol';
import { nativeApi } from '../native/apis';

/**
 * Tools card for native audio (desktop app: ASIO, Core Audio, JACK / PipeWire, ALSA): sample rate, driver
 * buffer size, the generator safety margin, the driver's own control panel (ASIO) and live stream status. Hidden where native audio isn't available.
 * On a remote device it shows and changes the host's settings (when the host is the desktop app).
 */
export class NativeCard {
  readonly el = h('section', { class: 'tool-card native-card', style: 'display:none' });
  private status = h('div', { class: 'dim small native-status' });
  private controls = h('div', { class: 'native-controls' });
  private panelBtn: HTMLButtonElement;
  private lastUnderruns = 0;
  /** Remote: the host's native state as last reported. */
  private host: NativeHostState | null = null;
  private hostKey = '';

  constructor(private app: App) {
    this.panelBtn = h('button', { class: 'btn small', title: 'Open the driver’s own settings (buffer size, clock source, routing)', onclick: () => void app.openNativePanel() }, icon('settings', 14), 'Driver control panel');
    this.el.append(
      h('h4', {}, icon('sliders', 15), app.remote ? ' Audio interface on the host' : ' Audio interface (native driver)'),
      h(
        'p',
        { class: 'dim small' },
        app.remote
          ? 'The measurement host’s native audio settings. Choose its driver in the source menu (Measurement host). Changes reopen the host’s audio stream.'
          : 'Choose your interface’s native driver as the input source (top left): ASIO on Windows, Core Audio on macOS, JACK / PipeWire or ALSA on Linux. You get every input and output channel and the lowest latency, and the generator’s own signal stays sample-aligned with the inputs as the internal reference.',
      ),
      this.controls,
      this.status,
    );
    this.render();
    if (!app.remote)
      void NativeAudio.available().then((ok) => {
        if (ok) this.el.style.display = '';
      });
    this.update();
  }

  /** The settings shown: this app's, or (on a remote) the host's. */
  private get settings(): NativeSettings {
    return this.app.remote ? (this.host?.settings ?? { sampleRate: 48000, bufferFrames: 0, safetyMs: 80 }) : this.app.settings.nativeAudio;
  }

  /** The API of the selected native source (here, or the host's). */
  private get api(): string {
    return (this.app.remote ? this.host?.api : this.app.nativeSelection()?.api) ?? '';
  }

  /** Build the controls from the current settings. */
  render(): void {
    const s = this.settings;
    const info = nativeApi(this.api);
    // ASIO drivers have their own settings window; JACK / PipeWire set the rate and buffer for every program
    this.panelBtn.style.display = info.controlPanel ? '' : 'none';
    const set = (patch: Partial<NativeSettings>) => this.app.setNative(patch);
    // JACK / PipeWire: the server's rate and buffer (shown in the status line below), not settings of the app
    const format = info.serverFormat
      ? h('p', { class: 'dim small', dataset: { native: 'server-format' } }, 'Sample rate and buffer: set by JACK / PipeWire for every program (the status below shows them). Change them in the server’s settings, e.g. pw-metadata -n settings 0 clock.force-rate 48000 for PipeWire.')
      : h(
        'div',
        { class: 'row gap8 wrap' },
        h('span', {}, 'Sample rate'),
        select([44100, 48000, 88200, 96000, 176400, 192000].map((v) => ({ value: v, label: `${v / 1000} kHz` })), s.sampleRate, (v) => set({ sampleRate: v }), { dataset: { native: 'rate' } }),
        h('span', {}, 'Buffer'),
        select(
          [{ value: 0, label: 'Driver setting' }, ...[64, 128, 256, 512, 1024, 2048].map((v) => ({ value: v, label: `${v} samples` }))],
          s.bufferFrames,
          (v) => set({ bufferFrames: v }),
          { title: 'Driver buffer size. Measurements don’t need a small buffer; larger is more robust.', dataset: { native: 'buffer' } },
        ),
      );
    this.controls.replaceChildren(
      format,
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('span', {}, 'Safety margin'),
        select([20, 40, 80, 150, 300].map((v) => ({ value: v, label: `${v} ms` })), s.safetyMs, (v) => set({ safetyMs: v }), {
          title: 'Generator signal prepared ahead of the driver. Raise it if the status reports dropouts.',
          dataset: { native: 'safety' },
        }),
        this.panelBtn,
      ),
    );
    this.update();
  }

  /** Remote: the host's native state from its status (the card shows only when the host has native audio). */
  adoptHost(st: NativeHostState | undefined): void {
    if (!this.app.remote) return;
    const key = JSON.stringify(st?.settings ?? null) + (st?.available ?? false) + (st?.api ?? '');
    this.host = st ?? null;
    this.el.style.display = st?.available ? '' : 'none';
    if (key !== this.hostKey) {
      this.hostKey = key;
      this.render();
    } else this.update();
  }

  /** Refresh the status line (called by the Tools view while visible, and on status updates). */
  update(): void {
    if (this.app.remote) {
      this.panelBtn.disabled = !this.host?.active;
      const text = this.host ? this.host.text || (this.host.active ? 'Running.' : 'Not in use on the host.') : '';
      if (this.status.textContent !== text) this.status.textContent = text;
      return;
    }
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
        if (this.lastUnderruns === 0) this.app.toast('The generator signal had a dropout. If it repeats, raise the safety margin (Tools → Setup → Audio interface).', 'warn');
        this.lastUnderruns = st.underruns;
      }
      if (st && st.underruns < this.lastUnderruns) this.lastUnderruns = st.underruns;
    }
    // Remote devices show the same line
    this.app.nativeStatusText = text;
    if (this.status.textContent !== text) this.status.textContent = text;
  }
}
