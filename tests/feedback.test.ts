import { describe, expect, it } from 'vitest';
import { FeedbackDetector } from '../src/dsp/feedback';
import { logGrid } from '../src/dsp/freq';

const grid = logGrid(20, 20000, 48);
/** A noisy, gently sloped spectrum (like an averaged pink-noise RTA), seeded. */
function noise(seed: number): Float64Array {
  let s = seed >>> 0;
  return Float64Array.from(grid, (f) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return -40 + (s / 2 ** 32 - 0.5) * 3 + 0 * f;
  });
}
/** A narrow resonance: `gain` dB at f0 with the given Q. */
const peak = (f: number, f0: number, gain: number, q: number) => gain / (1 + (q * (f / f0 - f0 / f)) ** 2);

describe('feedback finder', () => {
  it('finds a narrow peak that grows, with a matching notch', () => {
    const d = new FeedbackDetector();
    let found = d.update(grid, noise(1), 0);
    for (let k = 1; k <= 30; k++) {
      const t = k / 25;
      const g = 6 + 15 * t; // grows 15 dB/s
      const y = noise(k + 1).map((v, i) => v + peak(grid[i], 2500, g, 30));
      found = d.update(grid, y, t);
    }
    expect(found.length).toBe(1);
    const c = found[0];
    expect(Math.abs(Math.log2(c.f / 2500))).toBeLessThan(1 / 48);
    expect(c.kind).toBe('rising');
    expect(c.rising).toBeGreaterThan(8);
    expect(c.notch.gain).toBeLessThanOrEqual(-3);
    expect(c.notch.q).toBeGreaterThan(8);
  });

  it('reports a steady tone high above the spectrum as ringing', () => {
    const d = new FeedbackDetector();
    let found: ReturnType<FeedbackDetector['update']> = [];
    for (let k = 0; k < 25; k++) found = d.update(grid, noise(k + 7).map((v, i) => v + peak(grid[i], 800, 24, 40)), k / 25);
    expect(found.map((c) => [Math.round(c.f / 10) * 10, c.kind])).toEqual([[800, 'ringing']]);
  });

  it('ignores noise, broad bumps and room-mode-like resonances', () => {
    const d = new FeedbackDetector();
    let found: ReturnType<FeedbackDetector['update']> = [];
    for (let k = 0; k < 50; k++) {
      // A broad 6 dB bump at 1 kHz, a 8 dB Q 4 resonance at 120 Hz and random noise
      const y = noise(k + 99).map((v, i) => v + peak(grid[i], 1000, 6, 1) + peak(grid[i], 120, 8, 4));
      found = d.update(grid, y, k / 25);
    }
    expect(found).toEqual([]);
  });

  it('forgets a peak that went away', () => {
    const d = new FeedbackDetector();
    for (let k = 0; k < 20; k++) d.update(grid, noise(k).map((v, i) => v + peak(grid[i], 3000, 25, 40)), k / 25);
    let found = d.update(grid, noise(50), 1);
    for (let k = 1; k < 40; k++) found = d.update(grid, noise(50 + k), 1 + k / 25);
    expect(found).toEqual([]);
  });
});
