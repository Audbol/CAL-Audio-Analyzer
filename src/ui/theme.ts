/** Canvas / chart colours for the OLED-black theme (CSS tokens live in styles/app.css). */
export const CHART = {
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
  white: '#ffffff',
};

/** Trace palette: high-contrast on pure black, distinguishable for common colour-vision deficiencies. */
export const PALETTE = ['#4d9fff', '#ffb020', '#3ddc97', '#ff5c7a', '#b18cff', '#2ec5d3', '#ffd84d', '#ff8a3d', '#9ad14b', '#e27bd6'];

/** Sequential palette for band-ordered series (low → high frequency). */
export const BAND_COLORS = ['#5b6cff', '#4d9fff', '#2ec5d3', '#3ddc97', '#9ad14b', '#ffd84d', '#ffb020', '#ff8a3d', '#ff5c7a', '#e27bd6'];
