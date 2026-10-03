import { spectrumOf } from './sweep';
import { LogSmoother, logGrid } from './freq';
import { nextPow2 } from './fft';
import { butterBandpass } from './octave-bank';

/**
 * Room diagnosis from a measured impulse response: tells apart the three usual causes of an uneven low and mid
 * response, because each needs a different fix.
 *
 * - **Reflections** arrive as distinct copies after the direct sound (visible in the impulse response). Each one
 *   makes a comb filter: notches at odd multiples of 1/(2·delay), spaced 1/delay apart.
 * - **Speaker-boundary interference (SBIR)** is the same physics from a boundary close to the loudspeaker (front
 *   or side wall, floor, desk): a strong, early reflection whose first, deepest notch falls in the low-mids,
 *   at c / (4 · distance to the boundary). It is a broad dip that doesn't ring; EQ can't fill it, moving the
 *   loudspeaker can.
 * - **Room modes** are resonances between the room surfaces below the Schroeder frequency: narrow peaks that keep
 *   ringing after the sound stops (and, at some positions, narrow nulls between them).
 */

export type FindingKind = 'mode' | 'sbir' | 'reflection' | 'null';

export interface Finding {
  kind: FindingKind;
  /** Frequency the finding is about (Hz): the mode, the dip, or a reflection's first comb notch. */
  f?: number;
  /** Reflections and SBIR: arrival after the direct sound (ms) and the extra path length (m). */
  delayMs?: number;
  pathM?: number;
  /** Level: of a peak or dip relative to the trend (dB), or of a reflection relative to the direct sound. */
  levelDb: number;
  /** Peaks and dips: sharpness (centre frequency / −3 dB bandwidth). */
  q?: number;
  /** Modes: decay time at the mode and the room's typical decay at low frequencies (s, T60). */
  decay?: number;
  decayRef?: number;
  confidence: 'likely' | 'possible';
  title: string;
  detail: string;
  advice: string;
}

export interface Reflection {
  delayMs: number;
  levelDb: number;
}

export interface Diagnosis {
  findings: Finding[];
  reflections: Reflection[];
  /** The response analysed (1/12-octave detail and its 1-octave trend, dB) on `freqs`. */
  freqs: Float64Array;
  fine: Float64Array;
  trend: Float64Array;
}

export interface DiagnoseOptions {
  /** Speed of sound (m/s). */
  c?: number;
  /** Upper limit of the modal region (Hz), roughly the Schroeder frequency. */
  modalLimit?: number;
  /** Lowest frequency measured (Hz): nothing is reported below it (e.g. the sweep's start). */
  fMin?: number;
  /** The room's predicted modes (when its dimensions are known): a measured mode is matched to the nearest. */
  predicted?: { f: number; label: string }[];
}

