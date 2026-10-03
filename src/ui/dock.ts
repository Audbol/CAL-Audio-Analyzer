import { h, icon, clear } from './dom';

/**
 * Panel dock for measurement displays. Panels live in a vertical stack and can be:
 *  - rearranged: drag a panel's title bar up or down (drop it outside the stack to float it)
 *  - resized: drag the splitter between two docked panels, or the corner of a floating panel
 *  - floated: moved freely over the view as a window inside the app
 *  - popped out: detached into a separate OS window (e.g. on a second monitor); closing it re-docks
 * The layout (order, sizes, floating positions, hidden panels) is serialisable for persistence.
 */

export interface DockPanel {
  id: string;
  title: string;
  body: HTMLElement;
  /** Called whenever the panel's size or host window may have changed. */
  onResize?: () => void;
  /** Panels added in a later version: hidden in layouts saved before they existed. */
  hiddenByDefault?: boolean;
}

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DockLayout {
  order: string[];
  /** Relative heights (flex weights) of docked panels. */
  sizes: Record<string, number>;
  hidden: string[];
  /** Floating panels and their position inside the dock (px). Negative x / y anchor to the right / bottom edge. */
  floating: Record<string, FloatRect>;
  /** Last screen position and size of each panel's detached window (reused when it is detached again). */
  windows?: Record<string, FloatRect>;
  /** Panels that were detached when the app closed (the desktop app reopens them). */
  popped?: string[];
  /** Detached windows kept on top of other windows. */
  pinned?: string[];
}

type PipApi = { requestWindow(o: { width: number; height: number }): Promise<Window> };
function pipApi(): PipApi | null {
  return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null;
}

const MIN_DOCKED = 90;
const MIN_FLOAT_W = 180;
const MIN_FLOAT_H = 110;

export class Dock {
  readonly el: HTMLDivElement;
  private readonly stack: HTMLDivElement;
  private readonly layer: HTMLDivElement;
  private readonly indicator: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly frames = new Map<string, HTMLDivElement>();
  private readonly popups = new Map<string, Window>();
  /** Detached panel windows of every dock (the app schedules frames on them). */
  private static readonly windows = new Set<Window>();

  /** Desktop app: keep a detached window on top of all other windows (set by the app). */
  static pinWindow: ((name: string, on: boolean) => Promise<boolean>) | null = null;
  /** Reopen the windows that were detached when the app was last closed (desktop app only). */
  static restoreDetached = false;

  /** Pinning is possible: always-on-top windows in the desktop app, picture-in-picture in Chrome / Edge. */
  static get canPin(): boolean {
    return !!Dock.pinWindow || !!pipApi();
  }

  private unloading = false;

  static openWindows(): Window[] {
    return [...Dock.windows].filter((w) => !w.closed);
  }

  get hasDetached(): boolean {
    return this.popups.size > 0;
  }
  private zTop = 10;

