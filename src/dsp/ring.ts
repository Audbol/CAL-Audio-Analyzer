/** Fixed-size circular sample buffer addressed by an absolute, monotonically increasing sample index. */
export class RingBuffer {
  readonly data: Float32Array;
  readonly mask: number;
  /** Absolute index of the next sample to be written. */
  written = 0;
  /** Absolute index of the first real sample (earlier indices read as silence that never happened). */
  start = 0;

  constructor(sizePow2: number) {
    if ((sizePow2 & (sizePow2 - 1)) !== 0) throw new Error('RingBuffer size must be a power of two');
    this.data = new Float32Array(sizePow2);
    this.mask = sizePow2 - 1;
  }

  get capacity(): number {
    return this.data.length;
  }

  push(block: ArrayLike<number>): void {
    const n = block.length;
    const d = this.data;
    const m = this.mask;
    let w = this.written;
    for (let i = 0; i < n; i++, w++) d[w & m] = block[i];
    this.written = w;
  }

  /** Copy `n` samples starting at absolute index `start` into `out` (zeros for unavailable samples). */
  read(start: number, n: number, out: Float64Array | Float32Array, offset = 0): void {
    const d = this.data;
    const m = this.mask;
    const oldest = this.written - this.data.length;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      out[offset + i] = idx < 0 || idx < oldest || idx >= this.written ? 0 : d[idx & m];
    }
  }

  /** Copy the most recent `n` samples ending `delay` samples before the write head. */
  latest(n: number, out: Float64Array | Float32Array, delay = 0): void {
    this.read(this.written - n - delay, n, out);
  }

  clear(): void {
    this.data.fill(0);
    this.written = 0;
    this.start = 0;
  }

  /** Empty the buffer and continue at absolute index `index` (e.g. following a remote host's clock). */
  anchor(index: number): void {
    this.data.fill(0);
    this.written = index;
    this.start = index;
  }

  /** First index from which `n` samples ending at the head are all real data. */
  get validFrom(): number {
    return Math.max(this.start, this.written - this.data.length);
  }
}
