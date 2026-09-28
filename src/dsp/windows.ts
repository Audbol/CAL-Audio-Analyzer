export type WindowType = 'hann' | 'blackman-harris' | 'flat-top' | 'rectangular';

export const WINDOW_LABELS: Record<WindowType, string> = {
  hann: 'Hann',
  'blackman-harris': 'Blackman-Harris',
  'flat-top': 'Flat Top',
  rectangular: 'Rectangular',
};

const cache = new Map<string, Float64Array>();

/** Returns a (cached) window of the given type and length. */
export function getWindow(type: WindowType, n: number): Float64Array {
  const key = `${type}:${n}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = new Float64Array(n);
  const N = n; // periodic windows (better for spectral analysis)
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / N;
    switch (type) {
      case 'hann':
        w[i] = 0.5 - 0.5 * Math.cos(x);
        break;
      case 'blackman-harris':
        w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
        break;
      case 'flat-top':
        w[i] =
          0.21557895 - 0.41663158 * Math.cos(x) + 0.277263158 * Math.cos(2 * x) - 0.083578947 * Math.cos(3 * x) +
          0.006947368 * Math.cos(4 * x);
        break;
      default:
        w[i] = 1;
    }
  }
  cache.set(key, w);
  return w;
}

/** Coherent gain (sum/N) – used to scale amplitude spectra so a full-scale sine reads 0 dBFS. */
export function coherentGain(w: Float64Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s / w.length;
}

/** Sum of squares – used for power/noise normalisation. */
export function powerSum(w: Float64Array): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * w[i];
  return s;
}