  constructor(
    private readonly panels: DockPanel[],
    public layout: DockLayout,
    private readonly onChange: (layout: DockLayout) => void,
    private readonly notify: (msg: string) => void = () => undefined,
  ) {
    this.el = h('div', { class: 'dock' });
    this.stack = h('div', { class: 'dock-stack' });
    this.layer = h('div', { class: 'dock-layer' });
    this.indicator = h('div', { class: 'dock-drop' });
    this.empty = h('div', { class: 'dock-empty' }, 'All panels are floating, detached or hidden. Use the toolbar to show panels or Reset layout.');
    this.el.append(this.stack, this.layer, this.indicator);
    this.normalise(layout);
    for (const p of panels) this.frames.set(p.id, this.buildFrame(p));
    new ResizeObserver(() => this.clampFloating()).observe(this.el);
    window.addEventListener('beforeunload', () => {
      // Closing the app closes its detached windows; remember them so they can be reopened next time
      this.unloading = true;
      this.popups.forEach((w) => w.close());
    });
    // Escape leaves the maximised (fallback) full screen
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      for (const [id, f] of this.frames) {
        const doc = f.ownerDocument as Document & { webkitFullscreenElement?: Element };
        if (f.classList.contains('maximized') || (doc.fullscreenElement ?? doc.webkitFullscreenElement) === f) this.toggleFullscreen(id);
      }
    });
    this.render();
    if (Dock.restoreDetached) {
      const ids = (layout.popped ?? []).filter((id) => panels.some((p) => p.id === id) && this.isVisible(id));
      setTimeout(() => ids.forEach((id) => this.popOut(id)), 300);
    } else layout.popped = [];
  }

  // ------------------------------------------------------------------------------------------------------
  // Public API

  isVisible(id: string): boolean {
    return !this.layout.hidden.includes(id);
  }

  isPopped(id: string): boolean {
    return this.popups.has(id);
  }

  setVisible(id: string, visible: boolean): void {
    const hidden = new Set(this.layout.hidden);
    if (visible) hidden.delete(id);
    else {
      hidden.add(id);
      this.popups.get(id)?.close();
    }
    this.layout.hidden = [...hidden];
    this.commit();
  }

  float(id: string, rect?: FloatRect): void {
    const frame = this.frames.get(id)!;
    const host = this.el.getBoundingClientRect();
    const r = frame.getBoundingClientRect();
    const w = Math.max(MIN_FLOAT_W, Math.min(r.width * 0.6, host.width * 0.6, 720));
    const hgt = Math.max(MIN_FLOAT_H, Math.min(r.height, host.height * 0.6, 420));
    this.layout.floating[id] = rect ?? { x: Math.max(0, r.left - host.left + 24), y: Math.max(0, r.top - host.top + 24), w, h: hgt };
    this.commit();
  }

  dock(id: string): void {
    delete this.layout.floating[id];
    this.commit();
  }

  /** Detach a panel into its own browser / OS window (at the position it had last time). */
  popOut(id: string, opts: { pip?: boolean } = {}): void {
    const panel = this.panels.find((p) => p.id === id);
    const frame = this.frames.get(id);
    if (!panel || !frame || this.popups.has(id)) return;
    const r = frame.getBoundingClientRect();
    const saved = this.layout.windows?.[id];
    const w = Math.round(saved?.w ?? Math.max(480, r.width));
    const hgt = Math.round(saved?.h ?? Math.max(300, r.height + 30));
    const pinned = !!this.layout.pinned?.includes(id);
    const pip = pipApi();
    // In browsers, a pinned panel lives in a picture-in-picture window (always on top)
    if ((opts.pip || (pinned && !Dock.pinWindow)) && pip) {
      pip
        .requestWindow({ width: w, height: hgt })
        .then((win) => this.mount(id, win, true))
        .catch(() => {
          this.notify('The browser did not allow an always-on-top window here.');
          this.setPinned(id, false);
        });
      return;
    }
    const pos = saved ? `,left=${Math.round(saved.x)},top=${Math.round(saved.y)}` : '';
    const win = window.open('', `cal-panel-${id}`, `popup=yes,width=${w},height=${hgt}${pos}`);
    if (!win) {
      this.notify('The pop-out window was blocked. Allow pop-ups for this app and try again.');
      return;
    }
    this.mount(id, win, false);
    if (pinned && Dock.pinWindow) Dock.pinWindow(`cal-panel-${id}`, true).catch(() => undefined);
  }

  private pipIds = new Set<string>();

  private setPinned(id: string, on: boolean): void {
    const list = (this.layout.pinned ??= []).filter((x) => x !== id);
    if (on) list.push(id);
    this.layout.pinned = list;
    this.commit();
  }

  /** Keep a detached window on top of other windows (or stop doing so). */
  async togglePin(id: string): Promise<void> {
    const on = !this.layout.pinned?.includes(id);
    this.setPinned(id, on);
    if (Dock.pinWindow) {
      if (!this.popups.has(id)) return this.popOut(id);
      await Dock.pinWindow(`cal-panel-${id}`, on).catch(() => false);
      this.updateButtons(id);
      return;
    }
    // Browser: move the panel between a normal pop-up and a picture-in-picture window
    const win = this.popups.get(id);
    this.moving = true;
    win?.close();
    this.returnFromPopup(id);
    this.moving = false;
    this.popOut(id, { pip: on });
  }

  private moving = false;

  private mount(id: string, win: Window, isPip: boolean): void {
    const panel = this.panels.find((p) => p.id === id)!;
    const frame = this.frames.get(id)!;
    if (isPip) this.pipIds.add(id);
    else this.pipIds.delete(id);
    const doc = win.document;
    doc.title = `${panel.title} · CAL Audio Analyzer`;
    // Bring the app's styles along (inline <style> in development, <link> in production builds)
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
      if (node instanceof HTMLLinkElement) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = node.href;
        doc.head.append(link);
      } else doc.head.append(doc.importNode(node, true));
    }
    const meta = doc.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'dark';
    doc.head.append(meta);
    doc.body.className = 'popout-body';
    // Follow the main window's colour scheme (day / night), now and when it changes
    const syncTheme = () => {
      const t = document.documentElement.dataset.theme;
      if (t) doc.documentElement.dataset.theme = t;
      else delete doc.documentElement.dataset.theme;
    };
    syncTheme();
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    win.addEventListener('pagehide', () => themeObserver.disconnect());
    frame.classList.remove('floating');
    frame.classList.add('popped');
    frame.style.cssText = '';
    doc.body.append(frame);
    this.popups.set(id, win);
    Dock.windows.add(win);
    const resize = () => panel.onResize?.();
    win.addEventListener('resize', resize);
    // Stylesheets load asynchronously in the new window
    win.addEventListener('load', resize);
    setTimeout(resize, 60);
    setTimeout(resize, 400);
    win.addEventListener('pagehide', () => {
      if (this.popups.get(id) === win) this.returnFromPopup(id);
    });
    if (!(this.layout.popped ??= []).includes(id)) this.layout.popped.push(id);
    // Remember where the window is (there is no move event: poll while it is open)
    const track = window.setInterval(() => {
      if (win.closed || this.popups.get(id) !== win) return clearInterval(track);
      const rect = isPip
        ? { ...(this.layout.windows?.[id] ?? { x: win.screenX, y: win.screenY }), w: win.innerWidth, h: win.innerHeight }
        : { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight };
      const old = this.layout.windows?.[id];
      if (rect.w > 50 && rect.h > 50 && (!old || old.x !== rect.x || old.y !== rect.y || old.w !== rect.w || old.h !== rect.h)) {
        (this.layout.windows ??= {})[id] = rect;
        this.onChange(this.layout); // save only: nothing in this window changed
      }
    }, 700);
    this.render();
    this.commit();
  }

  /** Full screen a panel: native element full screen where supported, otherwise maximise it over the page. */
  toggleFullscreen(id: string): void {
    const frame = this.frames.get(id) as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    const doc = frame.ownerDocument as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const current = doc.fullscreenElement ?? doc.webkitFullscreenElement;
    if (current === frame) {
      (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
      return;
    }
    if (frame.classList.contains('maximized')) {
      frame.classList.remove('maximized');
      this.afterFullscreen(id);
      return;
    }
    const req = frame.requestFullscreen ?? frame.webkitRequestFullscreen;
    const fallback = () => {
      frame.classList.add('maximized');
      this.afterFullscreen(id);
    };
    if (!req) return fallback();
    try {
      const r = req.call(frame) as Promise<void> | undefined;
      r?.catch?.(fallback);
    } catch {
      fallback();
    }
  }

  private afterFullscreen(id: string): void {
    const frame = this.frames.get(id)!;
    const doc = frame.ownerDocument as Document & { webkitFullscreenElement?: Element };
    const on = (doc.fullscreenElement ?? doc.webkitFullscreenElement) === frame || frame.classList.contains('maximized');
    const b = frame.querySelector<HTMLButtonElement>('[data-act="fullscreen"]');
    if (b) {
      b.replaceChildren(icon(on ? 'minimize' : 'maximize', 13));
      b.title = on ? 'Exit full screen (Esc)' : 'Full screen (Esc to exit)';
    }
    frame.classList.toggle('is-fullscreen', on);
    const panel = this.panels.find((x) => x.id === id);
    requestAnimationFrame(() => panel?.onResize?.());
    setTimeout(() => panel?.onResize?.(), 150);
  }

  /** Compact mode (small screens): every visible panel is stacked in a scrolling column; no floating. */
  private compact = false;

  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.el.classList.toggle('compact', compact);
    this.render();
  }

  /** Make sure every known panel appears in the order list (new ones hidden when they ask for it). */
  private normalise(layout: DockLayout): void {
    for (const p of this.panels) {
      if (layout.order.includes(p.id)) continue;
      layout.order.push(p.id);
      if (p.hiddenByDefault && !layout.hidden.includes(p.id)) layout.hidden.push(p.id);
    }
    layout.order = layout.order.filter((id) => this.panels.some((p) => p.id === id));
  }

  reset(layout: DockLayout): void {
    this.popups.forEach((w) => w.close());
    this.normalise(layout);
    this.layout = layout;
    this.commit();
  }

  // ------------------------------------------------------------------------------------------------------
  // Rendering

  private commit(): void {
    this.render();
    this.onChange(this.layout);
  }

  private render(): void {
    const L = this.layout;
    const docked = L.order.filter((id) => this.isVisible(id) && (this.compact || !L.floating[id]) && !this.popups.has(id));
    clear(this.stack);
    docked.forEach((id, i) => {
      const frame = this.frames.get(id)!;
      frame.classList.remove('floating', 'popped');
      frame.style.cssText = '';
      frame.style.flex = `${L.sizes[id] ?? 1} 1 0`;
      if (i > 0) this.stack.append(this.splitter(docked[i - 1], id));
      this.stack.append(frame);
      this.updateButtons(id);
    });
    if (!docked.length) this.stack.append(this.empty);
    clear(this.layer);
    for (const id of L.order) {
      if (this.compact || !L.floating[id] || !this.isVisible(id) || this.popups.has(id)) continue;
      const frame = this.frames.get(id)!;
      frame.classList.add('floating');
      frame.classList.remove('popped');
      this.layer.append(frame);
      this.placeFloating(id);
      this.updateButtons(id);
    }
    for (const [id, frame] of this.frames) {
      if (!this.isVisible(id) && !this.popups.has(id)) frame.remove();
      else if (this.popups.has(id)) this.updateButtons(id);
    }
    requestAnimationFrame(() => this.panels.forEach((p) => p.onResize?.()));
  }

  private placeFloating(id: string): void {
    const frame = this.frames.get(id)!;
    const r = this.layout.floating[id];
    const host = this.el.getBoundingClientRect();
    const w = Math.min(Math.max(MIN_FLOAT_W, r.w), Math.max(MIN_FLOAT_W, host.width));
    const hgt = Math.min(Math.max(MIN_FLOAT_H, r.h), Math.max(MIN_FLOAT_H, host.height));
    let x = r.x < 0 ? host.width + r.x - w : r.x;
    x = Math.min(Math.max(0, x), Math.max(0, host.width - w));
    let y = r.y < 0 ? host.height + r.y - hgt : r.y;
    y = Math.min(Math.max(0, y), Math.max(0, host.height - hgt));
    frame.style.left = `${x}px`;
    frame.style.top = `${y}px`;
    frame.style.width = `${w}px`;
    frame.style.height = `${hgt}px`;
    frame.style.flex = '';
  }

  private clampFloating(): void {
    for (const id of Object.keys(this.layout.floating)) if (this.frames.get(id)?.classList.contains('floating')) this.placeFloating(id);
  }

  private updateButtons(id: string): void {
    const frame = this.frames.get(id)!;
    const popped = this.popups.has(id);
    const floating = !!this.layout.floating[id] && !popped;
    const fl = frame.querySelector<HTMLButtonElement>('[data-act="float"]')!;
    fl.replaceChildren(icon(floating || popped ? 'dock' : 'float', 13));
    fl.title = popped ? 'Return to the main window' : floating ? 'Dock back into the stack' : 'Float over the view';
    const po = frame.querySelector<HTMLButtonElement>('[data-act="popout"]')!;
    po.style.display = popped ? 'none' : '';
    const pin = frame.querySelector<HTMLButtonElement>('[data-act="pin"]')!;
    const pinned = !!this.layout.pinned?.includes(id);
    pin.style.display = popped && Dock.canPin ? '' : 'none';
    pin.classList.toggle('on', pinned);
    pin.title = pinned ? 'Pinned on top of other windows — click to unpin' : 'Pin: keep this window on top of other windows';
  }

  private buildFrame(p: DockPanel): HTMLDivElement {
    const btn = (act: string, ic: Parameters<typeof icon>[0], title: string) =>
      h('button', { class: 'dp-btn', dataset: { act }, title }, icon(ic, 13));
    const head = h(
      'div',
      { class: 'dp-head', title: 'Drag to rearrange · drop outside the stack to float' },
      h('span', { class: 'dp-grip' }, icon('grip', 13)),
      h('span', { class: 'dp-title' }, p.title),
      h('span', { class: 'spacer' }),
      btn('fullscreen', 'maximize', 'Full screen (Esc to exit)'),
      btn('float', 'float', 'Float over the view'),
      btn('pin', 'pin', 'Keep this window on top of other windows'),
      btn('popout', 'popout', 'Detach into a separate window'),
      btn('close', 'x', 'Hide panel'),
    );
    const grip = h('div', { class: 'dp-resize', title: 'Resize' });
    const frame = h('div', { class: 'dpanel', dataset: { panel: p.id } }, head, h('div', { class: 'dp-body' }, p.body), grip);
    head.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'fullscreen') this.toggleFullscreen(p.id);
      else if (act === 'close') this.setVisible(p.id, false);
      else if (act === 'popout') this.popOut(p.id);
      else if (act === 'pin') this.togglePin(p.id);
      else if (act === 'float') {
        if (this.popups.has(p.id)) this.popups.get(p.id)!.close();
        else if (this.layout.floating[p.id]) this.dock(p.id);
        else this.float(p.id);
      }
    });
    head.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('[data-act]') || this.popups.has(p.id)) return;
      if (this.layout.floating[p.id]) this.dock(p.id);
      else this.float(p.id);
    });
    // Native full screen (or the maximised fallback) changes the panel size
    frame.addEventListener('fullscreenchange', () => this.afterFullscreen(p.id));
    frame.addEventListener('webkitfullscreenchange', () => this.afterFullscreen(p.id));
    this.bindHeadDrag(p.id, head, frame);
    this.bindFloatResize(p.id, grip, frame);
    frame.addEventListener('pointerdown', () => {
      if (frame.classList.contains('floating')) frame.style.zIndex = String(++this.zTop);
    });
    return frame;
  }

  // ------------------------------------------------------------------------------------------------------
  // Interaction

  private bindHeadDrag(id: string, head: HTMLElement, frame: HTMLElement): void {
    let start: { x: number; y: number; fx: number; fy: number; mode: 'docked' | 'floating' } | null = null;
    let moved = false;
    let target = -1;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('[data-act]') || this.popups.has(id)) return;
      head.setPointerCapture(e.pointerId);
      const host = this.el.getBoundingClientRect();
      const r = frame.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, fx: r.left - host.left, fy: r.top - host.top, mode: this.layout.floating[id] ? 'floating' : 'docked' };
      if (start.mode === 'floating') frame.style.zIndex = String(++this.zTop);
      moved = false;
    });
    head.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (start.mode === 'floating') {
        const r = this.layout.floating[id];
        const host = this.el.getBoundingClientRect();
        // Keep the whole panel inside the view
        r.x = Math.min(Math.max(0, start.fx + dx), Math.max(0, host.width - frame.offsetWidth));
        r.y = Math.min(Math.max(0, start.fy + dy), Math.max(0, host.height - frame.offsetHeight));
        frame.style.left = `${r.x}px`;
        frame.style.top = `${r.y}px`;
        return;
      }
      frame.classList.add('dragging');
      frame.style.transform = `translate(${dx}px, ${dy}px)`;
      target = this.dropIndex(id, e.clientY);
      this.showIndicator(id, target, this.outside(e));
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      if (head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId);
      const mode = start.mode;
      const s = start;
      start = null;
      this.indicator.style.display = 'none';
      frame.classList.remove('dragging');
      frame.style.transform = '';
      if (!moved) return;
      if (mode === 'floating') {
        this.onChange(this.layout);
        return;
      }
      if (this.outside(e) && !this.compact) {
        // Dropped outside the stack: float it where it was released
        const host = this.el.getBoundingClientRect();
        const r = frame.getBoundingClientRect();
        this.float(id, {
          x: Math.max(0, s.fx + (e.clientX - s.x)),
          y: Math.max(0, Math.min(s.fy + (e.clientY - s.y), host.height - 60)),
          w: Math.min(r.width * 0.6, host.width * 0.6, 720),
          h: Math.min(r.height, host.height * 0.6, 420),
        });
        return;
      }
      if (target >= 0) this.moveTo(id, target);
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  /** Released far outside the docked stack (e.g. dragged sideways over the plots). */
  private outside(e: PointerEvent): boolean {
    const r = this.el.getBoundingClientRect();
    return e.clientX < r.left - 20 || e.clientX > r.right + 20 || e.clientY < r.top - 40 || e.clientY > r.bottom + 40;
  }

  private dockedIds(): string[] {
    return this.layout.order.filter((x) => this.isVisible(x) && !this.layout.floating[x] && !this.popups.has(x));
  }

  /** Index in the docked list (excluding the dragged panel) where it would be inserted. */
  private dropIndex(id: string, clientY: number): number {
    const others = this.dockedIds().filter((x) => x !== id);
    for (let i = 0; i < others.length; i++) {
      const r = this.frames.get(others[i])!.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return others.length;
  }

  private showIndicator(id: string, index: number, outside: boolean): void {
    const others = this.dockedIds().filter((x) => x !== id);
    const host = this.el.getBoundingClientRect();
    if (outside || !others.length) {
      this.indicator.style.display = 'none';
      return;
    }
    let y: number;
    if (index < others.length) y = this.frames.get(others[index])!.getBoundingClientRect().top - host.top - 2;
    else y = this.frames.get(others[others.length - 1])!.getBoundingClientRect().bottom - host.top - 2;
    this.indicator.style.display = 'block';
    this.indicator.style.top = `${Math.max(0, y)}px`;
  }

  private moveTo(id: string, index: number): void {
    const others = this.dockedIds().filter((x) => x !== id);
    const before = others[index];
    const order = this.layout.order.filter((x) => x !== id);
    const at = before ? order.indexOf(before) : order.length;
    order.splice(at, 0, id);
    this.layout.order = order;
    this.commit();
  }

  private splitter(a: string, b: string): HTMLElement {
    const el = h('div', { class: 'dock-split', title: 'Drag to resize' });
    let s: { y: number; ha: number; hb: number; wa: number; wb: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      s = {
        y: e.clientY,
        ha: this.frames.get(a)!.getBoundingClientRect().height,
        hb: this.frames.get(b)!.getBoundingClientRect().height,
        wa: this.layout.sizes[a] ?? 1,
        wb: this.layout.sizes[b] ?? 1,
      };
    });
    el.addEventListener('pointermove', (e) => {
      if (!s) return;
      const total = s.ha + s.hb;
      const ha = Math.min(Math.max(MIN_DOCKED, s.ha + (e.clientY - s.y)), total - MIN_DOCKED);
      const wsum = s.wa + s.wb;
      this.layout.sizes[a] = (wsum * ha) / total;
      this.layout.sizes[b] = wsum - this.layout.sizes[a];
      this.frames.get(a)!.style.flex = `${this.layout.sizes[a]} 1 0`;
      this.frames.get(b)!.style.flex = `${this.layout.sizes[b]} 1 0`;
      this.panels.find((p) => p.id === a)?.onResize?.();
      this.panels.find((p) => p.id === b)?.onResize?.();
    });
    const end = (e: PointerEvent) => {
      if (!s) return;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove('active');
      s = null;
      this.onChange(this.layout);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => {
      // Equalise the two neighbours
      const avg = ((this.layout.sizes[a] ?? 1) + (this.layout.sizes[b] ?? 1)) / 2;
      this.layout.sizes[a] = this.layout.sizes[b] = avg;
      this.commit();
    });
    return el;
  }

  private bindFloatResize(id: string, grip: HTMLElement, frame: HTMLElement): void {
    let s: { x: number; y: number; w: number; h: number } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      s = { x: e.clientX, y: e.clientY, w: frame.offsetWidth, h: frame.offsetHeight };
    });
    grip.addEventListener('pointermove', (e) => {
      if (!s || !this.layout.floating[id]) return;
      const r = this.layout.floating[id];
      const host = this.el.getBoundingClientRect();
      const left = frame.offsetLeft;
      r.w = Math.min(Math.max(MIN_FLOAT_W, s.w + e.clientX - s.x), host.width - left);
      r.h = Math.min(Math.max(MIN_FLOAT_H, s.h + e.clientY - s.y), host.height - frame.offsetTop);
      // Once resized, the panel is anchored at its current top-left corner
      r.x = left;
      r.y = frame.offsetTop;
      frame.style.width = `${r.w}px`;
      frame.style.height = `${r.h}px`;
      this.panels.find((p) => p.id === id)?.onResize?.();
    });
    const end = (e: PointerEvent) => {
      if (!s) return;
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      s = null;
      this.onChange(this.layout);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  private returnFromPopup(id: string): void {
    if (!this.popups.has(id)) return;
    const w = this.popups.get(id);
    if (w) Dock.windows.delete(w);
    this.popups.delete(id);
    this.pipIds.delete(id);
    if (!this.unloading && !this.moving) {
      this.layout.popped = (this.layout.popped ?? []).filter((x) => x !== id);
      this.commit();
    }
    const frame = this.frames.get(id)!;
    frame.classList.remove('popped');
    // Move the panel back into this document before re-rendering
    document.adoptNode(frame);
    this.render();
  }
}
