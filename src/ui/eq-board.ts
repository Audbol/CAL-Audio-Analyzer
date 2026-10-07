import type { PeqFilter } from '../dsp/eq';
import { consoleBands, widthName, type ConsoleEqProfile } from '../dsp/console-eq';

/**
 * The EQ board: a window of its own with every band's settings in large type (frequency, gain, width as the
 * console shows them), to read from the console while entering them. Tap a band to mark it as entered; the
 * marks go when that band's values change. It follows the EQ tab live.
 */
export class EqBoard {
  private win: Window | null = null;
  private grid: HTMLElement | null = null;
  private head: HTMLElement | null = null;
  /** Bands marked as entered, by their values (a changed band is no longer marked). */
  private entered = new Set<string>();
  private lastKey = '';
  private last: { filters: PeqFilter[]; profile: ConsoleEqProfile; info: string } | null = null;

  get isOpen(): boolean {
    return !!this.win && !this.win.closed;
  }

  /** Open the window (or bring it to the front) and show the current filters. */
  open(filters: PeqFilter[], profile: ConsoleEqProfile, info: string): boolean {
    if (this.isOpen) {
      this.win!.focus();
      this.update(filters, profile, info, true);
      return true;
    }
    const win = window.open('', 'cal-eq-board', 'popup=yes,width=1100,height=640');
    if (!win) return false;
    this.win = win;
    const doc = win.document;
    doc.title = 'EQ board · CAL Audio Analyzer';
    // The app's styles and colour scheme, as for detached panels
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
      if (node instanceof HTMLLinkElement) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = node.href;
        doc.head.append(link);
      } else doc.head.append(doc.importNode(node, true));
    }
    const syncTheme = () => {
      const t = document.documentElement.dataset.theme;
      if (t) doc.documentElement.dataset.theme = t;
      else delete doc.documentElement.dataset.theme;
      const style = document.documentElement.getAttribute('style');
      if (style) doc.documentElement.setAttribute('style', style);
      else doc.documentElement.removeAttribute('style');
    };
    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    win.addEventListener('pagehide', () => {
      obs.disconnect();
      this.win = null;
    });
    doc.body.className = 'eq-board-body';
    this.head = doc.createElement('header');
    this.head.className = 'eq-board-head';
    this.grid = doc.createElement('main');
    this.grid.className = 'eq-board';
    doc.body.append(this.head, this.grid);
    this.update(filters, profile, info, true);
    return true;
  }

  close(): void {
    this.win?.close();
    this.win = null;
  }

  /** Show these filters (only redraws when something changed). */
  update(filters: PeqFilter[], profile: ConsoleEqProfile, info: string, force = false): void {
    if (!this.isOpen || !this.grid || !this.head) return;
    const bands = consoleBands(filters, profile);
    const key = JSON.stringify([bands, profile.id, info, [...this.entered]]);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.last = { filters, profile, info };
    const doc = this.grid.ownerDocument;
    const mk = (tag: string, cls: string, text = '') => {
      const e = doc.createElement(tag);
      e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    // Marks only stay on bands whose values are unchanged
    const ids = new Set(bands.map(bandId));
    for (const id of [...this.entered]) if (!ids.has(id)) this.entered.delete(id);
    this.head.replaceChildren(
      mk('b', '', `${profile.name}${profile.id === 'generic' ? '' : ` · ${profile.section}`}`),
      mk('span', 'dim', info),
      mk('span', 'dim eq-board-hint', 'Tap a band when it is entered on the console'),
    );
    if (!bands.length) {
      this.grid.replaceChildren(mk('div', 'eq-board-empty', 'No filters yet: press Calculate EQ.'));
      return;
    }
    const wName = widthName(profile);
    this.grid.style.setProperty('--bands', String(bands.length));
    this.grid.replaceChildren(
      ...bands.map((b) => {
        const id = bandId(b);
        const card = mk('button', `eq-board-band${this.entered.has(id) ? ' entered' : ''}`);
        card.setAttribute('type', 'button');
        card.dataset.band = b.name;
        card.setAttribute('aria-pressed', String(this.entered.has(id)));
        // One band per row: its name, then frequency, gain and width side by side (as wide as the window allows)
        const cell = (label: string, value: string, cls = '') => {
          const c = mk('div', `eq-board-cell ${cls}`);
          c.append(mk('span', 'eq-board-label', label), mk('span', 'eq-board-value', value));
          return c;
        };
        const name = mk('div', 'eq-board-name');
        name.append(mk('b', '', b.name), mk('span', '', b.kind), mk('span', 'eq-board-check', '✓ entered'));
        // A width's fraction of an octave goes with its label, so the number itself stays short
        const w = b.width.replace(/^(width|Q) /, '');
        const frac = /\((\d+\/\d+)\)$/.exec(w);
        card.append(
          name,
          cell('Frequency', b.freq),
          b.gain ? cell('Gain', b.gain, b.gain.startsWith('+') ? 'boost' : 'cut') : cell('Slope', b.width),
          b.gain ? cell(frac ? `${wName} · ${frac[1]}` : wName, frac ? w.replace(/\s*\(.*\)$/, '') : w) : mk('div', 'eq-board-cell'),
        );
        card.addEventListener('click', () => {
          if (this.entered.has(id)) this.entered.delete(id);
          else this.entered.add(id);
          if (this.last) this.update(this.last.filters, this.last.profile, this.last.info, true);
        });
        return card;
      }),
    );
  }
}

const bandId = (b: { name: string; freq: string; gain: string; width: string }) => `${b.name}|${b.freq}|${b.gain}|${b.width}`;
