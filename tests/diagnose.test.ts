import { describe, expect, it } from 'vitest';
import { diagnose, findReflections, bandDecay } from '../src/dsp/diagnose';

const FS = 48000;

/** A synthetic room: direct sound, reflections, an optional ringing mode and a diffuse tail. */
function room(opts: { refl?: [number, number][]; mode?: { f: number; t60: number; amp: number }; tailT60?: number; tailAmp?: number } = {}) {
  const n = Math.round(FS * 1.6);
  const ir = new Float64Array(n);
  const t0 = Math.round(FS * 0.01);
  ir[t0] = 1;
  for (const [ms, g] of opts.refl ?? []) ir[t0 + Math.round((ms / 1000) * FS)] += g;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
  const tail = opts.tailT60 ?? 0.4;
  for (let i = t0 + Math.round(0.03 * FS); i < n; i++) {
    const t = (i - t0) / FS;
    ir[i] += (opts.tailAmp ?? 0.02) * rnd() * Math.pow(10, (-3 * t) / tail);
  }
  if (opts.mode) {
    const { f, t60, amp } = opts.mode;
    for (let i = t0; i < n; i++) {
      const t = (i - t0) / FS;
      ir[i] += amp * Math.sin(2 * Math.PI * f * t) * Math.pow(10, (-3 * t) / t60);
    }
  }
  return { ir, t0 };
}

describe('room diagnosis', () => {
  it('finds reflections with their delay and level', () => {
    const { ir, t0 } = room({ refl: [[2.5, 0.5], [6, 0.2]] });
    const r = findReflections(ir, FS, t0);
    expect(r.length).toBe(2);
    expect(r[0].delayMs).toBeCloseTo(2.5, 1);
    expect(r[0].levelDb).toBeCloseTo(-6, 0);
    expect(r[1].delayMs).toBeCloseTo(6, 1);
    expect(r[1].levelDb).toBeCloseTo(-14, 0);
  });

  it('measures a longer decay at a ringing mode', () => {
    const { ir, t0 } = room({ mode: { f: 63, t60: 1.2, amp: 0.05 } });
    const atMode = bandDecay(ir, FS, t0, 63);
    const elsewhere = bandDecay(ir, FS, t0, 160);
    expect(atMode).toBeGreaterThan(0.9);
    expect(elsewhere).toBeLessThan(0.6);
  });

  it('tells speaker-boundary interference, a plain reflection and a room mode apart', () => {
    const { ir, t0 } = room({ refl: [[2.5, 0.6], [6, 0.2]], mode: { f: 63, t60: 1.2, amp: 0.05 } });
    const { findings } = diagnose(ir, FS, t0);
    const sbir = findings.find((f) => f.kind === 'sbir');
    const refl = findings.find((f) => f.kind === 'reflection');
    const mode = findings.find((f) => f.kind === 'mode');
    // 2.5 ms → first notch at 200 Hz, a boundary about 0.43 m away
    expect(sbir?.confidence).toBe('likely');
    expect(Math.abs(Math.log2(sbir!.f! / 200))).toBeLessThan(0.15);
    expect(sbir!.pathM! / 2).toBeCloseTo(0.43, 1);
    // The weak 6 ms reflection stays a reflection (comb filtering), not SBIR
    expect(refl?.delayMs).toBeCloseTo(6, 1);
    // The ringing 63 Hz resonance is a mode
    expect(mode?.confidence).toBe('likely');
    expect(Math.abs(mode!.f! - 63)).toBeLessThan(3);
    expect(mode!.decay!).toBeGreaterThan(mode!.decayRef! * 1.2);
  });

  it('reports nothing for a clean response', () => {
    const { ir, t0 } = room();
    const { findings } = diagnose(ir, FS, t0);
    expect(findings.filter((f) => f.confidence === 'likely')).toEqual([]);
  });
});
