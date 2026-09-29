import { describe, expect, it } from 'vitest';
import { decodeFloat32, encodeFloat32, parseSession, sessionFileName, SESSION_FORMAT } from '../src/session';

describe('sessions', () => {
  it('stores impulse responses losslessly as float32', () => {
    const ir = Float64Array.from({ length: 100_003 }, (_, i) => Math.sin(i * 0.01) * Math.exp(-i / 20000));
    const back = decodeFloat32(encodeFloat32(ir));
    expect(back.length).toBe(ir.length);
    let err = 0;
    for (let i = 0; i < ir.length; i++) err = Math.max(err, Math.abs(back[i] - Math.fround(ir[i])));
    expect(err).toBe(0);
  });

  it('accepts a valid session and rejects other files', () => {
    const f = parseSession(JSON.stringify({ format: SESSION_FORMAT, version: 1, session: { name: 'A' }, traces: [{ id: 't1', freqs: [1, 2], mag: [0, 0] }] }));
    expect(f.session).toEqual({ name: 'A', venue: '', notes: '' });
    expect(f.sweep).toBeNull();
    expect(() => parseSession('not json')).toThrow(/not valid JSON/);
    expect(() => parseSession('{"format":"other"}')).toThrow(/not a CAL/);
    expect(() => parseSession(JSON.stringify({ format: SESSION_FORMAT, version: 99, traces: [] }))).toThrow(/newer version/);
    expect(() => parseSession(JSON.stringify({ format: SESSION_FORMAT, version: 1, traces: [{ id: 'x' }] }))).toThrow(/damaged/);
  });

  it('builds safe file names', () => {
    expect(sessionFileName({ name: 'Main/PA: tune', venue: 'Hall', notes: '' })).toMatch(/^Main_PA_ tune - Hall \d{4}-\d\d-\d\d\.calsession\.json$/);
    expect(sessionFileName({ name: '', venue: '', notes: '' }, 'report.html')).toMatch(/^session .*\.report\.html$/);
  });
});

import { micAverage } from '../src/dsp/multimic';
describe('multi-mic average', () => {
  it('power-averages and reports the spread', () => {
    const r = micAverage([[0, -10, NaN], [-6, -10, -3]])!;
    expect(r.avg[0]).toBeCloseTo(10 * Math.log10((1 + 0.2512) / 2), 3);
    expect(r.avg[1]).toBeCloseTo(-10, 6);
    expect(r.avg[2]).toBeCloseTo(-3, 6); // a blanked point is left out
    expect([r.lo[0], r.hi[0]]).toEqual([-6, 0]);
    expect(micAverage([[0]])).toBeNull();
  });
});

import { waterfall, WATERFALL_PRESETS } from '../src/dsp/waterfall';
describe('waterfall', () => {
  it('shows a ringing mode as the slowest decay', () => {
    const fs = 48000;
    const ir = new Float64Array(fs);
    ir[100] = 1;
    // A 50 Hz mode with a long decay (RT ≈ 1.4 s) on top of a short broadband impulse
    for (let i = 100; i < ir.length; i++) ir[i] += 0.02 * Math.sin((2 * Math.PI * 50 * (i - 100)) / fs) * Math.exp(-(i - 100) / (0.2 * fs));
    const w = waterfall(ir, fs, 100, WATERFALL_PRESETS.bass);
    expect(w.slices.length).toBe(32);
    const at = (s: Float64Array, f: number) => s[w.freqs.findIndex((x) => x >= f)];
    const last = w.slices[w.slices.length - 1];
    // The mode is still there 400 ms later; 200 Hz (no mode) has fallen away
    expect(at(last, 50) - at(last, 200)).toBeGreaterThan(25);
    expect(Math.max(...w.slices[0])).toBeCloseTo(0, 6);
  });
});

import { SplLogger, LOG_BANDS } from '../src/logger';
describe('SPL logger', () => {
  // A meter integrating a constant level per second of "audio"
  const meter = () => {
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    return {
      feed(db: number, secs: number) {
        sum += Math.pow(10, db / 10) * secs * 1000;
        count += secs * 1000;
        max = Math.max(max, db + 2);
      },
      integrator: () => ({ sum, count }),
      levelOf: (ms: number) => 10 * Math.log10(ms),
      takeMax: () => {
        const m = max;
        max = -Infinity;
        return m;
      },
    };
  };

  it('logs exact interval Leq, the rolling Leq and limit alarms', () => {
    const m = meter();
    const log = new SplLogger(false);
    log.config = { interval: 10, limit: 95, window: 1 };
    const states: string[] = [];
    log.onState = (s) => states.push(s);
    let t = 1_000_000;
    log.start(m, 'A', true, t);
    const bands = LOG_BANDS.map(() => 70);
    // 60 s at 90 dB, then 60 s at 100 dB, one sample per second
    for (let i = 0; i < 120; i++) {
      m.feed(i < 60 ? 90 : 100, 1);
      t += 1000;
      log.sample(m, bands, t);
    }
    expect(log.rows.length).toBe(12);
    expect(log.rows[0].leq).toBeCloseTo(90, 6);
    expect(log.rows[11].leq).toBeCloseTo(100, 6);
    expect(log.rows[0].max).toBeCloseTo(92, 6);
    expect(log.rows[0].bands![0]).toBeCloseTo(70, 6);
    expect(log.rolling(1, t)).toBeCloseTo(100, 3);
    expect(log.rolling(2, t)).toBeCloseTo(10 * Math.log10((1e9 + 1e10) / 2), 3);
    expect(states).toEqual(['ok', 'near', 'over']);
    const s = log.summary()!;
    expect(s.duration).toBeCloseTo(120, 6);
    expect(s.overMinutes).toBeCloseTo(1, 6);
    expect(log.toCsv().split('\n').length).toBe(13);
  });
});
