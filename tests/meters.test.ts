import { describe, expect, it } from 'vitest';
import { MeterBallistics } from '../src/audio/meter-ballistics';
import type { ChannelLevel } from '../src/audio/engine';

/** Feed one channel: a full-scale-ish tone for `loud` seconds, then quiet, read at `fps` frames per second. */
function run(fps: number, seconds: number, loud: number) {
  const m = new MeterBallistics();
  const l: ChannelLevel = { peak: 0, rms: 0, clipped: false, acc: { peak: 0, ss: 0, n: 0 } };
  const blockSec = 1024 / 48000;
  let audioT = 0;
  const out: { t: number; peak: number; rms: number; hold: number }[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += 1 / fps) {
    // Blocks that arrived since the last frame
    while (audioT + blockSec <= t) {
      const a = audioT < loud ? 0.5 : 0.005;
      l.acc!.peak = Math.max(l.acc!.peak, a * Math.SQRT2);
      l.acc!.ss += a * a * 1024;
      l.acc!.n += 1024;
      audioT += blockSec;
    }
    const r = m.update([l], t * 1000 + 1)[0];
    out.push({ t, ...r });
  }
  return out;
}

describe('meter ballistics', () => {
  it('rises at once and falls at 20 dB/s, whatever the frame rate', () => {
    for (const fps of [15, 60, 144]) {
      const r = run(fps, 2, 1);
      const at = (t: number) => r.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best));
      // During the tone: about −3 dBFS peak (0.5 × √2 amplitude), RMS on the sine scale the same
      expect(at(0.5).peak).toBeCloseTo(20 * Math.log10(0.5 * Math.SQRT2), 0);
      expect(at(0.5).rms).toBeCloseTo(20 * Math.log10(0.5 * Math.SQRT2), 0);
      // 0.5 s after the tone stops the peak has fallen ~10 dB, not jumped to the quiet level (−40 dB)
      expect(at(1.5).peak).toBeGreaterThan(-15);
      expect(at(1.5).peak).toBeLessThan(-11);
      // The hold stays at the loudest peak for 1.5 s
      expect(at(1.4).hold).toBeCloseTo(at(0.5).peak, 0);
    }
  });

  it('never misses a short peak between two frames', () => {
    const m = new MeterBallistics();
    const l: ChannelLevel = { peak: 0, rms: 0, clipped: false, acc: { peak: 0.9, ss: 0.01, n: 1024 } };
    m.update([l], 1000);
    l.acc = { peak: 0.01, ss: 0.0001, n: 1024 };
    const r = m.update([l], 1016);
    expect(r[0].hold).toBeCloseTo(20 * Math.log10(0.9), 1);
  });
});
