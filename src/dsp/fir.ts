import { FFT } from './fft';
import { eqResponse, type PeqFilter } from './eq';

/**
 * FIR correction: the parametric EQ as an impulse response for convolution (DSPs, convolution players and
 * plug-ins that load a WAV). Minimum phase behaves like the parametric filters themselves (no latency); linear
 * phase changes only the level, at the cost of a latency of half the length.
 */
export interface FirOptions {
  fs: number;
  /** Length in samples (a power of two). */
  taps: number;
  phase: 'minimum' | 'linear';
  /** Lower the whole response so its highest point is 0 dB (no clipping from boosts). */
  headroom: boolean;
}

export interface FirResult {
  taps: Float64Array;
  fs: number;
  /** Delay the filter adds (ms): 0 for minimum phase, half the length for linear phase. */
  latencyMs: number;
  /** Level change applied for headroom (dB, ≤ 0). */
  gainDb: number;
  /** From this frequency up, the FIR matches the EQ within 1 dB (Hz). */
  accurateFrom: number;
  /** Largest deviation from the EQ above 20 Hz (dB). */
  maxErrorDb: number;
  /** Filters left out (at or above half the sample rate). */
  skipped: PeqFilter[];
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** RBJ-cookbook coefficients of a parametric filter at sample rate fs (normalised, a0 = 1). */
export function biquad(f: PeqFilter, fs: number): Biquad {
  const A = Math.pow(10, f.gain / 40);
  const w0 = (2 * Math.PI * f.f) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.05, f.q));
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (f.type === 'peak') {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    const sq = 2 * Math.sqrt(A) * alpha;
    if (f.type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cos + sq);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - sq);
      a0 = A + 1 + (A - 1) * cos + sq;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - sq;
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - sq);
      a0 = A + 1 - (A - 1) * cos + sq;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - sq;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H| of a biquad at frequency f. */
function biquadMag(q: Biquad, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = q.b0 + q.b1 * c1 + q.b2 * c2;
  const ni = -(q.b1 * s1 + q.b2 * s2);
  const dr = 1 + q.a1 * c1 + q.a2 * c2;
  const di = -(q.a1 * s1 + q.a2 * s2);
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

export function designFir(filters: PeqFilter[], o: FirOptions): FirResult {
  const n = o.taps;
  if (n < 64 || (n & (n - 1)) !== 0) throw new Error('The length must be a power of two (64 or more)');
  const nyq = o.fs / 2;
  const use = filters.filter((f) => f.f > 0 && f.f < nyq * 0.98);
  const skipped = filters.filter((f) => !use.includes(f));
  const qs = use.map((f) => biquad(f, o.fs));
  // Headroom: the highest point of the EQ (as designed, up to the top of the band) goes to 0 dB
  const probe = Array.from({ length: 400 }, (_, i) => 10 * Math.pow(Math.min(20000, nyq * 0.98) / 10, i / 399));
  const peak = Math.max(0, ...eqResponse(use, probe));
  const gainDb = o.headroom ? -peak : 0;
  const g = Math.pow(10, gainDb / 20);
  const taps = new Float64Array(n);
  if (o.phase === 'minimum') {
    // The impulse response of the filters themselves (they are minimum phase), faded out over the last eighth
    const x = new Float64Array(n);
    x[0] = g;
    let cur = x;
    for (const q of qs) {
      const y = new Float64Array(n);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const v = q.b0 * cur[i] + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
        x2 = x1;
        x1 = cur[i];
        y2 = y1;
        y1 = v;
        y[i] = v;
      }
      cur = y;
    }
    taps.set(cur);
    const fade = Math.max(8, n >> 3);
    for (let i = 0; i < fade; i++) taps[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
  } else {
    // Linear phase: the magnitude with zero phase, centred, windowed
    const fft = FFT.get(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let k = 0; k <= n / 2; k++) {
      const f = (k * o.fs) / n;
      let m = g;
      for (const q of qs) m *= biquadMag(q, f, o.fs);
      re[k] = m;
      if (k > 0 && k < n / 2) re[n - k] = m;
    }
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) {
      const v = re[(i + n / 2) % n];
      // Hann window over the whole length
      taps[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
    }
  }
  const acc = firAccuracy(taps, o.fs, use, gainDb);
  return { taps, fs: o.fs, latencyMs: o.phase === 'linear' ? ((n / 2) * 1000) / o.fs : 0, gainDb, skipped, ...acc };
}

/** Response of the taps (dB) at the given frequencies, via a zero-padded FFT. */
export function firResponse(taps: ArrayLike<number>, fs: number, freqs: ArrayLike<number>): Float64Array {
  let size = 1;
  while (size < Math.max(65536, taps.length * 4)) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < taps.length; i++) re[i] = taps[i];
  FFT.get(size).forward(re, im);
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const pos = (freqs[i] / fs) * size;
    const k = Math.min(size / 2 - 1, Math.floor(pos));
    const t = pos - k;
    const m0 = Math.hypot(re[k], im[k]);
    const m1 = Math.hypot(re[k + 1], im[k + 1]);
    out[i] = 20 * Math.log10(Math.max(1e-12, m0 + (m1 - m0) * t));
  }
  return out;
}

/** How closely the FIR follows the EQ (as the parametric filters would sound), 20 Hz – 20 kHz. */
function firAccuracy(taps: Float64Array, fs: number, filters: PeqFilter[], gainDb: number): { accurateFrom: number; maxErrorDb: number } {
  const top = Math.min(20000, fs * 0.45);
  const freqs = Array.from({ length: 300 }, (_, i) => 20 * Math.pow(top / 20, i / 299));
  const want = eqResponse(filters, freqs);
  const got = firResponse(taps, fs, freqs);
  let maxErr = 0;
  let from = 20;
  for (let i = 0; i < freqs.length; i++) {
    const e = Math.abs(got[i] - (want[i] + gainDb));
    maxErr = Math.max(maxErr, e);
    if (e > 1) from = freqs[Math.min(freqs.length - 1, i + 1)];
  }
  return { accurateFrom: from, maxErrorDb: maxErr };
}

/** A mono WAV file: 32-bit float or 24-bit integer samples. */
export function wavBytes(data: ArrayLike<number>, fs: number, format: 'float32' | 'pcm24'): ArrayBuffer {
  const bytes = format === 'float32' ? 4 : 3;
  const buf = new ArrayBuffer(44 + data.length * bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data.length * bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format === 'float32' ? 3 : 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * bytes, true);
  v.setUint16(32, bytes, true);
  v.setUint16(34, bytes * 8, true);
  str(36, 'data');
  v.setUint32(40, data.length * bytes, true);
  for (let i = 0; i < data.length; i++) {
    if (format === 'float32') v.setFloat32(44 + i * 4, data[i], true);
    else {
      const s = Math.round(Math.max(-1, Math.min(1 - 1 / 8388608, data[i])) * 8388608);
      const o = 44 + i * 3;
      v.setUint8(o, s & 0xff);
      v.setUint8(o + 1, (s >> 8) & 0xff);
      v.setUint8(o + 2, (s >> 16) & 0xff);
    }
  }
  return buf;
}
