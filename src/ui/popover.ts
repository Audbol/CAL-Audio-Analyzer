import { h, icon } from './dom';

/**
 * A toolbar button that opens a small panel of secondary settings, so toolbars keep only the controls used all
 * the time. The panel stays in the page (its controls keep their state and stay in sync); it closes on a click
 * outside, on Escape, or when the button is pressed again.
 */
export function optionsMenu(content: (HTMLElement | null)[], opts: { label?: string; title?: string; id?: string } = {}): HTMLElement {
  const panel = h('div', { class: 'opt-panel', role: 'dialog', 'aria-label': opts.title ?? 'Options' });
  panel.append(...content.filter((c): c is HTMLElement => !!c));
  const btn = h(
    'button',
    { class: 'btn small opt-btn', title: opts.title ?? 'More options', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', dataset: { options: opts.id ?? '' } },
    icon('sliders', 14),
    opts.label ?? 'Options',
    h('span', { class: 'opt-caret' }),
  );
  const wrap = h('div', { class: 'opt-wrap' }, btn, panel);
  const place = () => {
    // Fixed position so the panel is never clipped by the toolbar; kept inside the window
    const r = btn.getBoundingClientRect();
    const w = panel.offsetWidth;
    const view = wrap.ownerDocument.defaultView ?? window;
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, view.innerWidth - w - 8)))}px`;
    panel.style.maxHeight = `${Math.max(160, view.innerHeight - r.bottom - 20)}px`;
  };
  const onDown = (e: PointerEvent) => {
    if (!wrap.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.opt-panel')) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      btn.focus();
    }
  };
  const onResize = () => close();
  const open = () => {
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    place();
    const doc = wrap.ownerDocument;
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    doc.defaultView?.addEventListener('resize', onResize);
  };
  function close(): void {
    if (!wrap.classList.contains('open')) return;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    const doc = wrap.ownerDocument;
    doc.removeEventListener('pointerdown', onDown, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.defaultView?.removeEventListener('resize', onResize);
  }
  btn.addEventListener('click', () => (wrap.classList.contains('open') ? close() : open()));
  return wrap;
}

/** A labelled row in an options panel. */
export function optRow(label: string, ...controls: (HTMLElement | string | null)[]): HTMLElement {
  return h('div', { class: 'opt-row' }, h('span', { class: 'opt-label' }, label), h('div', { class: 'opt-ctl' }, ...controls));
}

/** A section heading in an options panel. */
export function optHead(text: string): HTMLElement {
  return h('div', { class: 'opt-head' }, text);
}

const COLOUR_PRESETS = [
  { value: '#4d9fff', label: 'Blue' },
  { value: '#2ec4b6', label: 'Teal' },
  { value: '#7cff6b', label: 'Green' },
  { value: '#ffd60a', label: 'Yellow' },
  { value: '#ff9f1c', label: 'Orange' },
  { value: '#ff4d6d', label: 'Red' },
  { value: '#ff5cf0', label: 'Magenta' },
  { value: '#b18cff', label: 'Violet' },
  { value: '#ffffff', label: 'White' },
  { value: '#8a94a6', label: 'Grey' },
];

/**
 * A colour choice: automatic, optionally none, a few presets or any colour (the swatch opens the system colour
 * picker). Calls `onChange` with 'auto', 'none' or a #rrggbb colour.
 */
export function colourChoice(value: string, onChange: (v: string) => void, opts: { auto: string; none?: boolean; label: string }): HTMLElement {
  const sel = h('select', { 'aria-label': opts.label });
  const add = (v: string, l: string) => sel.append(h('option', { value: v }, l));
  add('auto', opts.auto);
  if (opts.none) add('none', 'None');
  for (const p of COLOUR_PRESETS) add(p.value, p.label);
  add('custom', 'Custom…');
  const swatch = h('input', { type: 'color', class: 'swatch', 'aria-label': `${opts.label} (custom)`, title: 'Pick any colour' });
  const show = (v: string) => {
    const preset = v === 'auto' || v === 'none' || COLOUR_PRESETS.some((p) => p.value === v);
    sel.value = preset ? v : 'custom';
    swatch.style.display = v === 'auto' || v === 'none' ? 'none' : '';
    if (v.startsWith('#')) swatch.value = v;
  };
  sel.addEventListener('change', () => {
    const v = sel.value === 'custom' ? swatch.value || '#4d9fff' : sel.value;
    show(v);
    onChange(v);
  });
  swatch.addEventListener('input', () => {
    show(swatch.value);
    onChange(swatch.value);
  });
  show(value);
  return h('span', { class: 'colour-choice' }, sel, swatch);
}
