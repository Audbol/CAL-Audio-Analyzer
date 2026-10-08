/**
 * Loudness to ITU-R BS.1770-4 / EBU R128: K-weighting, momentary (400 ms), short-term (3 s) and gated integrated
 * loudness, loudness range (EBU Tech 3342) and true peak (oversampled). For a programme signal (e.g. a console's
 * main mix on an input): LUFS is a level of the signal, not of the sound in the room.
 */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages (high shelf, then high-pass) for any sample rate (the BS.1770 analog prototypes). */
export function kWeighting(fs: number): [Biquad, Biquad] {
  // Stage 1: shelving filter (+4 dB above ~1.5 kHz, modelling the head)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass (RLB weighting)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/** Loudness (LUFS) of a mean-square sum (channel weights already applied). */
export const lufs = (meanSquare: number): number => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

/** 4× (or 2×) oversampling for true peak: a windowed-sinc interpolator in polyphase form. */
function interpolator(factor: number, tapsPerPhase = 12): Float64Array[] {
  const n = factor * tapsPerPhase;
  const c = (n - 1) / 2;
  const phases = Array.from({ length: factor }, () => new Float64Array(tapsPerPhase));
  // Kaiser window (beta 7): good stopband with few taps
  const i0 = (x: number) => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const beta = 7;
  for (let i = 0; i < n; i++) {
    const x = (i - c) / factor;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x * 0.92) / (Math.PI * x);
    const w = i0(beta * Math.sqrt(1 - ((2 * i) / (n - 1) - 1) ** 2)) / i0(beta);
    phases[i % factor][Math.floor(i / factor)] = sinc * w * 0.92;
  }
  // Each phase passes DC at unity
  for (const p of phases) {
    const sum = p.reduce((a, b) => a + b, 0);
    for (let k = 0; k < p.length; k++) p[k] /= sum;
  }
  return phases;
}

export interface LoudnessReading {
  /** Momentary loudness (400 ms), LUFS. */
  momentary: number;
  /** Short-term loudness (3 s), LUFS. */
  shortTerm: number;
  /** Integrated (gated) loudness since the start or reset, LUFS. */
  integrated: number;
  /** Loudness range (EBU Tech 3342), LU. */
  range: number;
  /** Highest true peak since the start or reset, dBTP. */
  truePeak: number;
  /** Highest momentary loudness since the start or reset, LUFS. */
  maxMomentary: number;
  /** Seconds measured. */
  duration: number;
}

/** A loudness meter for one or two channels (mono, or left / right at weight 1 each). */
export class LoudnessMeter {
  private readonly filters: [Biquad, Biquad];
  /** Filter state per channel: [x1, x2, y1, y2] for each stage. */
  private state: Float64Array[] = [];
  /** Samples per 100 ms step. */
  private readonly step: number;
  private stepPos = 0;
  private stepSum = 0;
  /** The last 30 steps' mean squares (3 s), newest last. */
  private steps: number[] = [];
  /** 400 ms block mean squares since reset (gating for integrated loudness). */
  private blocks: number[] = [];
  /** 3 s short-term mean squares since reset (loudness range). */
  private shorts: number[] = [];
  private peak = 0;
  private maxM = -Infinity;
  private readonly os: Float64Array[];
  /** Per channel: the last inputs for the interpolator, written twice (at i and i + taps) so a window is contiguous. */
  private hist: Float64Array[] = [];
  private histPos: number[] = [];
  /** The interpolator's largest gain (sum of |taps| of a phase): no interpolated value exceeds this × its inputs. */
  private readonly osGain: number;
  /** Per channel: interpolated outputs still to evaluate (a window holds an input that could beat the peak). */
  private hot: number[] = [];
  private samples = 0;

  constructor(readonly fs: number) {
    this.filters = kWeighting(fs);
    this.step = Math.round(fs / 10);
    const factor = fs < 96000 ? 4 : fs < 192000 ? 2 : 1;
    this.os = factor > 1 ? interpolator(factor) : [];
    this.osGain = Math.max(1, ...this.os.map((p) => p.reduce((a, b) => a + Math.abs(b), 0)));
  }

  reset(): void {
    this.state = [];
    this.stepPos = 0;
    this.stepSum = 0;
    this.steps = [];
    this.blocks = [];
    this.shorts = [];
    this.peak = 0;
    this.maxM = -Infinity;
    this.hist = [];
    this.histPos = [];
    this.hot = [];
    this.samples = 0;
  }

