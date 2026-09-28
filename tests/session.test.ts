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
