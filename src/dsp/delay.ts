import { FFT, nextPow2 } from './fft';

export interface DelayEstimate {
  /** Delay of `y` relative to `x` in samples (positive = y lags x). */
  samples: number;
  /** Sub-sample refined delay. */
  fractional: number;
  ms: number;
  /** Peak-to-median ratio of the correlation, a confidence measure (dB). */
  confidenceDb: number;
  polarityInverted: boolean;
}

/**
 * Estimate the delay between reference x and measurement y by generalized cross-correlation with
 * PHAT weighting (robust against coloured spectra and room reflections).
 */
export function findDelay(x: ArrayLike<number>, y: ArrayLike<number>, fs: number, maxDelay?: number): DelayEstimate {
  const len = Math.min(x.length, y.length);
  const n = nextPow2(len * 2);
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const yr = new Float64Array(n);
  const yi = new Float64Array(n);
  for (let i = 0; i < len; i++) {
    xr[i] = x[i];
    yr[i] = y[i];
  }
  const fft = FFT.get(n);
  fft.forward(xr, xi);
  fft.forward(yr, yi);
  // R = conj(X) Y / |conj(X) Y|^beta   (beta < 1 keeps some magnitude weighting, reducing noise sensitivity)
  const beta = 0.8;
  for (let k = 0; k < n; k++) {
    const r = xr[k] * yr[k] + xi[k] * yi[k];
    const i = xr[k] * yi[k] - xi[k] * yr[k];
    const m = Math.pow(Math.hypot(r, i) + 1e-20, beta);
    xr[k] = r / m;
    xi[k] = i / m;
  }
  fft.inverse(xr, xi);
  const limit = Math.min(maxDelay ?? len - 1, n / 2 - 1);
  let best = 0;
  let bestAbs = -1;
  for (let lag = 0; lag <= limit; lag++) {
    const v = Math.abs(xr[lag]);
    if (v > bestAbs) {
      bestAbs = v;
      best = lag;
    }
  }
  // Parabolic interpolation around the peak for sub-sample precision
  const at = (l: number) => Math.abs(xr[(l + n) % n]);
  const a = at(best - 1);
  const b = at(best);
  const c = at(best + 1);
  const denom = a - 2 * b + c;
  const frac = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  // Confidence: peak relative to the median absolute correlation value
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(limit / 2000));
  for (let lag = 0; lag <= limit; lag += stride) sample.push(Math.abs(xr[lag]));
  sample.sort((p, q) => p - q);
  const median = sample[Math.floor(sample.length / 2)] || 1e-20;
  const fractional = best + frac;
  return {
    samples: best,
    fractional,
    ms: (fractional / fs) * 1000,
    confidenceDb: 20 * Math.log10(bestAbs / median),
    polarityInverted: xr[best] < 0,
  };
}

/** Speed of sound in m/s for air temperature in °C. */
export function speedOfSound(tempC = 20): number {
  return 331.3 * Math.sqrt(1 + tempC / 273.15);
}
