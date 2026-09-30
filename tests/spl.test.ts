import { describe, expect, it } from 'vitest';
import { ThirdOctaveBank, butterBandpass, bandResponse, thirdOctaveCentres } from '../src/dsp/octave-bank';

const FS = 48000;
const db = (x: number) => 10 * Math.log10(x);

describe('third-octave filter bank', () => {
  it('has the nominal centres 25 Hz – 16 kHz', () => {
    const c = thirdOctaveCentres();
    expect(c.length).toBe(29);
    expect(c[0]).toBeCloseTo(25.12, 1);
    expect(c[c.length - 1]).toBeCloseTo(15849, 0);
  });

  it('is −3 dB at the band edges and rejects the neighbouring bands', () => {
    const half = Math.pow(10, 0.05);
    for (const fc of [31.62, 1000, 10000]) {
      const s = butterBandpass(fc / half, fc * half, FS);
      expect(20 * Math.log10(bandResponse(s, fc, FS))).toBeCloseTo(0, 3);
      expect(20 * Math.log10(bandResponse(s, fc * half, FS))).toBeCloseTo(-3.01, 1);
      expect(20 * Math.log10(bandResponse(s, fc / half, FS))).toBeCloseTo(-3.01, 1);
      // One band away (×1.26) the next band's centre: well down
      expect(20 * Math.log10(bandResponse(s, fc * Math.pow(10, 0.1), FS))).toBeLessThan(-15);
      expect(20 * Math.log10(bandResponse(s, fc * 2, FS))).toBeLessThan(-40);
    }
  });

  it('measures a sine exactly in its band', () => {
    const bank = new ThirdOctaveBank(FS);
    const n = FS * 2;
    const x = Float64Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    bank.process(x.subarray(0, FS / 2)); // settle
    bank.take();
    bank.process(x, FS / 2, n);
    const e = bank.take();
    const k = bank.centres.findIndex((f) => Math.abs(f - 1000) < 1);
    const ms = e[k] / (n - FS / 2);
    expect(db(ms * 2)).toBeCloseTo(db(0.25), 1); // sine peak² reference: 0.5 amplitude → −6.02 dB
    expect(db(e[k - 1] / e[k])).toBeLessThan(-15);
    expect(db(e[k + 1] / e[k])).toBeLessThan(-15);
  });

  it('keeps the energy of broadband noise (bands sum to the in-range power)', () => {
    const bank = new ThirdOctaveBank(FS);
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
    const n = FS * 4;
    const x = Float64Array.from({ length: n }, rnd);
    bank.process(x);
    const e = bank.take();
    const total = x.reduce((s, v) => s + v * v, 0);
    // White noise: the bands cover 22.4 Hz – 17.8 kHz of the 0 – 24 kHz spectrum
    const lo = bank.centres[0] / Math.pow(10, 0.05);
    const hi = bank.centres[bank.centres.length - 1] * Math.pow(10, 0.05);
    const expected = total * ((hi - lo) / (FS / 2));
    const sum = e.reduce((s, v) => s + v, 0);
    expect(Math.abs(db(sum / expected))).toBeLessThan(0.25);
  });
});

import { SplMeter } from '../src/dsp/spl';
import { SplLogger, LOG_BANDS } from '../src/logger';

