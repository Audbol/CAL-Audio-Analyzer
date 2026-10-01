import { RingBuffer } from './ring';

/**
 * Low-frequency resolution: extra long analysis windows for the bass, computed on a decimated copy of the signal
 * so that they cost only a few percent of the processing (see TransferFunction and MultiSpectrum).
 * - standard: no extra windows (32k transfer-function window, the RTA's own FFT size)
 * - high: windows equivalent to a 64k FFT (≈ 1.4 s at 48 kHz, 0.73 Hz resolution) for the lowest octaves
 * - max: 128k-equivalent windows as well (≈ 2.7 s, 0.37 Hz)
 */
export type LfResolution = 'standard' | 'high' | 'max';

/** Decimation factor for a sample rate: brings the rate down to ≈ 2.4–4.8 kHz (bass analysis only). */
export function decimationFactor(fs: number): number {
  return Math.max(1, 2 ** Math.floor(Math.log2(fs / 2400)));
}

/** Frequencies below this are analysed from the decimated signal; the anti-alias filter is flat well above it. */
export const DECIMATED_MAX_F = 400;

const filters = new Map<string, Float64Array>();

/** Windowed-sinc (Blackman) low-pass for decimation by `d`: flat to DECIMATED_MAX_F, no aliasing into that band. */
export function decimationFilter(fs: number, d: number): Float64Array {
  const key = `${fs}:${d}`;
  const hit = filters.get(key);
  if (hit) return hit;
  const fsd = fs / d;
  // Content above fsd − DECIMATED_MAX_F would fold into the analysed band: put the stop band there
  const fStop = fsd - DECIMATED_MAX_F - 50;
  const fPass = DECIMATED_MAX_F + 50;
  const fc = (fPass + fStop) / 2;
  const width = fStop - fPass;
  let n = Math.ceil((5.5 * fs) / width);
  if (n % 2 === 0) n++;
  const h = new Float64Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? (2 * fc) / fs : Math.sin((2 * Math.PI * fc * x) / fs) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum; // unity gain at DC
  filters.set(key, h);
  return h;
}

/**
 * A decimated copy of a ring buffer, updated incrementally. Output sample k is the filtered input around absolute
 * input index k·d − offset (`offset` delays the input, e.g. the transfer function's reference delay, exactly and
 * before decimation). Every channel decimated with the same factor has the same filter delay, so it cancels in
 * transfer functions and does not matter for spectra.
 */
export class DecimatedRing {
  readonly ring: RingBuffer;
  readonly fs: number;
  private readonly h: Float64Array;
  private buf = new Float64Array(0);
  /** Next output index (in decimated samples). */
  private next = -1;

  constructor(
    readonly fsIn: number,
    readonly d: number,
    public offset = 0,
    size = 1 << 15,
  ) {
    this.ring = new RingBuffer(size);
    this.fs = fsIn / d;
    this.h = decimationFilter(fsIn, d);
  }

  reset(): void {
    this.ring.clear();
    this.next = -1;
  }

  /** Consume new input from `src` (a full-rate ring). */
  update(src: RingBuffer): void {
    const h = this.h;
    const n = h.length;
    const d = this.d;
    // Output k reads input k·d − offset: the delayed input is complete up to output (written − 1 + offset) / d.
    // (Waiting for k·d + offset instead held the bass windows back by the reference delay.)
    const headIn = src.written + this.offset;
    const last = Math.floor((headIn - 1) / d); // newest output index whose input is complete
    if (last < 0) return;
    // (Re)start near the head, and never try to catch up on a long gap
    if (this.next < 0 || last - this.next > this.ring.capacity / 2 || this.next - last > this.ring.capacity / 2) {
      // Start where the source has real data for the whole filter span
      const firstValid = Math.ceil((src.start + this.offset + n - 1) / d);
      this.next = Math.max(firstValid, last - this.ring.capacity / 4, 0);
      this.ring.anchor(this.next);
    }
    const count = last - this.next + 1;
    if (count <= 0) return;
    // Input span needed: filter centred on each output sample's position
    const first = this.next * d - (n - 1);
    const len = (count - 1) * d + n;
    if (this.buf.length < len) this.buf = new Float64Array(len);
    src.read(first - this.offset, len, this.buf);
    const out = new Float64Array(count);
    const x = this.buf;
    for (let k = 0; k < count; k++) {
      const base = k * d;
      let acc = 0;
      for (let j = 0; j < n; j++) acc += h[j] * x[base + j];
      out[k] = acc;
    }
    this.ring.push(out);
    this.next = last + 1;
  }
}
