// Air absorption (ISO 9613-1), checked against the standard's table values (dB/km at 101.325 kPa).
import { describe, expect, it } from 'vitest';
import { airAbsorption, airLoss } from '../src/dsp/air';

describe('air absorption (ISO 9613-1)', () => {
  it('matches the standard table at 20 °C and 70 % humidity', () => {
    // ISO 9613-2 Table 2 (20 °C, 70 % RH), dB/km, at the exact octave centres (1000 · 10^(3k/10) Hz)
    const exact = (k: number) => 1000 * Math.pow(10, (3 * k) / 10);
    const table: [number, number][] = [[exact(-3), 0.3], [exact(-1), 2.8], [exact(0), 5.0], [exact(1), 9.0], [exact(2), 22.9], [exact(3), 76.6]];
    for (const [f, dbKm] of table) expect(airAbsorption(f, 20, 70) * 1000).toBeCloseTo(dbKm, 0);
    expect(airAbsorption(exact(3), 20, 70) * 1000).toBeGreaterThan(76.1);
    expect(airAbsorption(exact(3), 20, 70) * 1000).toBeLessThan(77.1);
  });
  it('grows with frequency and is much larger in dry air at high frequencies', () => {
    for (let f = 250; f < 16000; f *= 2) expect(airAbsorption(f * 2, 20, 50)).toBeGreaterThan(airAbsorption(f, 20, 50));
    expect(airAbsorption(10000, 20, 20)).toBeGreaterThan(airAbsorption(10000, 20, 80));
  });
  it('gives the loss over a distance', () => {
    const l = airLoss([1000, 10000], 50, 20, 50);
    expect(l[0]).toBeCloseTo(airAbsorption(1000, 20, 50) * 50, 9);
    // About 5–8 dB at 10 kHz over 50 m in typical air
    expect(l[1]).toBeGreaterThan(4);
    expect(l[1]).toBeLessThan(10);
  });
});
