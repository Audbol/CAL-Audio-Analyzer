import { describe, expect, it } from 'vitest';
import { applyChartTheme, seriesColor } from '../src/ui/theme';

describe('day-theme colours', () => {
  it('keeps white and greys neutral (no red tint)', () => {
    applyChartTheme('day');
    for (const c of ['#ffffff', '#808080', '#000000']) {
      const n = parseInt(seriesColor(c).slice(1, 7), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(8);
    }
    // Coloured traces are still darkened for white backgrounds
    const n = parseInt(seriesColor('#4da3ff').slice(1, 7), 16);
    expect(((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)).toBeLessThan(0x4d + 0xa3 + 0xff);
    applyChartTheme('night');
  });
});
