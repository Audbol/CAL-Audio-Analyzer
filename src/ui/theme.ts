/** Canvas / chart colours for both themes (CSS tokens live in styles/app.css). */

export type ThemeName = 'night' | 'day';

const NIGHT = {
  bg: '#000000',
  grid: 'rgba(255,255,255,0.055)',
  gridMajor: 'rgba(255,255,255,0.12)',
  text: 'rgba(236,236,238,0.55)',
  cursor: 'rgba(255,255,255,0.4)',
  marker: 'rgba(255,255,255,0.55)',
  shade: 'rgba(255,255,255,0.035)',
  neutral: 'rgba(185,185,191,0.9)',
  accent: '#4d9fff',
  warn: '#ffb020',
  warnSoft: 'rgba(255,176,32,0.45)',
  /** Foreground colour for emphasised neutral traces (e.g. broadband decay). */
  fg: '#ffffff',
  /** Multiplier for trace line widths. */
  lineScale: 1,
  fillAlpha: 0.12,
};

/** Day mode: white background, dark grid and text, heavier lines for readability in direct sunlight. */
const DAY: typeof NIGHT = {
  bg: '#ffffff',
  grid: 'rgba(0,0,0,0.11)',
  gridMajor: 'rgba(0,0,0,0.3)',
  text: 'rgba(0,0,0,0.85)',
  cursor: 'rgba(0,0,0,0.55)',
  marker: 'rgba(0,0,0,0.6)',
  shade: 'rgba(0,0,0,0.05)',
  neutral: 'rgba(60,66,76,0.95)',
  accent: '#0047c2',
  warn: '#a64b00',
  warnSoft: 'rgba(166,75,0,0.45)',
  fg: '#000000',
  lineScale: 1.4,
  fillAlpha: 0.1,
};

/** Live chart colours; mutated in place by `applyChartTheme` so every plot picks up theme changes. */
export const CHART = { ...NIGHT };

let current: ThemeName = 'night';
const cache = new Map<string, string>();

export function applyChartTheme(theme: ThemeName): void {
  current = theme;
  Object.assign(CHART, theme === 'day' ? DAY : NIGHT);
  cache.clear();
}

export function chartTheme(): ThemeName {
  return current;
}

/**
 * Colour for a data series in the current theme. Trace colours are chosen for a black background; in day
 * mode they are darkened and saturated so they keep strong contrast on white (hex colours, with optional alpha).
 */
export function seriesColor(c: string): string {
  if (current === 'night') return c;
  const hit = cache.get(c);
  if (hit) return hit;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  const [hh, ss, ll] = rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const [r, g, b] = hslToRgb(hh, Math.max(ss, 0.7), Math.min(ll, 0.38));
  const out = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}${m[2] ?? ''}`;
  cache.set(c, out);
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Trace palette: high-contrast on pure black, distinguishable for common colour-vision deficiencies. */
export const PALETTE = ['#4d9fff', '#ffb020', '#3ddc97', '#ff5c7a', '#b18cff', '#2ec5d3', '#ffd84d', '#ff8a3d', '#9ad14b', '#e27bd6'];

/** Sequential palette for band-ordered series (low → high frequency). */
export const BAND_COLORS = ['#5b6cff', '#4d9fff', '#2ec5d3', '#3ddc97', '#9ad14b', '#ffd84d', '#ffb020', '#ff8a3d', '#ff5c7a', '#e27bd6'];
