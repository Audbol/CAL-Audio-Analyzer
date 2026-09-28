import { Biquad } from './biquad';
import { PinkNoise } from './noise';

/**
 * A virtual loudspeaker-in-a-room used for demo / training mode: propagation delay, loudspeaker response,
 * room modes, early reflections, a diffuse reverberant tail and a background noise floor.
 * Lets users explore every feature of the analyzer without any hardware.
 */
export class VirtualRoom {
  private delayBuf: Float32Array;
  private delayPos = 0;
  private readonly delay: number;
  private readonly refl: { d: number; g: number }[];
  private speaker: Biquad[];
  private room: Biquad[];
  private combs: { buf: Float32Array; pos: number; g: number; lp: number }[];
  private allpasses: { buf: Float32Array; pos: number }[];
  private noise = new PinkNoise(0xbeef);
  private damp: Biquad;
  private readonly reverbGain: number;
  private excursion: Biquad;
  noiseLevel = Math.pow(10, -72 / 20);

  constructor(
    readonly fs: number,
    distanceM = 4.3,
    rt60 = 0.75,
  ) {
    this.delay = Math.round((distanceM / 343) * fs);
    this.delayBuf = new Float32Array(1 << 15);
    // Floor bounce, walls and ceiling, then increasingly dense and weaker reflections leading into the tail
    this.refl = [
      [2.3, 0.42],
      [4.6, -0.22],
      [7.1, 0.3],
      [9.9, 0.2],
      [13.5, 0.28],
      [17.4, 0.16],
      [21.2, 0.18],
      [25.8, 0.12],
      [30.6, 0.13],
      [36.1, 0.1],
      [41.7, 0.09],
    ].map(([ms, g]) => ({ d: Math.round((ms / 1000) * fs), g }));
    this.speaker = [
      new Biquad('highpass', 58, 0.9, 0, fs),
      new Biquad('peak', 2600, 2.2, 3.5, fs),
      new Biquad('peak', 900, 1.2, -2, fs),
      new Biquad('highshelf', 9000, 0.7, -5, fs),
    ];
    this.room = [
      new Biquad('peak', 47, 7, 9, fs),
      new Biquad('peak', 94, 6, 5, fs),
      new Biquad('peak', 142, 4, -7, fs),
      new Biquad('lowshelf', 180, 0.7, 3, fs),
    ];
    const scale = fs / 44100;
    this.combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => {
      const len = Math.round(d * scale * 1.15);
      return { buf: new Float32Array(len), pos: 0, g: Math.pow(10, (-3 * len) / (rt60 * fs)), lp: 0 };
    });
    this.allpasses = [225, 556, 441].map((d) => ({ buf: new Float32Array(Math.round(d * scale)), pos: 0 }));
    this.damp = new Biquad('lowpass', 5000, 0.7, 0, fs);
    this.excursion = new Biquad('lowpass', 90, 0.7, 0, fs);
    this.reverbGain = 0.15;
  }

  process(x: number): number {
    // Loudspeaker
    let s = x;
    for (const b of this.speaker) s = b.process(s);
    // Mild, level-dependent driver nonlinearity: cone excursion (odd order, LF) and asymmetric 2nd order
    const xl = this.excursion.process(s);
    s += 0.9 * xl * xl * xl + 0.04 * s * s;
    // Propagation delay + early reflections
    const buf = this.delayBuf;
    const mask = buf.length - 1;
    buf[this.delayPos & mask] = s;
    let y = buf[(this.delayPos - this.delay) & mask];
    for (const r of this.refl) y += r.g * buf[(this.delayPos - this.delay - r.d) & mask];
    const direct = buf[(this.delayPos - this.delay - this.refl[0].d) & mask];
    this.delayPos++;
    // Diffuse tail (Schroeder reverb) fed by the delayed signal
    let rev = 0;
    const inp = this.damp.process(direct);
    for (const c of this.combs) {
      const out = c.buf[c.pos];
      c.lp = out * 0.8 + c.lp * 0.2;
      c.buf[c.pos] = inp + c.lp * c.g;
      c.pos = (c.pos + 1) % c.buf.length;
      rev += out;
    }
    for (const a of this.allpasses) {
      const bv = a.buf[a.pos];
      const v = rev + 0.5 * bv;
      a.buf[a.pos] = v;
      a.pos = (a.pos + 1) % a.buf.length;
      rev = bv - 0.5 * v;
    }
    y += rev * this.reverbGain;
    // Room modes
    for (const b of this.room) y = b.process(y);
    return 0.5 * y + this.noise.next() * this.noiseLevel * 5;
  }
}
