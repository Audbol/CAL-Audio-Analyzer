/**
 * Third-octave band filter bank for sound level measurement (IEC 61260-1 style): each band is a 6th-order
 * Butterworth band-pass (three biquads, bilinear transform with pre-warped band edges), run on the raw
 * samples. Band energies accumulate sample by sample, so band levels are exact over any interval and
 * independent of any display or FFT settings.
 */

/** Nominal centre frequencies (base-10 exact: 10^(n/10)), 25 Hz – 16 kHz. */
export function thirdOctaveCentres(fMin = 25, fMax = 16000): number[] {
  const out: number[] = [];
  for (let n = -30; n <= 20; n++) {
    const f = 1000 * Math.pow(10, n / 10);
    if (f >= fMin * 0.99 && f <= fMax * 1.01) out.push(f);
  }
  return out;
}

interface Section {
  b0: number;
  b2: number;
  a1: number;
  a2: number;
}

/** 6th-order Butterworth band-pass between f1 and f2 as three biquads (numerators b0·(1 − z⁻²)). */
export function butterBandpass(f1: number, f2: number, fs: number): Section[] {
  const K = 2 * fs;
  // Pre-warp the band edges so the digital filter has its −3 dB points exactly there
  const w1 = K * Math.tan((Math.PI * f1) / fs);
  const w2 = K * Math.tan((Math.PI * f2) / fs);
  const w0sq = w1 * w2;
  const B = w2 - w1;
  // Low-pass prototype poles of a 3rd-order Butterworth: −1, −½ ± j√3/2
  const proto: [number, number][] = [
    [-1, 0],
    [-0.5, Math.sqrt(3) / 2],
  ];
  // Each prototype pole p maps to the band-pass poles s² − pB·s + w0² = 0
  const poles: [number, number][] = [];
  for (const [pr, pi] of proto) {
    // Roots of s² − (pB)s + w0² with complex p: s = (pB ± √((pB)² − 4w0²)) / 2
    const ar = pr * B;
    const ai = pi * B;
    const dr = ar * ar - ai * ai - 4 * w0sq;
    const di = 2 * ar * ai;
    const mag = Math.hypot(dr, di);
    let sr = Math.sqrt((mag + dr) / 2);
    let si = Math.sqrt(Math.max(0, (mag - dr) / 2));
    if (di < 0) si = -si;
    const r1: [number, number] = [(ar + sr) / 2, (ai + si) / 2];
    const r2: [number, number] = [(ar - sr) / 2, (ai - si) / 2];
    if (pi === 0) {
      // Real prototype pole: its two band-pass poles are a conjugate pair (or real) → one section
      poles.push(r1);
    } else {
      poles.push(r1, r2);
    }
  }
  // Each analog section: H(s) = g·s / (s² − 2Re(q)·s + |q|²); bilinear: s = K(1 − z⁻¹)/(1 + z⁻¹)
  const sections: Section[] = poles.map(([qr, qi]) => {
    const a1s = -2 * qr;
    const a0s = qr * qr + qi * qi;
    const d0 = K * K + a1s * K + a0s;
    return { b0: K / d0, b2: -K / d0, a1: (2 * a0s - 2 * K * K) / d0, a2: (K * K - a1s * K + a0s) / d0 };
  });
  // Unity gain at the geometric centre (digital)
  const wc = 2 * Math.atan(Math.sqrt(w0sq) / K);
  let g = 1;
  for (const s of sections) g *= sectionMag(s, wc);
  const k = Math.pow(1 / g, 1 / sections.length);
  for (const s of sections) {
    s.b0 *= k;
    s.b2 *= k;
  }
  return sections;
}

