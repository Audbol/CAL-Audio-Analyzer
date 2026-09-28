/** IEC 61672 frequency weightings (A, C, Z) as analytic magnitude curves and as digital IIR filters. */

export type Weighting = 'A' | 'C' | 'Z';

const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

/** Weighting gain in dB at frequency f (analytic, normalised to 0 dB at 1 kHz). */
export function weightingDb(w: Weighting, f: number): number {
  if (w === 'Z' || f <= 0) return 0;
  const f2 = f * f;
  if (w === 'A') {
    const ra = (F4 * F4 * f2 * f2) / ((f2 + F1 * F1) * Math.sqrt((f2 + F2 * F2) * (f2 + F3 * F3)) * (f2 + F4 * F4));
    return 20 * Math.log10(ra) + 2.0;
  }
  const rc = (F4 * F4 * f2) / ((f2 + F1 * F1) * (f2 + F4 * F4));
  return 20 * Math.log10(rc) + 0.062;
}

/** First-order IIR section: y = b0 x + b1 x1 - a1 y1. */
interface Section {
  b0: number;
  b1: number;
  a1: number;
  x1: number;
  y1: number;
}

/** Matched-z first-order low-pass (no zero at Nyquist, so less HF droop than the bilinear version). */
function matchedLowPass(fc: number, fs: number): Section {
  const p = Math.exp((-2 * Math.PI * fc) / fs);
  return { b0: 1 - p, b1: 0, a1: -p, x1: 0, y1: 0 };
}

function firstOrderHighPass(fc: number, fs: number): Section {
  // Pre-warp so the digital pole lands exactly at fc. Analog s/(s+wa), bilinear s = K(1-z^-1)/(1+z^-1)
  const K = 2 * fs;
  const wa = K * Math.tan((Math.PI * fc) / fs);
  const a0 = K + wa;
  return { b0: K / a0, b1: -K / a0, a1: (wa - K) / a0, x1: 0, y1: 0 };
}

/** Streaming weighting filter operating on Float32 blocks. */
export class WeightingFilter {
  private sections: Section[] = [];
  private gain = 1;

  constructor(
    readonly weighting: Weighting,
    readonly fs: number,
  ) {
    if (weighting === 'Z') return;
    const s: Section[] = [firstOrderHighPass(F1, fs), firstOrderHighPass(F1, fs)];
    if (weighting === 'A') s.push(firstOrderHighPass(F2, fs), firstOrderHighPass(F3, fs));
    this.sections = s;
    // The 12.2 kHz pole pair sits close to Nyquist at 44.1/48 kHz, where no first-order digital section matches
    // the analog response. Pick the matched-z pole frequency that minimises the worst-case error up to 0.36·fs.
    const fTop = Math.min(16000, fs * 0.36);
    const probe = [1000, 2000, 4000, 6300, 8000, 10000, 12500, 16000].filter((f) => f <= fTop);
    let best = F4;
    let bestErr = Infinity;
    for (let fc = F4 * 0.6; fc <= Math.min(F4 * 2, fs * 0.49); fc *= 1.005) {
      this.sections = [...s, matchedLowPass(fc, fs), matchedLowPass(fc, fs)];
      this.gain = 1;
      this.gain = 1 / this.magnitudeAt(1000);
      let e = 0;
      for (const f of probe) e = Math.max(e, Math.abs(20 * Math.log10(this.magnitudeAt(f)) - weightingDb(weighting, f)));
      if (e < bestErr) {
        bestErr = e;
        best = fc;
      }
    }
    this.sections = [...s, matchedLowPass(best, fs), matchedLowPass(best, fs)];
    this.gain = 1;
    // Normalise to 0 dB at 1 kHz
    this.gain = 1 / this.magnitudeAt(1000);
  }

  magnitudeAt(f: number): number {
    const w = (2 * Math.PI * f) / this.fs;
    let mag = this.gain;
    for (const s of this.sections) {
      // H(e^jw) = (b0 + b1 e^-jw) / (1 + a1 e^-jw)
      const nr = s.b0 + s.b1 * Math.cos(w);
      const ni = -s.b1 * Math.sin(w);
      const dr = 1 + s.a1 * Math.cos(w);
      const di = -s.a1 * Math.sin(w);
      mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
    }
    return mag;
  }

  /** Filter `input` into `output` (may be the same array). */
  process(input: ArrayLike<number>, output: Float64Array): void {
    const n = input.length;
    for (let i = 0; i < n; i++) output[i] = input[i] * this.gain;
    for (const s of this.sections) {
      let x1 = s.x1;
      let y1 = s.y1;
      const { b0, b1, a1 } = s;
      for (let i = 0; i < n; i++) {
        const x = output[i];
        const y = b0 * x + b1 * x1 - a1 * y1;
        x1 = x;
        y1 = y;
        output[i] = y;
      }
      s.x1 = x1;
      s.y1 = Math.abs(y1) < 1e-30 ? 0 : y1;
    }
  }

  reset(): void {
    for (const s of this.sections) s.x1 = s.y1 = 0;
  }
}
