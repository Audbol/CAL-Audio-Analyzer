/**
 * The signal generator shared by the browser audio worklet and the desktop app's native audio host:
 * noise, sine, periodic sweep, music, and one-off playback (measurement sweeps). Produces one sample at a time
 * and reports playback / music events through `post`.
 */
import { PinkNoise, WhiteNoise } from './noise';
import type { GeneratorConfig, ProcessorEvent, ProcessorMessage } from './protocol';

const PINK_RMS = 0.193;
const WHITE_RMS = 0.577;

export class GeneratorCore {
  gen: GeneratorConfig = { type: 'off', level: -18, freq: 1000, outputs: [0, 1], polarity: 1 };
  private pink = new PinkNoise();
  private white = new WhiteNoise();
  private phase = 0;
  private gain = 0;
  private targetGain = 0;
  private playback: { data: Float32Array; pos: number; id: number } | null = null;
  private sweepPos = 0;
  private sweepCache: Float32Array | null = null;
  music: { data: Float32Array; pos: number; id: number } | null = null;

  /**
   * @param sampleRate Sample rate of the generated signal.
   * @param post Event sink (playStarted / playEnded / musicEnded).
   * @param now Frame number of the next generated sample, for playback events.
   */
  constructor(
    readonly sampleRate: number,
    private post: (ev: ProcessorEvent) => void,
    private now: () => number,
  ) {}

  /** Handle a generator message; returns false for messages that are not the generator's (e.g. 'simulate'). */
  onMessage(m: ProcessorMessage): boolean {
    switch (m.type) {
      case 'generator':
        this.gen = m.config;
        this.targetGain = m.config.type === 'off' ? 0 : Math.pow(10, m.config.level / 20);
        return true;
      case 'play':
        this.playback = { data: m.data, pos: 0, id: m.id };
        this.post({ type: 'playStarted', id: m.id, frame: this.now() });
        return true;
      case 'stopPlay':
        this.playback = null;
        return true;
      case 'music':
        this.music = m.data ? { data: m.data, pos: Math.max(0, Math.min(m.pos ?? 0, m.data.length)), id: m.id } : null;
        return true;
      case 'musicSeek':
        if (this.music) this.music.pos = Math.max(0, Math.min(Math.round(m.pos), this.music.data.length));
        return true;
      default:
        return false;
    }
  }

  /** Music position for the UI. */
  musicState(): { id: number; pos: number } | undefined {
    return this.music ? { id: this.music.id, pos: Math.min(this.music.pos, this.music.data.length) } : undefined;
  }

  /** Continuous periodic log sweep (for live transfer function measurement with sweeps). */
  private sweepSample(): number {
    const sr = this.sampleRate;
    if (!this.sweepCache) {
      const n = Math.round(sr);
      const f1 = 20;
      const f2 = Math.min(20000, sr / 2.2);
      const L = 1 / Math.log(f2 / f1);
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const g = i < 480 ? i / 480 : i > n - 480 ? (n - i) / 480 : 1;
        buf[i] = g * Math.sin(2 * Math.PI * f1 * L * (Math.exp(t / L) - 1));
      }
      this.sweepCache = buf;
    }
    const v = this.sweepCache[this.sweepPos];
    this.sweepPos = (this.sweepPos + 1) % this.sweepCache.length;
    return v;
  }

  /** The next generator sample. `frame`: its frame number (for the playback end event). */
  next(frame: number): number {
    const pb = this.playback;
    if (pb) {
      const v = pb.pos < pb.data.length ? pb.data[pb.pos] : 0;
      pb.pos++;
      if (pb.pos >= pb.data.length) {
        this.post({ type: 'playEnded', id: pb.id, frame });
        this.playback = null;
      }
      return v;
    }
    // Smooth level changes (≈10 ms) to avoid clicks
    this.gain += (this.targetGain - this.gain) * 0.002;
    if (this.gain < 1e-6 && this.targetGain === 0) return 0;
    let v = 0;
    switch (this.gen.type) {
      case 'pink':
        v = (this.pink.next() / PINK_RMS) * Math.SQRT1_2;
        break;
      case 'white':
        v = (this.white.next() / WHITE_RMS) * Math.SQRT1_2;
        break;
      case 'sine':
        this.phase += (2 * Math.PI * this.gen.freq) / this.sampleRate;
        if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
        v = Math.sin(this.phase);
        break;
      case 'sweep':
        v = this.sweepSample();
        break;
      case 'music': {
        // Advances only while the generator is on, so switching it off pauses the track
        const mu = this.music;
        if (!mu) break;
        if (mu.pos < mu.data.length) v = mu.data[mu.pos++];
        if (mu.pos === mu.data.length) {
          mu.pos++;
          this.post({ type: 'musicEnded', id: mu.id });
        }
        break;
      }
      default:
        v = 0;
    }
    const out = v * this.gain * this.gen.polarity;
    return out > 1 ? 1 : out < -1 ? -1 : out;
  }
}
