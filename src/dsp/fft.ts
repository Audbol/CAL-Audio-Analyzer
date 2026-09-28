/**
 * Iterative complex FFT (radix-4 passes with a radix-2 pass when log2(n) is odd) with cached twiddle and
 * bit-reversal tables, plus a real-input transform that uses a half-size complex FFT.
 * Data is stored as separate real / imaginary Float64Arrays for speed.
 */
export class FFT {
  readonly size: number;
  /** cos / −sin of 2πk/n for k < n/2 (forward twiddles). */
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  /** Index pairs (i, j), i < j, to swap for the bit-reversed order. */
  private readonly swaps: Uint32Array;
  /** Per radix-4 pass: packed twiddles [w1r, w1i, w2r, w2i] for j = 0…m−1 (forward sign), read sequentially. */
  private passes: { m: number; tw: Float64Array }[] = [];
  private half?: FFT;
  private zr?: Float64Array;
  private zi?: Float64Array;

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
    const bits = Math.log2(size);
    const pairs: number[] = [];
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      if (r > i) pairs.push(i, r);
    }
    this.swaps = Uint32Array.from(pairs);
    for (let m = Math.log2(size) % 2 === 1 ? 2 : 1; m < size; m <<= 2) {
      const s1 = size / (2 * m);
      const s2 = s1 >> 1;
      const tw = new Float64Array(4 * m);
      for (let j = 0; j < m; j++) {
        tw[4 * j] = this.cos[j * s1];
        tw[4 * j + 1] = this.sin[j * s1];
        tw[4 * j + 2] = this.cos[j * s2];
        tw[4 * j + 3] = this.sin[j * s2];
      }
      this.passes.push({ m, tw });
    }
  }

  /** In-place forward transform. */
  forward(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, 1);
  }

  /** In-place inverse transform (scaled by 1/N). */
  inverse(re: Float64Array, im: Float64Array): void {
    this.transform(re, im, -1);
    const n = this.size;
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  /**
   * Forward transform of a real signal of length n (`x` is not modified). Writes bins 0…n/2 to `re` / `im`
   * (length ≥ n/2 + 1). Uses a complex FFT of half the size: about twice as fast as a complex transform with
   * a zero imaginary part.
   */
  forwardReal(x: ArrayLike<number>, re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const h = n >> 1;
    if (h < 2) {
      re[0] = x[0] + x[1];
      im[0] = 0;
      re[1] = x[0] - x[1];
      im[1] = 0;
      return;
    }
    this.half ??= FFT.get(h);
    const zr = (this.zr ??= new Float64Array(h));
    const zi = (this.zi ??= new Float64Array(h));
    for (let k = 0; k < h; k++) {
      zr[k] = x[2 * k];
      zi[k] = x[2 * k + 1];
    }
    this.half.transform(zr, zi, 1);
    // Split: X[k] = E[k] + W^k O[k], with E / O the spectra of the even / odd samples
    const c = this.cos;
    const s = this.sin;
    re[0] = zr[0] + zi[0];
    im[0] = 0;
    re[h] = zr[0] - zi[0];
    im[h] = 0;
    for (let k = 1; k < h; k++) {
      const ar = zr[k];
      const ai = zi[k];
      const br = zr[h - k];
      const bi = -zi[h - k];
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai + bi);
      const or = 0.5 * (ai - bi);
      const oi = -0.5 * (ar - br);
      const wr = c[k];
      const wi = s[k];
      re[k] = er + (or * wr - oi * wi);
      im[k] = ei + (or * wi + oi * wr);
    }
  }

  private transform(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
    const n = this.size;
    const sw = this.swaps;
    for (let p = 0; p < sw.length; p += 2) {
      const i = sw[p];
      const j = sw[p + 1];
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
    // Odd number of stages: one radix-2 pass first (twiddle 1)
    if (Math.log2(n) % 2 === 1) {
      for (let i = 0; i < n; i += 2) {
        const xr = re[i + 1];
        const xi = im[i + 1];
        re[i + 1] = re[i] - xr;
        im[i + 1] = im[i] - xi;
        re[i] += xr;
        im[i] += xi;
      }
    }
    // Radix-4 passes: two radix-2 stages (half-lengths m and 2m) fused into one pass over the data, with
    // the pass's twiddles packed for sequential reads. Blocks outer / butterflies inner walks the data
    // sequentially, which matters for the long transforms.
    for (const { m, tw } of this.passes) {
      const span = 4 * m;
      for (let base = 0; base < n; base += span) {
        for (let j = 0, t = 0; j < m; j++, t += 4) {
          const a = base + j;
          const b = a + m;
          const c = b + m;
          const d = c + m;
          const w1r = tw[t];
          const w1i = sign * tw[t + 1];
          const w2r = tw[t + 2];
          const w2i = sign * tw[t + 3];
          // First stage: (a, b) and (c, d) with W(2m)^j
          let tr = re[b] * w1r - im[b] * w1i;
          let ti = re[b] * w1i + im[b] * w1r;
          const ar = re[a] + tr;
          const ai = im[a] + ti;
          const br = re[a] - tr;
          const bi = im[a] - ti;
          tr = re[d] * w1r - im[d] * w1i;
          ti = re[d] * w1i + im[d] * w1r;
          const cr = re[c] + tr;
          const ci = im[c] + ti;
          const dr = re[c] - tr;
          const di = im[c] - ti;
          // Second stage: (a, c) with W(4m)^j and (b, d) with W(4m)^(j+m) = W(4m)^j · (∓i)
          const ur = cr * w2r - ci * w2i;
          const ui = cr * w2i + ci * w2r;
          const vr = sign * (dr * w2i + di * w2r);
          const vi = -sign * (dr * w2r - di * w2i);
          re[a] = ar + ur;
          im[a] = ai + ui;
          re[c] = ar - ur;
          im[c] = ai - ui;
          re[b] = br + vr;
          im[b] = bi + vi;
          re[d] = br - vr;
          im[d] = bi - vi;
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