  /** Feed one block per channel (one or two channels, equal lengths). */
  process(channels: ArrayLike<number>[]): void {
    const n = channels[0]?.length ?? 0;
    if (!n) return;
    while (this.state.length < channels.length) this.state.push(new Float64Array(8));
    while (this.hist.length < channels.length) {
      this.hist.push(new Float64Array(2 * (this.os[0]?.length ?? 1)));
      this.histPos.push(0);
      this.hot.push(0);
    }
    const [s1, s2] = this.filters;
    for (let i = 0; i < n; i++) {
      let sq = 0;
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c][i];
        const st = this.state[c];
        // Stage 1 (direct form I)
        const y1 = s1.b0 * x + s1.b1 * st[0] + s1.b2 * st[1] - s1.a1 * st[2] - s1.a2 * st[3];
        st[1] = st[0];
        st[0] = x;
        st[3] = st[2];
        st[2] = y1;
        const y2 = s2.b0 * y1 + s2.b1 * st[4] + s2.b2 * st[5] - s2.a1 * st[6] - s2.a2 * st[7];
        st[5] = st[4];
        st[4] = y1;
        st[7] = st[6];
        st[6] = y2;
        sq += y2 * y2;
        this.truePeakSample(c, x);
      }
      this.stepSum += sq;
      if (++this.stepPos >= this.step) this.endStep();
    }
    this.samples += n;
  }

  private truePeakSample(c: number, x: number): void {
    const a = Math.abs(x);
    if (a > this.peak) this.peak = a;
    if (!this.os.length) return;
    // The newest input goes before the previous ones (a ring, mirrored so the window never wraps), then every
    // phase is evaluated (the interpolated samples between inputs)
    const hst = this.hist[c];
    const taps = hst.length >> 1;
    const pos = (this.histPos[c] + taps - 1) % taps;
    this.histPos[c] = pos;
    hst[pos] = x;
    hst[pos + taps] = x;
    // Only windows holding an input that could make a new peak need the interpolation (the peak only grows)
    if (a * this.osGain > this.peak) this.hot[c] = taps;
    if (this.hot[c] === 0) return;
    this.hot[c]--;
    let peak = this.peak;
    for (const p of this.os) {
      let y = 0;
      for (let k = 0; k < taps; k++) y += p[k] * hst[pos + k];
      if (y > peak) peak = y;
      else if (-y > peak) peak = -y;
    }
    this.peak = peak;
  }

  private endStep(): void {
    this.steps.push(this.stepSum / this.step);
    if (this.steps.length > 30) this.steps.shift();
    this.stepSum = 0;
    this.stepPos = 0;
    const k = this.steps.length;
    if (k >= 4) {
      // 400 ms blocks with 75 % overlap: one per 100 ms step
      const m = (this.steps[k - 1] + this.steps[k - 2] + this.steps[k - 3] + this.steps[k - 4]) / 4;
      this.blocks.push(m);
      this.maxM = Math.max(this.maxM, lufs(m));
    }
    if (k >= 30) this.shorts.push(this.steps.reduce((a, b) => a + b, 0) / 30);
  }

  reading(): LoudnessReading {
    const k = this.steps.length;
    const mean = (arr: number[], from: number) => {
      let s = 0;
      for (let i = from; i < arr.length; i++) s += arr[i];
      return arr.length - from > 0 ? s / (arr.length - from) : 0;
    };
    return {
      momentary: k >= 4 ? lufs(mean(this.steps, k - 4)) : -Infinity,
      shortTerm: k >= 30 ? lufs(mean(this.steps, 0)) : -Infinity,
      integrated: gatedLoudness(this.blocks),
      range: loudnessRange(this.shorts),
      truePeak: this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity,
      maxMomentary: this.maxM,
      duration: this.samples / this.fs,
    };
  }
}

/** Integrated loudness: blocks above −70 LUFS, then above (their loudness − 10 LU). */
export function gatedLoudness(blocks: number[]): number {
  const abs = blocks.filter((z) => lufs(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => lufs(z) > rel);
  return gated.length ? lufs(gated.reduce((a, b) => a + b, 0) / gated.length) : -Infinity;
}

/** Loudness range (EBU Tech 3342): short-term values above −70 LUFS and −20 LU, 95th minus 10th percentile. */
export function loudnessRange(shorts: number[]): number {
  const abs = shorts.filter((z) => lufs(z) > -70);
  if (abs.length < 2) return 0;
  const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 20;
  const l = abs.map(lufs).filter((v) => v > rel).sort((a, b) => a - b);
  if (l.length < 2) return 0;
  const pct = (p: number) => l[Math.min(l.length - 1, Math.max(0, Math.round((p / 100) * (l.length - 1))))];
  return pct(95) - pct(10);
}
