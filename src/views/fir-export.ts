import type { App } from '../app';
import { h, icon, select } from '../ui/dom';
import { modal } from '../ui/dialogs';
import { Plot } from '../ui/plot';
import { CHART } from '../ui/theme';
import { eqResponse, type PeqFilter } from '../dsp/eq';
import { designFir, firResponse, wavBytes, type FirOptions, type FirResult } from '../dsp/fir';
import { logGrid } from '../dsp/freq';

type Format = 'float32' | 'pcm24' | 'txt';

/** Remembered between exports (the processor's sample rate and the format it loads rarely change). */
let last: FirOptions & { format: Format } = { fs: 48000, taps: 8192, phase: 'minimum', headroom: true, format: 'float32' };

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fmtHz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`);

/**
 * EQ → Export FIR: the parametric EQ as an impulse response (WAV or a coefficient list) for convolution in a
 * DSP, a convolution player or a plug-in. Shows how closely the FIR follows the EQ at the chosen length.
 */
export function showFirExport(app: App, filters: PeqFilter[], name: string): void {
  if (!filters.length) return app.toast('No filters to export yet: press Calculate EQ first', 'warn');
  const o = { ...last };
  const plot = new Plot({ xType: 'log', xMin: 20, xMax: 20000, yMin: -18, yMax: 12, yUnit: 'dB', yStep: 3, title: 'EQ and the FIR filter', yLimits: [-60, 30] });
  const info = h('p', { class: 'small fir-info', role: 'status' });
  let result: FirResult | null = null;
  const grid = logGrid(20, 20000, 24);
  const update = () => {
    try {
      result = designFir(filters, o);
    } catch (e) {
      result = null;
      info.textContent = (e as Error).message;
      return;
    }
    const r = result;
    const top = Math.min(20000, o.fs * 0.45);
    const x = grid.filter((f) => f <= top);
    const want = eqResponse(filters.filter((f) => !r.skipped.includes(f)), x).map((v) => v + r.gainDb);
    plot.series = [
      { id: 'eq', label: 'Parametric EQ', x, y: want, color: CHART.warn, width: 3 },
      { id: 'fir', label: 'FIR', x, y: firResponse(r.taps, o.fs, x), color: CHART.accent, width: 1.6 },
    ];
    plot.shades = r.accurateFrom > 21 ? [{ x0: 20, x1: r.accurateFrom, color: CHART.shade }] : [];
    plot.draw();
    const parts = [
      r.accurateFrom > 21 ? `Matches the EQ within 1 dB from ${fmtHz(r.accurateFrom)} up; below that it is too short (choose a longer filter).` : 'Matches the EQ within 1 dB across the whole range.',
      o.phase === 'linear' ? `Latency ${r.latencyMs.toFixed(1)} ms: delay the other speakers by the same amount, or use minimum phase.` : 'No latency: it behaves like the parametric filters.',
      r.gainDb < -0.05 ? `Level lowered by ${(-r.gainDb).toFixed(1)} dB so boosts cannot clip.` : '',
      r.skipped.length ? `${r.skipped.length} filter(s) at or above half the sample rate left out.` : '',
    ];
    info.textContent = parts.filter(Boolean).join(' ');
  };
  const field = (label: string, el: HTMLElement, hint = '') => h('label', { class: 'cmp-field', title: hint }, h('span', {}, label), el);
  const lengths = [1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const lengthSel = () =>
    select(
      lengths.map((n) => ({ value: n, label: `${n} taps (${((n / o.fs) * 1000).toFixed(0)} ms)` })),
      o.taps,
      (v) => {
        o.taps = v;
        update();
      },
      { dataset: { fir: 'taps' } },
    );
  const lengthHost = h('span', {}, lengthSel());
  const headroom = h('input', { type: 'checkbox', checked: o.headroom, dataset: { fir: 'headroom' } }) as HTMLInputElement;
  headroom.addEventListener('change', () => {
    o.headroom = headroom.checked;
    update();
  });
  const body = h(
    'div',
    { class: 'fir-export' },
    h('p', { class: 'dim small' }, `The ${filters.length} EQ filters as an impulse response, for DSPs, convolution players and plug-ins that load one. Use the processor’s own sample rate.`),
    h(
      'div',
      { class: 'row gap8 wrap' },
      field(
        'Sample rate',
        select(
          [44100, 48000, 88200, 96000, 192000].map((v) => ({ value: v, label: `${v / 1000} kHz` })),
          o.fs,
          (v) => {
            o.fs = v;
            lengthHost.replaceChildren(lengthSel());
            update();
          },
          { dataset: { fir: 'fs' } },
        ),
      ),
      field('Length', lengthHost, 'Longer filters reach lower frequencies (and, in linear phase, add more latency)'),
      field(
        'Phase',
        select(
          [
            { value: 'minimum' as const, label: 'Minimum phase (no latency)' },
            { value: 'linear' as const, label: 'Linear phase (latency)' },
          ],
          o.phase,
          (v) => {
            o.phase = v;
            update();
          },
          { dataset: { fir: 'phase' } },
        ),
        'Minimum phase sounds like the parametric filters; linear phase changes only the level',
      ),
      field(
        'File',
        select(
          [
            { value: 'float32' as const, label: 'WAV, 32-bit float' },
            { value: 'pcm24' as const, label: 'WAV, 24-bit' },
            { value: 'txt' as const, label: 'Text, one coefficient per line' },
          ],
          o.format,
          (v) => (o.format = v),
          { dataset: { fir: 'format' } },
        ),
      ),
    ),
    h('label', { class: 'cmp-check' }, headroom, 'Lower the level so boosts cannot clip'),
    h('div', { class: 'fir-plot' }, plot.el),
    info,
  );
  const save = h(
    'button',
    {
      class: 'btn accent',
      dataset: { fir: 'save' },
      onclick: () => {
        if (!result) return;
        const base = `${(name || 'EQ').replace(/[^\w.-]+/g, '_')}_FIR_${o.phase === 'linear' ? 'linear' : 'minimum'}_${o.fs / 1000}k_${o.taps}`;
        if (o.format === 'txt') saveBlob(`${base}.txt`, new Blob([Array.from(result.taps, (v) => v.toExponential(9)).join('\n') + '\n'], { type: 'text/plain' }));
        else saveBlob(`${base}.wav`, new Blob([wavBytes(result.taps, o.fs, o.format)], { type: 'audio/wav' }));
        last = { ...o };
        app.toast('FIR filter saved', 'ok');
      },
    },
    icon('download', 15),
    'Save FIR',
  );
  const { el, close } = modal('Export FIR filter', body, [h('div', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), save]);
  el.classList.add('fir-modal');
  // Remove the plot from the redraw list when the dialog goes
  new MutationObserver((_, obs) => {
    if (el.isConnected) return;
    obs.disconnect();
    plot.dispose();
  }).observe(document.body, { childList: true });
  requestAnimationFrame(() => {
    plot.resize();
    update();
  });
}
