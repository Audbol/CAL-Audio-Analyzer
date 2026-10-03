/**
 * Group delay from a wrapped phase response: τ(f) = −dφ/dω, in milliseconds. Central differences on the phase,
 * each step unwrapped (the grid must be fine enough that the phase moves less than 180° between points, as on
 * the 1/48-octave display grid with the delay compensated). Points next to a gap (NaN) are NaN.
 */
export function groupDelayMs(freqs: ArrayLike<number>, phaseDeg: ArrayLike<number>, out: Float64Array = new Float64Array(freqs.length)): Float64Array {
  const n = freqs.length;
  const wrap = (d: number) => d - 360 * Math.round(d / 360);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const pa = phaseDeg[a];
    const pi = phaseDeg[i];
    const pb = phaseDeg[b];
    if (b === a || !Number.isFinite(pa) || !Number.isFinite(pi) || !Number.isFinite(pb)) {
      out[i] = NaN;
      continue;
    }
    const dPhi = wrap(pi - pa) + wrap(pb - pi);
    out[i] = (-dPhi / 360 / (freqs[b] - freqs[a])) * 1000;
  }
  return out;
}

/**
 * Smooths a group delay curve over 1/`fraction` octave, weighting each point by `weight` (e.g. power × coherence):
 * the raw curve spikes at every dip, where the phase turns fast but there is hardly any energy, and those spikes
 * would hide the delay of the sound that is actually there. Works on any ascending frequency list.
 */
export function smoothGroupDelay(freqs: ArrayLike<number>, gd: ArrayLike<number>, weight: ArrayLike<number>, fraction = 6, out: Float64Array = new Float64Array(freqs.length)): Float64Array {
  const n = freqs.length;
  const half = 2 ** (1 / (2 * fraction));
  // Prefix sums of w·gd and w, skipping missing points
  const sw = new Float64Array(n + 1);
  const swg = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    const v = gd[i];
    const ok = Number.isFinite(w) && Number.isFinite(v) && w > 0;
    sw[i + 1] = sw[i] + (ok ? w : 0);
    swg[i + 1] = swg[i] + (ok ? w * v : 0);
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const f = freqs[i];
    while (lo < n && freqs[lo] < f / half) lo++;
    while (hi < n && freqs[hi] <= f * half) hi++;
    const w = sw[hi] - sw[lo];
    out[i] = w > 0 && Number.isFinite(gd[i]) ? (swg[hi] - swg[lo]) / w : NaN;
  }
  return out;
}
