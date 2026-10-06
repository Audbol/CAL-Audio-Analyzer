import type { App } from '../app';
import type { Series } from '../ui/plot';
import { h, select } from '../ui/dom';
import { allTargets, findTarget, targetsVersion } from '../dsp/eq';
import { showTargetEditor } from '../ui/target-editor';
import { targetLevel, targetShape } from '../dsp/target';

const TARGET_COLOR = '#ffb020';
/** The last entry of a target list: opens the custom target editor. */
export const EDIT_TARGETS = '__edit-targets';

/** The setting that holds a view's target choice. */
export type TargetKey = 'targetCurve' | 'roomTargetCurve';

/**
 * Target curve on the Spectrum, Transfer and Sweep & Room views: the chosen target shape, levelled to the
 * measurement (coherence-weighted mean over 250 Hz–4 kHz; on live data smoothed over time so it doesn't jitter),
 * drawn as a line with a ± tolerance band.
 */
export class TargetOverlay {
  private level: number | null = null;
  private selHost = h('span', { class: 'tb-target' });
  private tracesVersion = -1;
  private customVersion = -1;

  /** `live`: the data changes continuously, so the level follows it gently; otherwise it is set at once. */
  constructor(
    private app: App,
    readonly key: TargetKey = 'targetCurve',
    private live = true,
  ) {}

  private get choice(): string {
    return this.app.settings[this.key];
  }

  /** Toolbar group: the target select (built-ins and stored traces). */
  targetControl(): HTMLElement {
    this.renderSelect();
    return h('div', { class: 'tb-group' }, h('span', { class: 'tb-label' }, 'Target'), this.selHost);
  }

  /** Choose a target (e.g. one just made in the editor). */
  choose(id: string): void {
    this.app.settings[this.key] = id;
    this.level = null;
    this.app.save();
    this.renderSelect();
    this.app.syncSettingControls();
  }

  /** Tolerance band select (for the options panel). */
  toleranceControl(): HTMLElement {
    const s = this.app.settings;
    return select(
      [
        { value: 0, label: 'No band' },
        { value: 1, label: '±1 dB' },
        { value: 2, label: '±2 dB' },
        { value: 3, label: '±3 dB' },
        { value: 6, label: '±6 dB' },
      ],
      s.targetTolerance,
      (v) => {
        s.targetTolerance = v;
        this.app.save();
        this.app.syncSettingControls();
      },
      { title: 'Tolerance band around the target', dataset: { setting: 'targetTolerance' } },
    );
  }

  /** Rebuild the target list if the stored traces changed (views that don't draw the target every frame). */
  refresh(): void {
    if (this.app.traces.version !== this.tracesVersion || targetsVersion() !== this.customVersion) this.renderSelect();
  }

  /** Target choices change with the stored traces: rebuild the select when they did. */
  private renderSelect(): void {
    const app = this.app;
    const s = app.settings;
    this.tracesVersion = app.traces.version;
    this.customVersion = targetsVersion();
    const opts = [
      { value: 'off', label: 'Off' },
      ...allTargets().map((t) => ({ value: t.id, label: t.label, title: t.note })),
      ...app.traces.traces.map((t) => ({ value: `trace:${t.id}`, label: `Trace: ${t.name}` })),
      { value: EDIT_TARGETS, label: 'Custom targets…', title: 'Make your own target curves, or edit them' },
    ];
    if (!opts.some((o) => o.value === s[this.key])) s[this.key] = 'off';
    this.selHost.replaceChildren(
      select(
        opts,
        s[this.key],
        (v) => {
          if (v === EDIT_TARGETS) {
            this.renderSelect();
            showTargetEditor(app, (id) => {
              if (id) this.choose(id);
            }, s[this.key]);
            return;
          }
          s[this.key] = v;
          this.level = null;
          app.save();
          app.syncSettingControls();
        },
        { class: 'target-select', title: 'Target curve: a reference line to tune towards (levelled to the measurement automatically)', dataset: { setting: this.key } },
      ),
    );
  }

  /**
   * Series for the target (band + line), levelled to `data` (optionally weighted, e.g. by coherence).
   * Returns [] when no target is chosen or there is nothing to level it to.
   */
  series(freqs: ArrayLike<number>, data: ArrayLike<number> | null, weight?: ArrayLike<number> | null): Series[] {
    const app = this.app;
    const s = app.settings;
    if (app.traces.version !== this.tracesVersion || targetsVersion() !== this.customVersion) this.renderSelect();
    const choice = this.choice;
    const trace = choice.startsWith('trace:') ? app.traces.traces.find((t) => t.id === choice.slice(6)) : null;
    const shape = targetShape(choice, freqs, trace);
    if (!shape || !data) return [];
    const lvl = targetLevel(freqs, data, shape, weight);
    if (lvl === null) return [];
    // Follow level changes smoothly (a live measurement fluctuates)
    this.level = !this.live || this.level === null || Math.abs(lvl - this.level) > 12 ? lvl : this.level + 0.15 * (lvl - this.level);
    const target = Float64Array.from(shape, (v) => v + this.level!);
    const name = trace ? trace.name : (findTarget(choice)?.label ?? 'Target').replace(/ \(.*\)$/, '');
    const out: Series[] = [];
    const tol = s.targetTolerance;
    if (tol > 0) out.push({ id: 'target-band', label: '', x: freqs, y: target.map((v) => v + tol), band: target.map((v) => v - tol), color: TARGET_COLOR, quiet: true });
    out.push({ id: 'target', label: `Target: ${name}`, x: freqs, y: target, color: TARGET_COLOR, width: 1.8, dash: [7, 4] });
    return out;
  }

  /** The levelled target currently drawn (for reports), or null. */
  current(freqs: ArrayLike<number>): Float64Array | null {
    const choice = this.choice;
    const trace = choice.startsWith('trace:') ? this.app.traces.traces.find((t) => t.id === choice.slice(6)) : null;
    const shape = targetShape(choice, freqs, trace);
    return shape && this.level !== null ? Float64Array.from(shape, (v) => v + this.level!) : null;
  }
}
