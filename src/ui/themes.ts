import { CHART, PALETTE, applyChartTheme, setSeriesPalette, type ThemeName } from './theme';

/** The colours a theme sets; everything else (borders, hover, dim text, meters…) is derived from them. */
export interface ThemeColors {
  bg: string;
  panel: string;
  text: string;
  accent: string;
  plotBg: string;
  grid: string;
}

export interface CustomTheme {
  id: string;
  name: string;
  /** Night or day base: dark or light controls, and how trace colours are adapted. */
  base: ThemeName;
  colors: ThemeColors;
  /** Trace colours replacing the standard measurement palette, in order (optional). */
  palette?: string[];
}

export const NIGHT_COLORS: ThemeColors = { bg: '#000000', panel: '#07080a', text: '#e9ebee', accent: '#4d9fff', plotBg: '#000000', grid: '#ffffff' };
export const DAY_COLORS: ThemeColors = { bg: '#ffffff', panel: '#f2f3f5', text: '#000000', accent: '#0047c2', plotBg: '#ffffff', grid: '#000000' };

/** Ready-made themes (the built-in Night and Day are separate: they use the app's hand-tuned styles). */
export const THEME_PRESETS: CustomTheme[] = [
  {
    id: 'preset:high-contrast',
    name: 'High contrast',
    base: 'night',
    colors: { bg: '#000000', panel: '#000000', text: '#ffffff', accent: '#ffd60a', plotBg: '#000000', grid: '#ffffff' },
    palette: ['#00d9ff', '#ffd60a', '#39ff14', '#ff4dff', '#ff8c00', '#ffffff', '#ff3b30', '#b18cff', '#9ad14b', '#e27bd6'],
  },
  {
    id: 'preset:stage-red',
    name: 'Stage red',
    base: 'night',
    colors: { bg: '#000000', panel: '#0b0303', text: '#ff7a6e', accent: '#ff3b30', plotBg: '#000000', grid: '#ff5040' },
    palette: ['#ff3b30', '#ff9f0a', '#ff6482', '#ffd60a', '#ff7a45', '#d94f70', '#ffb38a', '#c0392b', '#ffcf6e', '#ff8fab'],
  },
  {
    id: 'preset:colour-blind',
    name: 'Colour-blind safe',
    base: 'night',
    colors: { ...NIGHT_COLORS, accent: '#56b4e9' },
    // Okabe–Ito: distinguishable with every common form of colour blindness
    palette: ['#56b4e9', '#e69f00', '#009e73', '#f0e442', '#cc79a7', '#d55e00', '#0072b2', '#ffffff', '#999999', '#88ccee'],
  },
  {
    id: 'preset:midnight',
    name: 'Midnight blue',
    base: 'night',
    colors: { bg: '#0a0f1e', panel: '#0f162b', text: '#e3e9ff', accent: '#7aa2ff', plotBg: '#070b17', grid: '#a8b8ff' },
  },
  {
    id: 'preset:paper',
    name: 'Paper',
    base: 'day',
    colors: { bg: '#faf7f0', panel: '#f0eadc', text: '#1d1a14', accent: '#8a4b08', plotBg: '#fffdf8', grid: '#3c2a0a' },
  },
];

