import type { App } from '../app';
import type { Series } from '../ui/plot';
import { select } from '../ui/dom';
import { micAverage } from '../dsp/multimic';

export const MIC_AVG_COLOR = '#c792ff';

/** Toolbar select for the multi-mic average (Spectrum and Transfer views share the setting). */
export function micAverageControl(app: App): HTMLElement {
  const s = app.settings;
  return select(
    [
      { value: 'off' as const, label: 'Mic average: off' },
      { value: 'avg' as const, label: 'Mic average' },
      { value: 'spread' as const, label: 'Average + spread' },
      { value: 'only' as const, label: 'Average only' },
    ],
    s.micAverage,
    (v) => {
      s.micAverage = v;
      app.save();
      app.syncSettingControls();
    },
    { title: 'Live power average of all shown measurement mics, with the spread between them (lowest to highest)', dataset: { setting: 'micAverage' } },
  );
}

/** Average (and spread band) of the given curves, or [] when off or fewer than two mics have data. */
export function micAverageSeries(app: App, x: ArrayLike<number>, curves: ArrayLike<number>[], weights?: (ArrayLike<number> | null)[]): Series[] {
  const mode = app.settings.micAverage;
  if (mode === 'off') return [];
  const r = micAverage(curves, weights);
  if (!r) return [];
  const out: Series[] = [];
  if (mode !== 'avg') out.push({ id: 'mic-spread', label: '', x, y: r.hi, band: r.lo, color: MIC_AVG_COLOR, quiet: true });
  out.push({ id: 'mic-avg', label: `Average of ${r.count} mics`, x, y: r.avg, color: MIC_AVG_COLOR, width: 2.4, halo: app.settings.theme === 'day' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)' });
  return out;
}
