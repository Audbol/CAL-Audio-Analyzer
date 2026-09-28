import type { App } from '../app';
import { h } from '../ui/dom';
import type { Averaging } from '../dsp/transfer';

/** Shared pieces of the Spectrum and Transfer views: averaging options and the SPL / input-level meter panels. */

export const AVG_OPTIONS: { value: Averaging; label: string }[] = [
  { value: 1, label: 'None' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
  { value: 8, label: '8' },
  { value: 16, label: '16' },
  { value: 32, label: '32' },
  { value: 64, label: '64' },
  { value: 0, label: '∞ (cumulative)' },
];

/** Coherence → opacity mapping used for coherence blanking. */
export function cohAlpha(coh: Float64Array, threshold: number, out: Float64Array): Float64Array {
  for (let i = 0; i < coh.length; i++) {
    const c = coh[i];
    out[i] = c >= threshold ? 1 : 0.08 + 0.6 * Math.pow(c / Math.max(threshold, 1e-3), 2);
  }
  return out;
}

/** Big-number sound level readout that scales with its panel. */
export class SplPanel {
  readonly el = h('div', { class: 'spl-panel' });

  constructor(private app: App) {}

  render(): void {
    const s = this.app.settings;
    const r = this.app.splReading;
    const run = this.app.engine.running && r;
    const unit = s.splCalibrated ? `dB(${s.splWeighting})` : `dBFS(${s.splWeighting})`;
    const f = (v: number | undefined) => (run && v !== undefined && Number.isFinite(v) ? v.toFixed(1) : '—');
    this.el.innerHTML =
      `<div class="spl-val">${f(r?.level)}</div>` +
      `<div class="spl-unit">${unit} · ${s.splTime === 'fast' ? 'Fast' : 'Slow'}${s.splCalibrated ? '' : ' · <span class="warn-text">uncal.</span>'}</div>` +
      `<div class="spl-row"><span>L<sub>eq</sub> <b>${f(r?.leq)}</b></span><span>L<sub>max</sub> <b>${f(r?.max)}</b></span><span>Pk <b>${f(r?.peakHold)}</b></span></div>`;
  }
}

const METER_FLOOR = -60;
const pct = (db: number) => Math.max(0, Math.min(100, ((db - METER_FLOOR) / -METER_FLOOR) * 100));

/** Vertical input / generator level meters with peak, RMS, peak hold and clip indicators. */
export class LevelsPanel {
  readonly el = h('div', { class: 'levels-panel' });
  private holds: { v: number; t: number }[] = [];

  constructor(private app: App) {}

  render(): void {
    const e = this.app.engine;
    const chans = [...e.levels.map((l, i) => ({ l, label: `In ${i + 1}`, gen: false })), { l: e.genLevel, label: 'Gen', gen: true }];
    if (this.el.childElementCount !== chans.length + 1) {
      this.el.replaceChildren(
        h('div', { class: 'lv-scale' }, ...[0, -6, -12, -24, -36, -48, -60].map((d) => h('span', { style: `bottom:${pct(d)}%` }, String(d)))),
        ...chans.map((c, i) =>
          h(
            'div',
            {
              class: `lv-col${c.gen ? ' gen' : ''}`,
              title: c.gen ? 'Generator output' : `Input ${i + 1} · click to reset clip / hold`,
              onclick: () => {
                // Look the level up at click time: the engine replaces its level objects when restarted
                const lvl = c.gen ? e.genLevel : e.levels[i];
                if (lvl) lvl.clipped = false;
                this.holds[i] = { v: -Infinity, t: 0 };
              },
            },
            h('div', { class: 'lv-clip' }, 'CLIP'),
            h('div', { class: 'lv-bar' }, h('i', { class: 'lv-rms' }), h('i', { class: 'lv-peak' }), h('i', { class: 'lv-hold' })),
            h('div', { class: 'lv-val' }, '—'),
            h('div', { class: 'lv-label' }, c.label),
          ),
        ),
      );
    }
    const now = performance.now();
    chans.forEach((c, i) => {
      const col = this.el.children[i + 1] as HTMLElement;
      const pk = 20 * Math.log10(Math.max(c.l.peak, 1e-6));
      const rms = 20 * Math.log10(Math.max(c.l.rms, 1e-6)) + 3.01;
      const hold = (this.holds[i] ??= { v: -Infinity, t: 0 });
      if (pk >= hold.v || now - hold.t > 2000) {
        hold.v = pk;
        hold.t = now;
      }
      (col.querySelector('.lv-rms') as HTMLElement).style.height = `${pct(rms)}%`;
      (col.querySelector('.lv-peak') as HTMLElement).style.height = `${pct(pk)}%`;
      (col.querySelector('.lv-hold') as HTMLElement).style.bottom = `${pct(hold.v)}%`;
      (col.querySelector('.lv-val') as HTMLElement).textContent = e.running && hold.v > -99 ? hold.v.toFixed(1) : '—';
      col.classList.toggle('clip', c.l.clipped);
      col.classList.toggle('hot', pk > -6);
    });
  }
}
