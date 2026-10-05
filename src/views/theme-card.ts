import type { App } from '../app';
import { h, icon } from '../ui/dom';
import { modal } from '../ui/dialogs';
import { download } from '../traces';
import { DAY_COLORS, NIGHT_COLORS, THEME_PRESETS, contrast, parseTheme, serializeTheme, type CustomTheme, type ThemeColors } from '../ui/themes';
import { PALETTE } from '../ui/theme';

const COLOR_FIELDS: { key: keyof ThemeColors; label: string; hint: string }[] = [
  { key: 'bg', label: 'Background', hint: 'Behind everything' },
  { key: 'panel', label: 'Panels', hint: 'Sidebar, toolbars, cards' },
  { key: 'text', label: 'Text', hint: 'Labels and values' },
  { key: 'accent', label: 'Accent', hint: 'Selected tabs, buttons, highlights' },
  { key: 'plotBg', label: 'Graph background', hint: 'Inside the graphs' },
  { key: 'grid', label: 'Grid', hint: 'Graph grid lines (drawn faintly)' },
];

/** A small preview of a theme: its background, panel, accent and first trace colours. */
function preview(t: { colors: ThemeColors; palette?: string[] }): HTMLElement {
  const p = t.palette ?? PALETTE;
  return h(
    'span',
    { class: 'theme-preview', style: `background:${t.colors.bg};border-color:${t.colors.panel}`, 'aria-hidden': 'true' },
    h('i', { style: `background:${t.colors.panel}` }),
    h('b', { style: `background:${t.colors.accent}` }),
    ...p.slice(0, 3).map((c) => h('em', { style: `background:${c}` })),
  );
}

/**
 * Tools → Display & performance → Theme: the built-in Night and Day, ready-made themes and your own. Your own
 * themes are made in an editor (a few colours and an optional trace palette), and can be exported and imported.
 */
export class ThemeCard {
  readonly el = h('section', { class: 'tool-card theme-card' });

  constructor(private readonly app: App) {
    this.render();
  }

