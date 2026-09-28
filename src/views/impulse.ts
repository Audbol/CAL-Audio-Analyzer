import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, select } from '../ui/dom';
import { energyTimeCurve } from '../dsp/acoustics';
import { speedOfSound } from '../dsp/delay';

/**
 * Live impulse response derived from the averaged transfer function: shows arrival time, reflections and
 * polarity, and lets the user set delay compensation directly from the IR peak.
 */
export class ImpulseView implements View {
  id = 'impulse' as const;
  title = 'Impulse';
  icon = 'target' as const;
  el = h('div', { class: 'live' });
  private lin: Plot;
  private etc: Plot;
  private info = h('div', { class: 'info-strip' });
  private measIdx = 0;
  private selHost = h('span', {});
  private lastPeakMs = 0;
  private counter = 0;

  constructor(private app: App) {
    this.lin = new Plot({ xType: 'lin', xMin: -5, xMax: 60, yMin: -1.1, yMax: 1.1, yUnit: 'norm.', xUnit: 'ms', title: 'Impulse response (linear, relative to current delay)', yLimits: [-10, 10] });
    this.etc = new Plot({ xType: 'lin', xMin: -5, xMax: 200, yMin: -70, yMax: 3, yUnit: 'dB', xUnit: 'ms', yStep: 10, title: 'Energy-time curve (log)', yLimits: [-160, 20] });
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Measurement'), this.selHost),
        h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Span'), select([20, 60, 150, 300].map((v) => ({ value: v, label: `${v} ms` })), 60, (v) => { this.lin.setDefaults({ xMax: v }); this.etc.setDefaults({ xMax: v * 3 }); })),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small accent', title: 'Add the IR peak offset to the measurement delay', onclick: () => this.applyPeak() }, icon('target', 14), 'Set delay to peak'),
      ),
      this.info,
      h('div', { class: 'panes' }, h('div', { class: 'pane big' }, this.lin.el), h('div', { class: 'pane' }, this.etc.el)),
    );
  }

  show(): void {
    const opts = this.app.measurements.length ? this.app.measurements.map((m, i) => ({ value: i, label: m.cfg.name })) : [{ value: 0, label: '—' }];
    this.selHost.replaceChildren(select(opts, this.measIdx, (v) => (this.measIdx = v)));
  }

  private applyPeak(): void {
    const m = this.app.measurements[this.measIdx];
    if (!m) return;
    m.cfg.delay = Math.max(0, m.cfg.delay + Math.round((this.lastPeakMs / 1000) * m.fs));
    m.reset();
    this.app.save();
    this.app.renderMeasurements();
    this.app.toast(`${m.cfg.name}: delay set to ${((m.cfg.delay / m.fs) * 1000).toFixed(2)} ms`, 'ok');
  }

  tick(): void {
    const m = this.app.measurements[this.measIdx];
    // IR computation is relatively costly; update ~8×/s
    if (m && m.tf.ready && this.counter++ % 8 === 0) {
      const pre = Math.round(0.02 * m.fs);
      const { ir, fs } = m.tf.impulseResponse(1, pre);
      const n = ir.length;
      const t = new Float64Array(n);
      let pk = 0;
      let pkIdx = pre;
      for (let i = 0; i < n; i++) {
        t[i] = ((i - pre) / fs) * 1000;
        if (Math.abs(ir[i]) > pk) {
          pk = Math.abs(ir[i]);
          pkIdx = i;
        }
      }
      const sign = m.cfg.invert ? -1 : 1;
      const norm = Float64Array.from(ir, (v) => (sign * v) / (pk || 1));
      const etc = energyTimeCurve(ir);
      this.lastPeakMs = t[pkIdx];
      this.lin.series = [{ id: 'ir', label: m.cfg.name, x: t, y: norm, color: m.cfg.color, width: 1.3 }];
      this.etc.series = [{ id: 'etc', label: m.cfg.name, x: t, y: etc, color: m.cfg.color, width: 1.3, fill: true }];
      this.lin.markers = [{ x: this.lastPeakMs, color: CHART.marker, label: `peak ${this.lastPeakMs.toFixed(2)} ms` }];
      this.etc.markers = this.lin.markers;
      const total = (m.cfg.delay / m.fs) * 1000 + this.lastPeakMs;
      const dist = (total / 1000) * speedOfSound(this.app.settings.tempC);
      const polarity = norm[pkIdx] < 0 ? '<b class="warn-text">inverted</b>' : 'normal';
      this.info.innerHTML = `Peak at <b>${this.lastPeakMs.toFixed(2)} ms</b> relative to the current delay · total arrival <b>${total.toFixed(2)} ms</b> (${dist.toFixed(2)} m @ ${this.app.settings.tempC} °C) · polarity ${polarity}`;
    } else if (!m || !m.tf.ready) {
      this.info.textContent = 'Waiting for transfer function data — start audio and turn on the generator.';
    }
    this.lin.draw();
    this.etc.draw();
  }
}
