/**
 * Feedback finder: narrow peaks that stand out of the spectrum, persist and grow (or ring at a high level) are
 * the signature of acoustic feedback, or of a resonance about to become feedback. Each comes with a suggested
 * notch filter: its frequency, a Q from the peak's width and a depth from how far it sticks out.
 */

export interface FeedbackCandidate {
  f: number;
  /** Level (dB, the spectrum's units). */
  level: number;
  /** How far it stands above the spectrum around it (dB). */
  prominence: number;
  /** Level change over the last second (dB/s). */
  rising: number;
  /** Seconds since it first appeared. */
  age: number;
  /** 'rising': growing now; 'ringing': high and steady. */
  kind: 'rising' | 'ringing';
  notch: { f: number; q: number; gain: number };
}

interface Track {
  f: number;
  first: number;
  last: number;
  history: { t: number; level: number; prominence: number; width: number }[];
}

export interface FeedbackOptions {
  fMin: number;
  fMax: number;
  /** Minimum prominence of a growing peak (dB). */
  minRisingProminence: number;
  /** Minimum prominence of a steady peak (dB). */
  minRingingProminence: number;
  /** Growth that counts as rising (dB/s). */
  minRise: number;
  /** Seconds a peak must last before it is reported. */
  minAge: number;
  /** Widest peak counted as narrow (octaves, at −3 dB). */
  maxWidth: number;
}

const DEFAULTS: FeedbackOptions = { fMin: 80, fMax: 16000, minRisingProminence: 9, minRingingProminence: 15, minRise: 3, minAge: 0.4, maxWidth: 1 / 6 };

export class FeedbackDetector {
  private tracks: Track[] = [];
  readonly opt: FeedbackOptions;

  constructor(opt: Partial<FeedbackOptions> = {}) {
    this.opt = { ...DEFAULTS, ...opt };
  }

  reset(): void {
    this.tracks = [];
  }

  /**
   * One new spectrum (dB on an ascending log-spaced frequency grid) at time `t` (seconds). Returns the current
   * candidates, strongest first.
   */
  update(freqs: ArrayLike<number>, db: ArrayLike<number>, t: number): FeedbackCandidate[] {
    const n = freqs.length;
    const o = this.opt;
    const ppo = n > 1 ? (n - 1) / Math.log2(freqs[n - 1] / freqs[0]) : 48;
    // Baseline around each point: the mean over ±1/3 octave, leaving out the peak itself (±1/24 octave)
    const outer = Math.max(3, Math.round(ppo / 3));
    const inner = Math.max(1, Math.round(ppo / 24));
    const prefix = new Float64Array(n + 1);
    const count = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = db[i];
      const ok = Number.isFinite(v) && v > -250;
      prefix[i + 1] = prefix[i] + (ok ? v : 0);
      count[i + 1] = count[i] + (ok ? 1 : 0);
    }
    const sum = (a: number, b: number) => prefix[Math.min(n, Math.max(0, b))] - prefix[Math.min(n, Math.max(0, a))];
    const cnt = (a: number, b: number) => count[Math.min(n, Math.max(0, b))] - count[Math.min(n, Math.max(0, a))];
    const peaks: { f: number; level: number; prominence: number; width: number }[] = [];
    for (let i = 1; i < n - 1; i++) {
      const f = freqs[i];
      const v = db[i];
      if (f < o.fMin || f > o.fMax || !Number.isFinite(v) || v <= -250) continue;
      if (!(v >= db[i - 1] && v > db[i + 1])) continue;
      const c = cnt(i - outer, i + outer + 1) - cnt(i - inner, i + inner + 1);
      if (c < 2) continue;
      const base = (sum(i - outer, i + outer + 1) - sum(i - inner, i + inner + 1)) / c;
      const prominence = v - base;
      if (prominence < o.minRisingProminence) continue;
      // Width at −3 dB, interpolated between grid points
      const edge = (dir: 1 | -1) => {
        let k = i;
        while (k + dir >= 0 && k + dir < n && db[k + dir] > v - 3) k += dir;
        const a = db[k];
        const b = db[k + dir] ?? a - 6;
        const frac = a - b > 1e-9 ? Math.min(1, (a - (v - 3)) / (a - b)) : 0;
        return (k - i) * dir + frac;
      };
      const width = (edge(1) + edge(-1)) / ppo;
      if (width > o.maxWidth) continue;
      peaks.push({ f, level: v, prominence, width });
    }
    // Follow peaks over time (the same peak stays within 1/24 octave)
    for (const p of peaks) {
      let tr = this.tracks.find((x) => Math.abs(Math.log2(x.f / p.f)) < 1 / 24);
      if (!tr) this.tracks.push((tr = { f: p.f, first: t, last: t, history: [] }));
      tr.f = p.f;
      tr.last = t;
      tr.history.push({ t, ...p });
      while (tr.history.length && t - tr.history[0].t > 2) tr.history.shift();
    }
    this.tracks = this.tracks.filter((x) => t - x.last <= 1);
    const out: FeedbackCandidate[] = [];
    for (const tr of this.tracks) {
      const age = t - tr.first;
      const h = tr.history;
      const cur = h[h.length - 1];
      if (!cur || t - tr.last > 0.3 || age < o.minAge) continue;
      // Growth over the last second: least-squares slope of the level
      const recent = h.filter((x) => t - x.t <= 1);
      let rising = 0;
      if (recent.length >= 3) {
        const mt = recent.reduce((a, x) => a + x.t, 0) / recent.length;
        const ml = recent.reduce((a, x) => a + x.level, 0) / recent.length;
        let num = 0;
        let den = 0;
        for (const x of recent) {
          num += (x.t - mt) * (x.level - ml);
          den += (x.t - mt) ** 2;
        }
        rising = den > 1e-9 ? num / den : 0;
      }
      const isRising = rising >= o.minRise && cur.prominence >= o.minRisingProminence;
      const isRinging = cur.prominence >= o.minRingingProminence;
      if (!isRising && !isRinging) continue;
      // Notch: as wide as the peak (Q from the −3 dB width), as deep as it sticks out (less 3 dB), 3–12 dB
      const bw = Math.max(cur.width, 1 / 96);
      const q = Math.min(40, Math.max(6, 1 / (Math.pow(2, bw / 2) - Math.pow(2, -bw / 2))));
      const gain = -Math.min(12, Math.max(3, Math.round((cur.prominence - 3) * 2) / 2));
      out.push({ f: tr.f, level: cur.level, prominence: cur.prominence, rising, age, kind: isRising ? 'rising' : 'ringing', notch: { f: Math.round(tr.f), q: Math.round(q * 10) / 10, gain } });
    }
    return out.sort((a, b) => b.prominence + b.rising - (a.prominence + a.rising));
  }
}
