import { CHART } from '../ui/theme';
import type { App, View } from '../app';
import { Plot } from '../ui/plot';
import { h, icon, numberInput, clear } from '../ui/dom';
import { roomModes, schroederFrequency, criticalDistance, type RoomMode } from '../dsp/acoustics';
import { speedOfSound } from '../dsp/delay';
import type { RoomView } from './room';

/** Axial modes of a rectangular room up to `fMax` (Hz), for comparing with a measurement. */
export function axialModes(room: { L: number; W: number; H: number }, c: number, fMax = 300): RoomMode[] {
  return roomModes(room.L, room.W, room.H, c, fMax).filter((m) => m.kind === 'axial');
}

const DIM_NAME = ['length', 'width', 'height'];
export const modeDimension = (m: RoomMode): string => DIM_NAME[m.n.findIndex((k) => k > 0)] ?? '';

/**
 * Room modes of a rectangular room: axial, tangential and oblique modes up to 400 Hz, the Schroeder frequency,
 * the critical distance, and the room's axial modes against the last sweep's measured response.
 */
export class ModesView implements View {
  id = 'modes' as const;
  title = 'Room modes';
  icon = 'cube' as const;
  el = h('div', { class: 'modes-view' });
  private plot: Plot;
  private measured: Plot;
  private table = h('div', { class: 'modes-table' });
  private measuredNote = h('p', { class: 'dim small' });
  private dirty = true;
  private sweepKey: unknown = null;

  constructor(private app: App) {
    this.plot = new Plot({ xType: 'log', xMin: 15, xMax: 400, yMin: 0, yMax: 3.4, yUnit: '', title: 'Predicted modes (axial ▮ tangential ▮ oblique ▮)', yLimits: [0, 4] });
    this.measured = new Plot({ xType: 'log', xMin: 15, xMax: 400, yMin: -30, yMax: 12, yUnit: 'dB', yStep: 6, title: 'Last sweep against the predicted axial modes', showNote: true, yLimits: [-120, 60] });
    const r = app.settings.room;
    const dim = (key: 'L' | 'W' | 'H' | 'rt', label: string, unit: string) =>
      h(
        'label',
        { class: 'inline' },
        label,
        numberInput(r[key], (v) => {
          r[key] = Math.max(0.1, v);
          if (key !== 'rt') r.known = true;
          app.save();
          this.dirty = true;
        }, { class: 'num', step: '0.1', 'aria-label': `${label} (${unit})` }),
        h('span', { class: 'unit' }, unit),
      );
    this.el.append(
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'tb-group' }, icon('cube', 15), h('span', { class: 'tb-label' }, 'Rectangular room')),
        h('div', { class: 'tb-group' }, dim('L', 'Length', 'm'), dim('W', 'Width', 'm'), dim('H', 'Height', 'm'), dim('rt', 'RT60', 's')),
      ),
      h(
        'div',
        { class: 'modes-body' },
        h('div', { class: 'modes-plots' }, h('div', { class: 'pane fill' }, this.plot.el), h('div', { class: 'pane fill' }, this.measured.el), this.measuredNote),
        this.table,
      ),
    );
  }

  show(): void {
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  tick(): void {
    // Redraw when the room or the last sweep changed
    const room = this.app.views.find((v) => v.id === 'room') as unknown as RoomView | undefined;
    const meas = room?.measuredResponse() ?? null;
    if (meas?.y !== this.sweepKey) {
      this.sweepKey = meas?.y ?? null;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const { L, W, H, rt } = this.app.settings.room;
    const c = speedOfSound(this.app.settings.tempC);
    const modes = roomModes(L, W, H, c, 400);
    const V = L * W * H;
    const fs = schroederFrequency(rt, V);
    const color = (m: RoomMode) => (m.kind === 'axial' ? CHART.warn : m.kind === 'tangential' ? CHART.accent : '#b18cff');
    const height = (m: RoomMode) => (m.kind === 'axial' ? 3 : m.kind === 'tangential' ? 2 : 1);
    this.plot.series = modes.map((m, i) => ({ id: `m${i}`, label: `${m.n.join(',')} ${m.kind}`, x: [m.f * 0.999, m.f, m.f * 1.001], y: [0, height(m), 0], color: color(m), width: 1.5, quiet: true }));
    this.plot.markers = [{ x: fs, color: CHART.marker, label: `Schroeder ${fs.toFixed(0)} Hz` }];
    // The measured response with the room's axial modes marked: peaks that line up are those modes
    const axial = modes.filter((m) => m.kind === 'axial' && m.f < fs * 1.2);
    if (meas) {
      this.measured.series = [{ id: 'fr', label: 'Last sweep', x: meas.x, y: meas.y, color: CHART.accent, width: 1.8 }];
      this.measured.markers = markersFor(axial);
      this.measuredNote.textContent = 'Peaks that line up with a dashed line are this room’s axial modes. Check the dimensions if none line up.';
    } else {
      this.measured.series = [];
      this.measured.markers = markersFor(axial);
      this.measuredNote.textContent = 'Run a sweep in Sweep & Room to compare the measured response with these modes.';
    }
    // Clusters of axial modes (a quick Bonello-style check)
    let issue = '';
    for (let i = 1; i < axial.length; i++) {
      if (axial[i].f - axial[i - 1].f < 2) {
        issue = `<p class="warn-text small">Coincident axial modes near ${axial[i].f.toFixed(0)} Hz: expect a strong resonance there.</p>`;
        break;
      }
    }
    const rows = axial
      .slice(0, 18)
      .map((m) => `<tr><td>${m.f.toFixed(1)} Hz</td><td>${m.n.join(' · ')}</td><td>${modeDimension(m)}</td></tr>`)
      .join('');
    clear(this.table);
    this.table.innerHTML = `<p class="small">Volume <b>${V.toFixed(1)} m³</b> · Schroeder frequency <b>${fs.toFixed(0)} Hz</b> · critical distance ≈ <b>${criticalDistance(V, rt).toFixed(2)} m</b> (Q=2)</p>${issue}<table class="mini-table"><tr><th>Axial mode</th><th>n</th><th>Dimension</th></tr>${rows}</table>`;
    this.plot.draw();
    this.measured.draw();
  }
}

/** Dashed lines at the axial modes, labelled where there is room for the label (at least 1/6 octave apart). */
function markersFor(axial: RoomMode[]): { x: number; color: string; label?: string; top: boolean }[] {
  let last = 0;
  return axial.slice(0, 14).map((m) => {
    const room = !last || Math.log2(m.f / last) >= 1 / 6;
    if (room) last = m.f;
    return { x: m.f, color: CHART.warn, label: room ? `${m.f.toFixed(0)}` : undefined, top: true };
  });
}
