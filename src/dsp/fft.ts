/**
 * Iterative radix-2 complex FFT with cached twiddle and bit-reversal tables.
 * Data is stored as separate real / imaginary Float64Arrays for speed.
 */
export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  private static cache = new Map<number, FFT>();

  static get(size: number): FFT {
    let f = FFT.cache.get(size);
    if (!f) {
      f = new FFT(size);
      FFT.cache.set(size, f);
    }
    return f;
  }

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place forward transform. */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, false);
  }

  /** In-place inverse transform (scaled by 1/N). */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, true);
    const n = this.size;
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  private transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const cosT = this.cos;
    const sinT = this.sin;
    const sign = inverse ? -1 : 1;
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < halfLen; j++, k += step) {
          const wr = cosT[k];
          const wi = sign * sinT[k];
          const a = i + j;
          const b = a + halfLen;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/** Convenience: FFT of a real signal (zero padded / truncated to `size`). */
export function realFFT(x: ArrayLike<number>, size: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const n = Math.min(size, x.length);
  for (let i = 0; i < n; i++) re[i] = x[i];
  FFT.get(size).forward(re, im);
  return { re, im };
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