  render(): void {
    const app = this.app;
    const s = app.settings;
    const builtins: { id: string; name: string; colors: ThemeColors; base: 'night' | 'day' }[] = [
      { id: 'builtin:night', name: 'Night', colors: NIGHT_COLORS, base: 'night' },
      { id: 'builtin:day', name: 'Day', colors: DAY_COLORS, base: 'day' },
    ];
    const current = s.themeId || `builtin:${s.theme}`;
    const tile = (t: { id: string; name: string; colors: ThemeColors; palette?: string[] }, custom = false) =>
      h(
        'button',
        {
          class: `theme-tile${current === t.id ? ' on' : ''}`,
          'aria-pressed': String(current === t.id),
          dataset: { theme: t.id },
          title: custom ? `${t.name} (your theme)` : t.name,
          onclick: () => {
            if (t.id.startsWith('builtin:')) {
              s.theme = t.id === 'builtin:day' ? 'day' : 'night';
              app.setTheme('');
            } else app.setTheme(t.id);
            this.render();
          },
        },
        preview(t),
        h('span', {}, t.name),
      );
    const theme = app.currentTheme();
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      const t = parseTheme(await f.text());
      if (!t) return app.toast(`${f.name} is not a theme file`, 'warn');
      s.customThemes = [...s.customThemes, t];
      app.setTheme(t.id);
      this.render();
      app.toast(`Theme “${t.name}” added`, 'ok');
    });
    this.el.replaceChildren(
      h('h4', {}, icon('sun', 15), ' Theme'),
      h('p', { class: 'dim small' }, 'Night (OLED black) and Day (for sunlight) are built in, with ready-made themes and your own beside them. T switches between Night and Day.'),
      h('div', { class: 'theme-grid', role: 'group', 'aria-label': 'Theme' }, ...builtins.map((t) => tile(t)), ...THEME_PRESETS.map((t) => tile(t)), ...s.customThemes.map((t) => tile(t, true))),
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('button', { class: 'btn small', onclick: () => this.edit(theme && !theme.id.startsWith('preset:') ? theme : null) }, icon('plus', 14), theme && !theme.id.startsWith('preset:') ? 'Edit theme…' : 'New theme…'),
        h('button', { class: 'btn small ghost', title: 'Add a theme from a file', onclick: () => fileInput.click() }, icon('upload', 14), 'Import…'),
        theme ? h('button', { class: 'btn small ghost', title: 'Save this theme as a file to share it', onclick: () => download(`${theme.name.replace(/[^\w-]+/g, '-')}.caltheme.json`, serializeTheme(theme), 'application/json') }, icon('download', 14), 'Export') : null,
        fileInput,
      ),
    );
  }

  /** The theme editor: starts from `theme` (edit) or from what is shown now (new), previews live. */
  private edit(theme: CustomTheme | null): void {
    const app = this.app;
    const s = app.settings;
    const shown = app.currentTheme();
    const before = s.themeId;
    const start: CustomTheme = theme
      ? JSON.parse(JSON.stringify(theme))
      : { id: `custom:${Date.now().toString(36)}`, name: 'My theme', base: s.theme, colors: { ...(shown?.colors ?? (s.theme === 'day' ? DAY_COLORS : NIGHT_COLORS)) }, palette: shown?.palette ? [...shown.palette] : undefined };
    const draft = start;
    let saved = false;
    // Live preview: the draft is put in the list while the editor is open
    const showDraft = () => {
      s.customThemes = [...s.customThemes.filter((t) => t.id !== draft.id), JSON.parse(JSON.stringify(draft))];
      s.themeId = draft.id;
      app.applyTheme();
      warn.textContent = contrast(draft.colors.text, draft.colors.bg) < 4.5 ? `Text contrast is low (${contrast(draft.colors.text, draft.colors.bg).toFixed(1)}:1): 4.5:1 or more reads well.` : '';
    };
    const name = h('input', { type: 'text', value: draft.name, maxlength: '40', 'aria-label': 'Theme name' }) as HTMLInputElement;
    name.addEventListener('input', () => (draft.name = name.value.trim() || 'My theme'));
    const base = h('select', { 'aria-label': 'Base' }, h('option', { value: 'night' }, 'Dark controls (night)'), h('option', { value: 'day' }, 'Light controls (day)')) as HTMLSelectElement;
    base.value = draft.base;
    base.addEventListener('change', () => {
      draft.base = base.value === 'day' ? 'day' : 'night';
      showDraft();
    });
    const warn = h('p', { class: 'small warn-text', role: 'status' });
    const fields = COLOR_FIELDS.map((f) => {
      const inp = h('input', { type: 'color', value: draft.colors[f.key], 'aria-label': f.label, dataset: { themeColor: f.key } }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        draft.colors[f.key] = inp.value;
        showDraft();
      });
      return h('label', { class: 'theme-field', title: f.hint }, inp, h('span', {}, f.label));
    });
    const usePalette = h('input', { type: 'checkbox', checked: !!draft.palette }) as HTMLInputElement;
    const pal = h('div', { class: 'theme-palette' });
    const renderPalette = () => {
      pal.replaceChildren(
        ...(draft.palette ?? PALETTE).map((c, i) => {
          const inp = h('input', { type: 'color', value: c, disabled: !draft.palette, 'aria-label': `Trace colour ${i + 1}` }) as HTMLInputElement;
          inp.addEventListener('input', () => {
            if (!draft.palette) return;
            draft.palette[i] = inp.value;
            showDraft();
          });
          return inp;
        }),
      );
    };
    usePalette.addEventListener('change', () => {
      draft.palette = usePalette.checked ? [...(draft.palette ?? PALETTE)] : undefined;
      renderPalette();
      showDraft();
    });
    renderPalette();
    const body = h(
      'div',
      { class: 'theme-editor' },
      h('div', { class: 'row gap8 wrap' }, h('label', { class: 'cmp-field' }, h('span', {}, 'Name'), name), h('label', { class: 'cmp-field' }, h('span', {}, 'Base'), base)),
      h('div', { class: 'theme-fields' }, ...fields),
      h('label', { class: 'cmp-check' }, usePalette, 'Own trace colours (measurements and traces, in order)'),
      pal,
      warn,
      h('p', { class: 'dim small' }, 'Changes show at once. Reports keep their print colours.'),
    );
    const del = theme ? h('button', { class: 'btn ghost', onclick: () => {
      s.customThemes = s.customThemes.filter((t) => t.id !== draft.id);
      s.themeId = '';
      saved = true;
      app.save();
      app.applyTheme();
      close();
      this.render();
    } }, icon('trash', 14), 'Delete') : null;
    const save = h('button', { class: 'btn accent', onclick: () => {
      saved = true;
      showDraft();
      app.save();
      close();
      this.render();
      app.toast(`Theme “${draft.name}” saved`, 'ok');
    } }, 'Save theme');
    const { el, close } = modal(theme ? `Edit “${theme.name}”` : 'New theme', body, [...(del ? [del] : []), h('div', { class: 'spacer' }), save]);
    el.classList.add('theme-modal');
    showDraft();
    // Closed without saving: back to how it was
    new MutationObserver((_, obs) => {
      if (el.isConnected) return;
      obs.disconnect();
      if (saved) return;
      s.customThemes = theme ? s.customThemes.map((t) => (t.id === theme.id ? theme : t)) : s.customThemes.filter((t) => t.id !== draft.id);
      s.themeId = before;
      app.applyTheme();
      this.render();
    }).observe(document.body, { childList: true });
  }
}