const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(f < 100 ? 1 : 0)} Hz`);

/** Find reflections: distinct peaks after the direct sound in the high-passed impulse response. */
export function findReflections(ir: Float64Array, fs: number, t0: number): Reflection[] {
  const ms = fs / 1000;
  const from = Math.max(0, t0 - Math.round(5 * ms));
  const to = Math.min(ir.length, t0 + Math.round(30 * ms));
  // A gentle (2nd-order) high-pass at 300 Hz, so the loudspeaker's own low-frequency ringing doesn't look like
  // reflections (a steep filter would ring itself and invent reflections right after real ones)
  const hp = filterSegment(ir, from, to, [highpass2(300, fs)]);
  const env = Float64Array.from(hp, Math.abs);
  const at = (i: number) => env[i - from] ?? 0;
  const win = (a: number, b: number) => {
    let m = 0;
    for (let i = Math.max(from, a); i <= Math.min(to - 1, b); i++) m = Math.max(m, at(i));
    return m;
  };
  const direct = win(t0 - Math.round(0.3 * ms), t0 + Math.round(0.3 * ms));
  if (direct <= 0) return [];
  const out: Reflection[] = [];
  const half = Math.max(1, Math.round(0.25 * ms));
  for (let i = t0 + Math.round(0.5 * ms); i < t0 + Math.round(25 * ms) && i < to; i++) {
    const v = at(i);
    if (v < direct * Math.pow(10, -18 / 20)) continue;
    // A local maximum…
    if (v < win(i - half, i + half)) continue;
    // …that stands out from what surrounds it (not just part of the decaying direct sound or a dense tail)
    const around: number[] = [];
    for (let k = i - Math.round(1.5 * ms); k <= i + Math.round(1.5 * ms); k++) if (Math.abs(k - i) > half && k >= from && k < to) around.push(at(k));
    around.sort((a, b) => a - b);
    const med = around.length ? around[Math.floor(around.length / 2)] : 0;
    if (v < med * 2) continue;
    out.push({ delayMs: (i - t0) / ms, levelDb: 20 * Math.log10(v / direct) });
    i += half;
  }
  return out.sort((a, b) => b.levelDb - a.levelDb).slice(0, 6).sort((a, b) => a.delayMs - b.delayMs);
}

/** Decay time (T60, s) of the impulse response in a narrow band around f, from Schroeder backward integration. */
export function bandDecay(ir: Float64Array, fs: number, t0: number, f: number): number {
  const len = Math.min(ir.length - t0, Math.round(fs * 1.5));
  if (len < fs * 0.1) return NaN;
  const k = Math.pow(2, 1 / 12);
  const y = filterSegment(ir, t0, t0 + len, butterBandpass(f / k, f * k, fs));
  const e = new Float64Array(len);
  let acc = 0;
  for (let i = len - 1; i >= 0; i--) {
    acc += y[i] * y[i];
    e[i] = acc;
  }
  if (!(e[0] > 0)) return NaN;
  const db = (i: number) => 10 * Math.log10(e[i] / e[0]);
  let i5 = -1;
  let i25 = -1;
  for (let i = 0; i < len; i++) {
    const d = db(i);
    if (i5 < 0 && d <= -5) i5 = i;
    if (d <= -25) {
      i25 = i;
      break;
    }
  }
  if (i5 < 0 || i25 <= i5) return NaN;
  return (60 / 20) * ((i25 - i5) / fs);
}

/** Diagnose the low and mid response of an impulse response whose direct sound is at sample t0. */
export function diagnose(ir: Float64Array, fs: number, t0: number, opts: DiagnoseOptions = {}): Diagnosis {
  const c = opts.c ?? 343;
  const modalLimit = opts.modalLimit ?? 250;
  const fLow = Math.max(30, (opts.fMin ?? 20) * 1.5);
  const findings: Finding[] = [];

  // Frequency response (≈ 0.5 s window), finely smoothed, and its 1-octave trend
  const start = Math.max(0, t0 - Math.round(fs * 0.002));
  const n = Math.min(ir.length - start, Math.round(fs * 0.5));
  const w = ir.slice(start, start + n);
  const fade = Math.round(n * 0.2);
  for (let i = 0; i < fade; i++) w[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
  const size = Math.max(nextPow2(n), 1 << 16);
  const sp = spectrumOf(w, fs, size);
  const pow = Float64Array.from(sp.mag, (m) => m * m);
  const grid = logGrid(20, 2000, 48);
  const sm = new LogSmoother(grid, fs / size, sp.mag.length);
  const fine = sm.apply(pow, 12, new Float64Array(grid.length)).map((v) => 10 * Math.log10(Math.max(v, 1e-30)));
  // The trend: a 1-octave average that strong peaks don't pull up (else the sides of a mode look like dips)
  const t1 = octaveTrend(fine, fine);
  const trend = octaveTrend(fine.map((v, i) => Math.min(v, t1[i] + 2)), fine);
  const dev = fine.map((v, i) => v - trend[i]);
  const idx = (f: number) => Math.max(0, Math.min(grid.length - 1, Math.round(Math.log2(f / 20) * 48)));

  // Width of a peak (or dip) where it is 3 dB below (above) its extreme → Q
  const qOf = (i: number, sign: 1 | -1) => {
    const lim = fine[i] - 3 * sign;
    let lo = i;
    let hi = i;
    while (lo > 0 && (fine[lo] - lim) * sign > 0 && i - lo < 48) lo--;
    while (hi < grid.length - 1 && (fine[hi] - lim) * sign > 0 && hi - i < 48) hi++;
    return grid[i] / Math.max(1e-9, grid[hi] - grid[lo]);
  };
  // Local extremes of the deviation from the trend, at least 1/12 octave apart
  const extremes = (sign: 1 | -1, fMin: number, fMax: number, minDev: number) => {
    const out: number[] = [];
    for (let i = idx(fMin); i <= idx(fMax); i++) {
      const v = dev[i] * sign;
      if (v < minDev) continue;
      let best = true;
      for (let k = Math.max(0, i - 4); k <= Math.min(grid.length - 1, i + 4); k++) if (dev[k] * sign > v) best = false;
      if (best) out.push(i);
    }
    return out;
  };

  // --- Reflections, and which of them are speaker-boundary interference
  const reflections = findReflections(ir, fs, t0);
  const dips = extremes(-1, fLow, 600, 4);
  const usedDips = new Set<number>();
  for (const r of reflections) {
    const notch = 1000 / (2 * r.delayMs);
    const path = (c * r.delayMs) / 1000;
    // A dip at (or near) the reflection's first notch confirms it as SBIR
    const dip = dips.find((i) => Math.abs(Math.log2(grid[i] / notch)) < 0.2);
    // Only a strong reflection cancels deeply: g = 10^(L/20) can take at most 20·log10(1 − g) dB off
    const strong = r.levelDb >= -9;
    const sbir = notch >= Math.max(40, fLow) && notch <= 500 && (strong || (r.levelDb >= -12 && dip !== undefined));
    if (sbir) {
      if (dip !== undefined) usedDips.add(dip);
      const f = dip !== undefined ? grid[dip] : notch;
      findings.push({
        kind: 'sbir',
        f,
        delayMs: r.delayMs,
        pathM: path,
        levelDb: dip !== undefined ? dev[dip] : r.levelDb,
        confidence: strong && dip !== undefined ? 'likely' : 'possible',
        title: `Speaker-boundary interference at ${fmtF(f)}`,
        detail: `A ${strong ? 'strong ' : ''}reflection ${r.delayMs.toFixed(1)} ms after the direct sound (${r.levelDb.toFixed(0)} dB, ${path.toFixed(2)} m longer path) cancels the direct sound around ${fmtF(notch)}${dip !== undefined ? `, where the response dips ${Math.abs(dev[dip]).toFixed(1)} dB` : ''}. A boundary about ${(path / 2).toFixed(2)} m from the loudspeaker (or the mic) would cause this.`,
        advice: 'Move the loudspeaker closer to or further from that boundary (wall, floor, desk), or absorb the reflection. EQ can’t fill this dip.',
      });
      continue;
    }
    findings.push({
      kind: 'reflection',
      f: notch,
      delayMs: r.delayMs,
      pathM: path,
      levelDb: r.levelDb,
      confidence: r.levelDb >= -10 ? 'likely' : 'possible',
      title: `Reflection at ${r.delayMs.toFixed(1)} ms`,
      detail: `Arrives ${r.delayMs.toFixed(1)} ms after the direct sound (${path.toFixed(2)} m longer path) at ${r.levelDb.toFixed(0)} dB. It causes comb filtering: notches from ${fmtF(notch)} every ${fmtF(2 * notch)}${r.levelDb >= -6 ? ', clearly audible as colouration' : ''}.`,
      advice: 'Find the surface with that extra path length (desk, console, floor, side wall) and treat or angle it, or move the mic or loudspeaker.',
    });
  }

  // --- Room modes: narrow peaks in the modal region, confirmed by ringing
  const lowF = [60, 80, 100, 125, 160, 200, 250].filter((f) => f < modalLimit && f * 2 < fs);
  const decays = lowF.map((f) => bandDecay(ir, fs, t0, f)).filter(Number.isFinite).sort((a, b) => a - b);
  const decayRef = decays.length ? decays[Math.floor(decays.length / 2)] : NaN;
  for (const i of extremes(1, fLow, modalLimit, 3)) {
    const f = grid[i];
    const q = qOf(i, 1);
    const decay = bandDecay(ir, fs, t0, f);
    const rings = Number.isFinite(decay) && Number.isFinite(decayRef) && decay > decayRef * 1.2;
    // A clear, narrow peak in the lowest octaves, or one that keeps ringing
    if (!rings && (q < 3 || dev[i] < 3.5 || (f >= 150 && dev[i] < 5))) continue;
    const likely = rings || (dev[i] >= 5 && q >= 3 && f < 150);
    const dims = [1, 2, 3].map((k) => (k * c) / (2 * f)).filter((d) => d >= 1.8 && d <= 30);
    // With the room's dimensions known: the predicted mode it matches (within 6 %)
    const match = (opts.predicted ?? []).reduce<{ f: number; label: string } | null>((best, p) => (Math.abs(p.f / f - 1) < 0.06 && (!best || Math.abs(p.f - f) < Math.abs(best.f - f)) ? p : best), null);
    findings.push({
      kind: 'mode',
      f,
      levelDb: dev[i],
      q,
      decay,
      decayRef,
      confidence: likely ? 'likely' : 'possible',
      title: `Room mode at ${fmtF(f)}`,
      detail: `A ${dev[i].toFixed(1)} dB peak (Q ${q.toFixed(1)})${rings ? ` that keeps ringing: ${decay.toFixed(2)} s decay against ${decayRef.toFixed(2)} s for the room's low end` : ''}. ${match ? `It matches your room’s ${match.label} (${fmtF(match.f)}).` : `An axial mode of a ${dims.map((d) => `${d.toFixed(2)} m`).join(' or ') || 'large'} room dimension would fall here.`}`,
      advice: 'Cut it with a narrow EQ filter (it is the same everywhere it rings), and treat it with bass traps or by moving subs and listeners away from its pressure maxima.',
    });
  }

  // --- Dips not explained by a reflection: modal nulls (narrow) or probable SBIR (broad)
  for (const i of dips) {
    if (usedDips.has(i) || dev[i] > -5) continue;
    const f = grid[i];
    const q = qOf(i, -1);
    // Dips that belong to something already reported aren't separate findings: the shoulders of an SBIR dip, and
    // the dip beside a mode (a resonance adds a peak and, where it is out of phase, a dip next to it)
    const near = (kind: FindingKind, oct: number) => findings.some((x) => x.kind === kind && x.confidence === 'likely' && Math.abs(Math.log2(grid[i] / x.f!)) < oct);
    if (near('sbir', 1 / 3) || (grid[i] < modalLimit && near('mode', 2 / 3))) continue;
    if (f < modalLimit && q >= 4 && dev[i] <= -6) {
      findings.push({
        kind: 'null',
        f,
        levelDb: dev[i],
        q,
        confidence: q >= 5 ? 'likely' : 'possible',
        title: `Modal null at ${fmtF(f)}`,
        detail: `A narrow ${Math.abs(dev[i]).toFixed(1)} dB dip (Q ${q.toFixed(1)}) in the modal region: at this position, room modes cancel. It changes strongly when the mic moves.`,
        advice: 'Don’t boost it with EQ. Check at other positions; move the listening position or the subs, or use several subs to even out the modes.',
      });
    } else if (f >= 50 && f <= 500 && q <= 3 && dev[i] <= -7) {
      const d = c / (4 * f);
      findings.push({
        kind: 'sbir',
        f,
        levelDb: dev[i],
        q,
        confidence: 'possible',
        title: `Possible speaker-boundary interference at ${fmtF(f)}`,
        detail: `A broad ${Math.abs(dev[i]).toFixed(1)} dB dip (Q ${q.toFixed(1)}) without a distinct reflection in the impulse response. A boundary about ${d.toFixed(2)} m from the loudspeaker (a quarter wavelength) would cause it.`,
        advice: 'Try moving the loudspeaker relative to the nearest wall or the floor and measure again. EQ can’t fill this dip.',
      });
    }
  }

  const order: Record<FindingKind, number> = { mode: 0, sbir: 1, null: 2, reflection: 3 };
  findings.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'likely' ? -1 : 1) || order[a.kind] - order[b.kind] || Math.abs(b.levelDb) - Math.abs(a.levelDb));
  return { findings, reflections, freqs: grid, fine, trend };
}

/** Run `x[from…to)` through cascaded biquad sections. */
function filterSegment(x: Float64Array, from: number, to: number, sections: { b0: number; b1?: number; b2: number; a1: number; a2: number }[]): Float64Array {
  const y = new Float64Array(Math.max(0, to - from));
  for (let i = from; i < to; i++) y[i - from] = x[i] ?? 0;
  for (const s of sections) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const o = s.b0 * v + (s.b1 ?? 0) * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = o;
      y[i] = o;
    }
  }
  return y;
}

/** 1-octave moving average (in power) of a 1/48-octave grid curve in dB; `ref` only sets the length. */
function octaveTrend(db: ArrayLike<number>, ref: ArrayLike<number>): Float64Array {
  const n = ref.length;
  const p = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) p[i + 1] = p[i] + Math.pow(10, db[i] / 10);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 24);
    const b = Math.min(n, i + 25);
    out[i] = 10 * Math.log10(Math.max((p[b] - p[a]) / (b - a), 1e-30));
  }
  return out;
}

/** 2nd-order Butterworth high-pass as a biquad section (numerator b0·(1 − 2z⁻¹ + z⁻²)). */
function highpass2(fc: number, fs: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w = Math.tan((Math.PI * fc) / fs);
  const k = 1 / (1 + Math.SQRT2 * w + w * w);
  return { b0: k, b1: -2 * k, b2: k, a1: 2 * (w * w - 1) * k, a2: (1 - Math.SQRT2 * w + w * w) * k };
}
