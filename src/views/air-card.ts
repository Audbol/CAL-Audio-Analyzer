import type { App } from '../app';
import { h, icon, numberInput } from '../ui/dom';
import { airAbsorption } from '../dsp/air';

/**
 * Tools → Setup → Air: temperature and humidity (speed of sound and air absorption, ISO 9613-1), and air
 * absorption compensation on Spectrum, Transfer, EQ and sweeps, over each measurement's distance (from its
 * delay) or a set distance. Shows how much each measurement loses to the air.
 */
export class AirCard {
  readonly el = h('section', { class: 'tool-card air-card' });
  private table = h('div', { class: 'air-table' });

  constructor(private readonly app: App) {
    this.render();
  }

  /** Apply a change: save, share with remote devices, redraw. */
  private changed(): void {
    this.app.airChanged();
    this.renderTable();
  }

  render(): void {
    const app = this.app;
    const s = app.settings;
    const air = s.air;
    const on = h('input', { type: 'checkbox', checked: air.compensate, dataset: { air: 'compensate' } }) as HTMLInputElement;
    on.addEventListener('change', () => {
      air.compensate = on.checked;
      this.changed();
    });
    const field = (label: string, el: HTMLElement, unit: string, hint: string) => h('label', { class: 'inline', title: hint }, label, el, h('span', { class: 'unit' }, unit));
    this.el.replaceChildren(
      h('h4', {}, icon('wave', 15), ' Air'),
      h('p', { class: 'dim small' }, 'The air takes treble over distance: several dB at 10 kHz over a long throw, more in dry air. Compensate it to see the loudspeaker’s own response (and EQ that), not the air’s. Temperature also sets the speed of sound for delays and distances.'),
      h(
        'div',
        { class: 'row gap8 wrap' },
        field('Temperature', numberInput(s.tempC, (v) => { s.tempC = Math.max(-20, Math.min(50, v)); this.changed(); }, { class: 'num', step: '1', dataset: { air: 'temp' }, 'aria-label': 'Air temperature (°C)' }), '°C', 'Air temperature at the audience'),
        field('Humidity', numberInput(air.humidity, (v) => { air.humidity = Math.max(5, Math.min(100, v)); this.changed(); }, { class: 'num', step: '5', dataset: { air: 'humidity' }, 'aria-label': 'Relative humidity (%)' }), '%', 'Relative humidity'),
      ),
      h('label', { class: 'cmp-check' }, on, 'Compensate air absorption (Spectrum, Transfer, EQ and sweeps)'),
      h(
        'div',
        { class: 'row gap8 wrap' },
        field('Distance', numberInput(air.distance, (v) => { air.distance = Math.max(0, Math.min(500, v)); this.changed(); }, { class: 'num', step: '1', dataset: { air: 'distance' }, 'aria-label': 'Distance to compensate (m), 0 = from each measurement’s delay' }), 'm', '0: each measurement’s own distance, from its delay'),
        h('span', { class: 'dim small' }, '0 = each measurement’s distance from its delay (which includes a little system latency).'),
      ),
      this.table,
    );
    this.renderTable();
  }

  /** The loss at 4, 8 and 16 kHz for each measurement's distance (or the set distance). */
  renderTable(): void {
    const app = this.app;
    const s = app.settings;
    const freqs = [4000, 8000, 16000];
    const rows = s.measurements.map((m) => ({ name: m.name, d: s.air.distance > 0 ? s.air.distance : app.measurementDistance(m) }));
    if (!rows.length) return void this.table.replaceChildren();
    const fmt = (f: number) => `${f / 1000} kHz`;
    this.table.innerHTML = `<table class="mini-table"><tr><th>Air loss</th><th>Distance</th>${freqs.map((f) => `<th>${fmt(f)}</th>`).join('')}</tr>${rows
      .map((r) => `<tr><th>${escapeHtml(r.name)}</th><td>${r.d.toFixed(1)} m</td>${freqs.map((f) => `<td>${(airAbsorption(f, s.tempC, s.air.humidity) * r.d).toFixed(1)} dB</td>`).join('')}</tr>`)
      .join('')}</table>`;
  }
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