// ------------------------------------------------------------------------------------------------------------
// Colour helpers

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
/** `a` moved towards `b` by `t` (0–1). */
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};
const rgba = (c: string, a: number) => `rgba(${rgb(c).join(',')},${a})`;
const luminance = (c: string) => {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Contrast ratio between two colours (WCAG, 1–21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** All CSS custom properties of a theme, derived from its few colours. */
export function themeVars(t: CustomTheme): Record<string, string> {
  const { bg, panel, text, accent, plotBg } = t.colors;
  const day = t.base === 'day';
  const ink = contrast(accent, '#000000') > contrast(accent, '#ffffff') ? '#000000' : '#ffffff';
  return {
    '--bg': bg,
    '--panel': panel,
    '--panel-2': mix(panel, text, day ? 0.05 : 0.035),
    '--panel-3': mix(panel, text, day ? 0.0 : 0.07),
    '--hover': mix(panel, text, day ? 0.12 : 0.1),
    '--border': mix(panel, text, day ? 0.3 : 0.09),
    '--border-2': mix(panel, text, day ? 0.42 : 0.15),
    '--border-3': mix(panel, text, day ? 0.6 : 0.22),
    '--text': text,
    '--text-2': mix(text, bg, day ? 0.08 : 0.22),
    '--dim': mix(text, bg, day ? 0.3 : 0.45),
    '--accent': accent,
    '--accent-hi': mix(accent, day ? '#000000' : '#ffffff', 0.25),
    '--accent-rgb': rgb(accent).join(', '),
    '--accent-ink': ink,
    '--plot-bg': plotBg,
    '--swatch-ring': rgba(text, day ? 0.35 : 0.15),
    '--meter-lo': mix(bg, '#3ddc97', day ? 0.18 : 0.08),
    '--meter-mid': mix(bg, '#ffb020', day ? 0.2 : 0.08),
    '--meter-hi': mix(bg, '#ff4d5e', day ? 0.2 : 0.1),
    '--meter-hold': text,
    '--clip-off': mix(bg, '#ff4d5e', day ? 0.15 : 0.08),
    '--tip-bg': rgba(mix(panel, bg, 0.5), 0.96),
    '--overlay': rgba(bg, day ? 0.85 : 0.72),
  };
}

let applied: string[] = [];

/**
 * Apply a theme to a document: `null` = the built-in Night or Day (the stylesheet's own values). Charts and
 * trace colours follow. Detached windows copy the main window's custom properties (see the dock).
 */
export function applyTheme(doc: Document, base: ThemeName, theme: CustomTheme | null): void {
  const root = doc.documentElement;
  root.dataset.theme = base;
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  applyChartTheme(base);
  setSeriesPalette(theme?.palette ?? null);
  if (!theme) return;
  const vars = themeVars(theme);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  applied = Object.keys(vars);
  const day = base === 'day';
  Object.assign(CHART, {
    bg: theme.colors.plotBg,
    grid: rgba(theme.colors.grid, day ? 0.12 : 0.07),
    gridMajor: rgba(theme.colors.grid, day ? 0.3 : 0.15),
    text: rgba(theme.colors.text, day ? 0.85 : 0.6),
    cursor: rgba(theme.colors.text, 0.45),
    marker: rgba(theme.colors.text, 0.6),
    shade: rgba(theme.colors.grid, 0.045),
    accent: theme.colors.accent,
    fg: theme.colors.text,
  });
}

/** The measurement palette in use (the theme's, or the standard one). */
export function paletteOf(theme: CustomTheme | null): string[] {
  return theme?.palette?.length ? theme.palette : PALETTE;
}

/** A theme from a file (export format), checked and cleaned; null when it isn't one. */
export function parseTheme(text: string): CustomTheme | null {
  try {
    const j = JSON.parse(text) as Partial<CustomTheme> & { format?: string };
    const c = j.colors as Partial<ThemeColors> | undefined;
    const ok = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
    if (!c || !(['bg', 'panel', 'text', 'accent', 'plotBg', 'grid'] as const).every((k) => ok(c[k]))) return null;
    const palette = Array.isArray(j.palette) ? j.palette.filter(ok).slice(0, 10) : undefined;
    return {
      id: `custom:${Date.now().toString(36)}`,
      name: typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, 40) : 'Imported theme',
      base: j.base === 'day' ? 'day' : 'night',
      colors: c as ThemeColors,
      palette: palette?.length ? palette : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeTheme(t: CustomTheme): string {
  return JSON.stringify({ format: 'cal-theme', version: 1, name: t.name, base: t.base, colors: t.colors, palette: t.palette }, null, 2);
}