describe('SPL meter and noise log', () => {
  /** Feed a sine of `amp` at `freq` for `seconds` in 1024-sample blocks (like the audio path). */
  const feed = (m: SplMeter, amp: number, seconds: number, freq = 1000, clock?: { t: number }) => {
    const block = new Float64Array(1024);
    const total = Math.round(seconds * m.fs);
    for (let done = 0; done < total; done += block.length) {
      const n = Math.min(block.length, total - done);
      for (let i = 0; i < n; i++) block[i] = amp * Math.sin((2 * Math.PI * freq * (m.samples + i)) / m.fs);
      m.process(n === block.length ? block : block.subarray(0, n));
      if (clock) clock.t += (n / m.fs) * 1000;
    }
  };

  it('logs rows of exactly the interval, with exact Leq, Lmax and band levels', () => {
    const m = new SplMeter(FS, 'Z');
    const clock = { t: 1e6 };
    const log = new SplLogger(false);
    log.now = () => clock.t;
    log.config = { interval: 10, limit: 0, window: 1 };
    feed(m, 0.1, 1, 1000, clock); // settle
    log.start(m, 'Z', false);
    feed(m, 0.1, 30, 1000, clock); // −20 dBFS
    feed(m, 0.5, 30, 1000, clock); // −6.02 dBFS
    expect(log.rows.length).toBe(6);
    // 10 s = 468.75 audio blocks: rows are still cut exactly
    for (const r of log.rows) expect(r.dur).toBe(10);
    expect(log.rows[0].leq).toBeCloseTo(-20, 2);
    expect(log.rows[5].leq).toBeCloseTo(-6.02, 2);
    expect(log.rows[0].max).toBeCloseTo(-20, 1);
    expect(log.rows[3].max).toBeCloseTo(-6.02, 1);
    const k = log.rows[0].bands!.findIndex((_, i) => Math.abs(m.bandCentres[i] - 1000) < 1);
    expect(log.rows[0].bands![k]).toBeCloseTo(-20, 1);
    expect(log.rows[0].bands![k + 3]).toBeLessThan(-60);
    expect(log.rows.every((r) => r.w === 'Z')).toBe(true);
  });

  it('does not depend on how often the screen asks (no ticks at all, or thousands)', () => {
    const a = new SplMeter(FS, 'A');
    const b = new SplMeter(FS, 'A');
    const la = new SplLogger(false);
    const lb = new SplLogger(false);
    la.config.interval = lb.config.interval = 2;
    la.start(a, 'A', false);
    lb.start(b, 'A', false);
    const block = new Float64Array(1024);
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      for (let j = 0; j < block.length; j++) block[j] = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.4;
      a.process(block);
      b.process(block);
      for (let t = 0; t < 50; t++) lb.tick(); // a wildly fast display
      a.read('fast');
      for (let t = 0; t < 50; t++) b.read('fast');
    }
    expect(lb.rows.length).toBe(la.rows.length);
    lb.rows.forEach((r, i) => {
      expect(r.leq).toBe(la.rows[i].leq);
      expect(r.max).toBe(la.rows[i].max);
    });
  });

  it('never mixes weightings in a row, and follows the rolling limit', () => {
    const m = new SplMeter(FS, 'A');
    const clock = { t: 5e6 };
    const log = new SplLogger(false);
    log.now = () => clock.t;
    log.config = { interval: 10, limit: -10, window: 1 };
    const states: string[] = [];
    log.onState = (s) => states.push(s);
    feed(m, 0.1, 0.5, 1000, clock);
    log.start(m, 'A', false);
    feed(m, 0.1, 5, 1000, clock);
    m.setWeighting('C'); // mid-row: the A part becomes its own row
    feed(m, 0.1, 10, 1000, clock);
    expect(log.rows.map((r) => [r.w, r.dur])).toEqual([['A', 5], ['C', 10]]);
    feed(m, 0.5, 60, 1000, clock);
    log.tick(clock.t + 2000);
    expect(states).toEqual(['ok', 'over']);
    expect(log.rolling(1, clock.t)).toBeCloseTo(-6.02, 1);
  });

  it('records a 100 ms history from the audio, not from the display', () => {
    const m = new SplMeter(FS, 'Z');
    feed(m, 0.1, 3);
    const h = m.history();
    expect(h.t.length).toBe(30);
    expect(h.t[h.t.length - 1]).toBe(0);
    expect(h.leq[20]).toBeCloseTo(-20, 1);
  });

  it('keeps the unfinished row when the interval changes', () => {
    const m = new SplMeter(FS, 'Z');
    const clock = { t: 1e6 };
    const log = new SplLogger(false);
    log.now = () => clock.t;
    log.config = { interval: 60, limit: 0, window: 15 };
    feed(m, 0.1, 1, 1000, clock);
    log.start(m, 'Z', false);
    feed(m, 0.1, 42, 1000, clock);
    log.setInterval(10);
    feed(m, 0.1, 20, 1000, clock);
    expect(log.rows.map((r) => r.dur)).toEqual([42, 10, 10]);
    const s = log.summary()!;
    expect(s.duration).toBe(62);
  });

  it('always logs the full band list, blank where the sample rate cannot measure', () => {
    const m = new SplMeter(32000, 'Z');
    const log = new SplLogger(false);
    log.config = { interval: 1, limit: 0, window: 1 };
    log.start(m, 'Z', false);
    feed(m, 0.1, 2.2);
    expect(log.rows.length).toBe(2);
    const b = log.rows[0].bands!;
    expect(b.length).toBe(LOG_BANDS.length);
    expect(Number.isFinite(b[b.length - 1])).toBe(false);
    const k = LOG_BANDS.findIndex((f) => Math.abs(f - 1000) < 1);
    expect(b[k]).toBeCloseTo(-20, 1);
    const csv = log.toCsv().split('\n');
    expect(csv[1].split(',').length).toBe(csv[0].split(',').length);
    expect(csv[1].endsWith(',')).toBe(true);
  });
});
