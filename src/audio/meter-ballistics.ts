import type { ChannelLevel } from './engine';

/** A level meter's display values (dBFS; RMS on the sine scale, so a full-scale sine reads 0 on both). */
export interface MeterReading {
  rms: number;
  peak: number;
  /** Highest recent peak: held 1.5 s, then falls back. */
  hold: number;
}

const FLOOR = -120;
/** Peak and hold fall back at 20 dB/s (like a peak programme meter); RMS rises in ~20 ms, falls in ~120 ms. */
const PEAK_FALL = 20;
const HOLD_TIME = 1.5;
const RMS_RISE = 0.02;
const RMS_FALL = 0.12;

const db = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : FLOOR);

/**
 * Meter ballistics at the display rate. Audio arrives in blocks (~47 a second), the screen refreshes at 60 or
 * more: each frame takes the loudest peak and the RMS of the blocks since the last frame and moves the bars
 * with times in seconds, so they rise at once and fall smoothly at any frame rate.
 */
export class MeterBallistics {
  private st: { rms: number; peak: number; hold: number; holdAt: number; tPeak: number; tRms: number }[] = [];
  private at = 0;

  update(levels: ChannelLevel[], now = performance.now()): MeterReading[] {
    const dt = this.at ? Math.min(0.25, Math.max(0, (now - this.at) / 1000)) : 0;
    this.at = now;
    if (this.st.length !== levels.length) this.st = levels.map(() => ({ rms: FLOOR, peak: FLOOR, hold: FLOOR, holdAt: 0, tPeak: FLOOR, tRms: FLOOR }));
    return levels.map((l, i) => {
      const s = this.st[i];
      const acc = l.acc;
      if (acc && acc.n > 0) {
        s.tPeak = db(acc.peak);
        s.tRms = db(Math.sqrt(acc.ss / acc.n)) + 3.01;
        acc.peak = 0;
        acc.ss = 0;
        acc.n = 0;
      } else if (!acc) {
        // Levels without block data (older remote hosts): follow the smoothed values
        s.tPeak = db(l.peak);
        s.tRms = db(l.rms) + 3.01;
      }
      s.peak = s.tPeak >= s.peak ? s.tPeak : Math.max(s.tPeak, s.peak - PEAK_FALL * dt);
      const tau = s.tRms > s.rms ? RMS_RISE : RMS_FALL;
      s.rms += (s.tRms - s.rms) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 1);
      if (s.peak >= s.hold) {
        s.hold = s.peak;
        s.holdAt = now;
      } else if (now - s.holdAt > HOLD_TIME * 1000) s.hold = Math.max(s.peak, s.hold - PEAK_FALL * dt);
      return { rms: Math.max(FLOOR, s.rms), peak: Math.max(FLOOR, s.peak), hold: Math.max(FLOOR, s.hold) };
    });
  }

  /** Clear a channel's peak hold (clicking its meter). */
  resetHold(i: number): void {
    const s = this.st[i];
    if (s) s.hold = s.peak;
  }
}