function sectionMag(s: Section, w: number): number {
  // |b0 (1 − e^{−2jw})| / |1 + a1 e^{−jw} + a2 e^{−2jw}|
  const nr = s.b0 * (1 - Math.cos(2 * w));
  const ni = s.b0 * Math.sin(2 * w);
  const dr = 1 + s.a1 * Math.cos(w) + s.a2 * Math.cos(2 * w);
  const di = -s.a1 * Math.sin(w) - s.a2 * Math.sin(2 * w);
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

/** Magnitude response of a band (for tests). */
export function bandResponse(sections: Section[], f: number, fs: number): number {
  let g = 1;
  for (const s of sections) g *= sectionMag(s, (2 * Math.PI * f) / fs);
  return g;
}

export class ThirdOctaveBank {
  readonly centres: number[];
  private coef: Float64Array; // per band, per section: b0, b2, a1, a2
  private state: Float64Array; // per band, per section: x1, x2, y1, y2
  /** Accumulated band energy (sum of squares) since the last take(). */
  readonly acc: Float64Array;

  constructor(readonly fs: number) {
    // Bands whose upper edge stays well below Nyquist
    this.centres = thirdOctaveCentres(25, 16000).filter((f) => f * Math.pow(2, 1 / 6) < fs * 0.45);
    const n = this.centres.length;
    this.coef = new Float64Array(n * 3 * 4);
    this.state = new Float64Array(n * 3 * 4);
    this.acc = new Float64Array(n);
    const half = Math.pow(10, 0.05); // band edges: ×/÷ 10^(1/20) (base-10 third octave)
    this.centres.forEach((fc, b) => {
      butterBandpass(fc / half, fc * half, fs).forEach((s, k) => {
        const o = (b * 3 + k) * 4;
        this.coef[o] = s.b0;
        this.coef[o + 1] = s.b2;
        this.coef[o + 2] = s.a1;
        this.coef[o + 3] = s.a2;
      });
    });
  }

  /** Filter a block and add each band's energy to `acc`. */
  process(x: ArrayLike<number>, from = 0, to = x.length): void {
    const n = this.centres.length;
    const c = this.coef;
    const st = this.state;
    for (let b = 0; b < n; b++) {
      let e = 0;
      // Three cascaded sections, state kept in locals for speed
      const o0 = b * 12;
      const b00 = c[o0], b20 = c[o0 + 1], a10 = c[o0 + 2], a20 = c[o0 + 3];
      const b01 = c[o0 + 4], b21 = c[o0 + 5], a11 = c[o0 + 6], a21 = c[o0 + 7];
      const b02 = c[o0 + 8], b22 = c[o0 + 9], a12 = c[o0 + 10], a22 = c[o0 + 11];
      let x10 = st[o0], x20 = st[o0 + 1], y10 = st[o0 + 2], y20 = st[o0 + 3];
      let x11 = st[o0 + 4], x21 = st[o0 + 5], y11 = st[o0 + 6], y21 = st[o0 + 7];
      let x12 = st[o0 + 8], x22 = st[o0 + 9], y12 = st[o0 + 10], y22 = st[o0 + 11];
      for (let i = from; i < to; i++) {
        const v = x[i];
        const s0 = b00 * v + b20 * x20 - a10 * y10 - a20 * y20;
        x20 = x10; x10 = v; y20 = y10; y10 = s0;
        const s1 = b01 * s0 + b21 * x21 - a11 * y11 - a21 * y21;
        x21 = x11; x11 = s0; y21 = y11; y11 = s1;
        const s2 = b02 * s1 + b22 * x22 - a12 * y12 - a22 * y22;
        x22 = x12; x12 = s1; y22 = y12; y12 = s2;
        e += s2 * s2;
      }
      st[o0] = x10; st[o0 + 1] = x20; st[o0 + 2] = y10; st[o0 + 3] = y20;
      st[o0 + 4] = x11; st[o0 + 5] = x21; st[o0 + 6] = y11; st[o0 + 7] = y21;
      st[o0 + 8] = x12; st[o0 + 9] = x22; st[o0 + 10] = y12; st[o0 + 11] = y22;
      this.acc[b] += e;
    }
  }

  /** The accumulated band energies (and reset them). */
  take(): Float64Array {
    const out = Float64Array.from(this.acc);
    this.acc.fill(0);
    return out;
  }
}
