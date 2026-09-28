/** Deterministic noise sources shared by the audio worklet and tests. */

/** xorshift32 uniform generator in [-1, 1). */
export class WhiteNoise {
  private s: number;
  constructor(seed = 0x12345678) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 2147483648 - 1;
  }
}

/**
 * Pink (1/f) noise using Paul Kellet's refined filter (±0.05 dB from 9 Hz to Nyquist at 44.1 kHz).
 * Output is scaled so the RMS is roughly that of the input white noise (crest factor ≈ 12 dB).
 */
export class PinkNoise {
  private white: WhiteNoise;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;

  constructor(seed = 0x9e3779b9) {
    this.white = new WhiteNoise(seed);
  }

  next(): number {
    const w = this.white.next();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }
}
