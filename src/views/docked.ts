import type { App } from '../app';
import { h, icon } from '../ui/dom';
import { Dock, type DockLayout, type DockPanel } from '../ui/dock';
import { Plot } from '../ui/plot';
import { SplPanel, LevelsPanel } from './meters';

type LayoutKey = 'spectrumLayout' | 'transferLayout';

/**
 * Base for views whose displays live in a panel dock (Spectrum, Transfer). Handles the dock, layout
 * persistence, panel show/hide chips and the shared SPL / level meter panels.
 */
export abstract class DockedView {
  el = h('div', { class: 'live' });
  protected dock!: Dock;
  protected spl: SplPanel;
  protected levels: LevelsPanel;
  private chips = new Map<string, HTMLButtonElement>();
  private meterTick = 0;

  constructor(
    protected app: App,
    private layoutKey: LayoutKey,
    private defaultLayout: () => DockLayout,
  ) {
    this.spl = new SplPanel(app);
    this.levels = new LevelsPanel(app);
  }

  protected plotPanel(id: string, title: string, plot: Plot): DockPanel {
    return { id, title, body: h('div', { class: 'pane-fill' }, plot.el), onResize: () => plot.resize() };
  }

  protected meterPanels(): DockPanel[] {
    return [
      { id: 'spl', title: 'SPL meter', body: this.spl.el },
      { id: 'levels', title: 'Input levels', body: this.levels.el },
    ];
  }

  /** Create the dock; call from the subclass constructor once its panels exist. */
  protected mountDock(panels: DockPanel[], toolbar: HTMLElement): void {
    const s = this.app.settings;
    if (!s[this.layoutKey]) s[this.layoutKey] = this.defaultLayout();
    this.dock = new Dock(
      panels,
      s[this.layoutKey]!,
      (layout) => {
        s[this.layoutKey] = layout;
        this.app.save();
        this.syncChips();
      },
      (msg) => this.app.toast(msg, 'warn'),
    );
    this.el.append(toolbar, this.dock.el);
    this.syncChips();
  }

  protected panelChip(id: string, label: string, title: string): HTMLButtonElement {
    const b = h('button', { class: 'chip', title: `Show / hide the ${title} panel` }, label);
    b.addEventListener('click', () => this.dock.setVisible(id, !this.dock.isVisible(id)));
    this.chips.set(id, b);
    return b;
  }

  protected settingChip(key: 'showCoherence' | 'peakHold', label: string, title: string): HTMLButtonElement {
    const s = this.app.settings;
    const b = h('button', { class: `chip${s[key] ? ' on' : ''}`, title }, label);
    b.addEventListener('click', () => {
      s[key] = !s[key];
      b.classList.toggle('on', s[key]);
      this.app.save();
    });
    return b;
  }

  protected layoutButtons(): HTMLElement[] {
    return [
      h('button', { class: 'btn small ghost', title: 'Restore the default panel arrangement', onclick: () => this.dock.reset(this.defaultLayout()) }, icon('layout', 14), 'Reset layout'),
      h('button', { class: 'btn small', title: 'Reset all averages (R)', onclick: () => this.app.resetAverages() }, icon('reset', 14), 'Reset'),
    ];
  }

  private syncChips(): void {
    for (const [id, b] of this.chips) b.classList.toggle('on', this.dock.isVisible(id));
  }

  /** Set by `tick(true)`: this view is not the active tab, only its detached panels are drawn. */
  protected detachedOnly = false;

  setCompact(compact: boolean): void {
    this.dock.setCompact(compact);
  }

  hasDetached(): boolean {
    return this.dock.hasDetached;
  }

  protected visible(id: string): boolean {
    return this.dock.isVisible(id) && (!this.detachedOnly || this.dock.isPopped(id));
  }

  /** Numeric meters don't need 60 fps. */
  protected tickMeters(): void {
    if (this.meterTick++ % 3 !== 0) return;
    if (this.visible('spl')) this.spl.render();
    if (this.visible('levels')) this.levels.render();
  }
}
