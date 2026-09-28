import { formatFreq, noteName } from '../dsp/freq';
import { CHART } from './theme';
import { Plot } from './plot';

/** Perceptually ordered colour map (inferno-like), 256 entries. */
function buildLut(): Uint8ClampedArray {
  const stops: [number, number, number, number][] = [
    [0, 0, 0, 4],
    [0.13, 31, 12, 72],
    [0.25, 85, 15, 109],
    [0.38, 136, 34, 106],
    [0.5, 186, 54, 85],
    [0.63, 227, 89, 51],
    [0.75, 249, 140, 10],
    [0.88, 249, 201, 50],
    [1, 252, 255, 164],
  ];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < stops.length - 2 && stops[j + 1][0] < t) j++;
    const [t0, r0, g0, b0] = stops[j];
    const [t1, r1, g1, b1] = stops[j + 1];
    const u = (t - t0) / (t1 - t0);
    lut[i * 3] = r0 + (r1 - r0) * u;
    lut[i * 3 + 1] = g0 + (g1 - g0) * u;
    lut[i * 3 + 2] = b0 + (b1 - b0) * u;
  }
  return lut;
}
const LUT = buildLut();

/** Scrolling spectrogram (time →, log frequency ↑). */
export class Spectrogram {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly img: HTMLCanvasElement;
  private readonly imgCtx: CanvasRenderingContext2D;
  private readonly tip: HTMLDivElement;
  private column: ImageData;
  private rows = 360;
  private cols = 600;
  dbMin = -110;
  dbMax = -10;
  fMin = 20;
  fMax = 20000;
  private w = 0;
  private h = 0;
  private mouse: { x: number; y: number } | null = null;
  /** Column the next spectrum is written to (the image is a circular buffer: no scrolling copies). */
  private writeX = 0;
  /** Needs a redraw (new column, resize, range, hover). */
  private dirty = true;
  /** Per image row: the FFT bin range it covers, for the bin spacing / bin count it was built for. */
  private rowBins: { key: string; b0: Int32Array; b1: Int32Array } | null = null;
  private readonly padL = 46;
  /** Frequency horizontal (newest at the top, like a waterfall) or vertical (newest at the right). */
  orientation: 'horizontal' | 'vertical' = 'vertical';

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'plot';
    this.canvas = document.createElement('canvas');
    this.el.append(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'plot-tip';
    this.el.append(this.tip);
    this.ctx = this.canvas.getContext('2d')!;
    this.img = document.createElement('canvas');
    this.img.width = this.cols;
    this.img.height = this.rows;
    this.imgCtx = this.img.getContext('2d')!;
    this.imgCtx.fillStyle = '#000';
    this.imgCtx.fillRect(0, 0, this.cols, this.rows);
    this.column = this.imgCtx.createImageData(1, this.rows);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.dirty = true;
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouse = null;
      this.tip.style.display = 'none';
      this.dirty = true;
    });
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(Plot.maxDpr, this.el.ownerDocument.defaultView?.devicePixelRatio || window.devicePixelRatio || 1);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
    this.draw();
  }

  /** Push one spectrum: power values on linear bins with bin spacing df. */
  push(power: ArrayLike<number>, df: number, offsetDb = 0): void {
    const d = this.column.data;
    const range = this.dbMax - this.dbMin;
    const nb = power.length;
    const key = `${df}|${nb}|${this.fMin}|${this.fMax}`;
    if (this.rowBins?.key !== key) {
      const b0 = new Int32Array(this.rows);
      const b1 = new Int32Array(this.rows);
      for (let r = 0; r < this.rows; r++) {
        // Row 0 = top = fMax
        const f0 = this.fMin * Math.pow(this.fMax / this.fMin, 1 - (r + 1) / this.rows);
        const f1 = this.fMin * Math.pow(this.fMax / this.fMin, 1 - r / this.rows);
        b0[r] = Math.max(1, Math.min(nb - 1, Math.floor(f0 / df)));
        b1[r] = Math.max(b0[r], Math.min(nb - 1, Math.ceil(f1 / df)));
      }
      this.rowBins = { key, b0, b1 };
    }
    const { b0, b1 } = this.rowBins;
    const scale = 255 / range;
    for (let r = 0; r < this.rows; r++) {
      let m = 0;
      for (let b = b0[r]; b <= b1[r]; b++) if (power[b] > m) m = power[b];
      const db = 10 * Math.log10(Math.max(m, 1e-30)) + offsetDb;
      const v = Math.max(0, Math.min(255, Math.round((db - this.dbMin) * scale)));
      const o = r * 4;
      d[o] = LUT[v * 3];
      d[o + 1] = LUT[v * 3 + 1];
      d[o + 2] = LUT[v * 3 + 2];
      d[o + 3] = 255;
    }
    this.imgCtx.putImageData(this.column, this.writeX, 0);
    this.writeX = (this.writeX + 1) % this.cols;
    this.dirty = true;
  }

  clear(): void {
    this.imgCtx.fillStyle = '#000';
    this.imgCtx.fillRect(0, 0, this.cols, this.rows);
    this.dirty = true;
  }

  /** Redraw on the next frame (colour scheme or range changed). */
  invalidate(): void {
    this.dirty = true;
  }

  draw(): void {
    const ctx = this.ctx;
    const { w, h, padL } = this;
    if (!w || !h || !this.dirty) return;
    this.dirty = false;
    const horiz = this.orientation === 'horizontal';
    // Plot area: the bottom margin holds the frequency / time axis and the colour legend
    const padB = horiz ? 38 : 22;
    const x0 = padL;
    const y0 = 0;
    const pw = w - padL - 8;
    const ph = h - padB;
    ctx.fillStyle = CHART.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    // The image is circular (oldest columns start at writeX): draw its two parts in time order. Horizontal
    // layout: the same drawing through a transform that puts time on the vertical axis (newest at the top)
    // and frequency on the horizontal axis.
    ctx.save();
    const tw = horiz ? ph : pw; // extent of the time axis
    const fw = horiz ? pw : ph; // extent of the frequency axis
    if (horiz) ctx.transform(0, -1, -1, 0, x0 + pw, y0 + ph);
    else ctx.translate(x0, y0);
    const older = this.cols - this.writeX;
    const split = Math.round((older / this.cols) * tw);
    if (older > 0) ctx.drawImage(this.img, this.writeX, 0, older, this.rows, 0, 0, split, fw);
    if (this.writeX > 0) ctx.drawImage(this.img, 0, 0, this.writeX, this.rows, split, 0, tw - split, fw);
    ctx.restore();
    // Frequency grid and labels
    const fPos = (f: number) => Math.log(f / this.fMin) / Math.log(this.fMax / this.fMin); // 0…1 low → high
    ctx.font = '10px Inter, system-ui, sans-serif';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f < this.fMin || f > this.fMax) continue;
      const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
      ctx.fillStyle = CHART.grid;
      if (horiz) {
        const x = x0 + fPos(f) * pw;
        ctx.fillRect(x, y0, 1, ph);
        ctx.fillStyle = CHART.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(label, Math.min(Math.max(x, x0 + 8), x0 + pw - 10), ph + 4);
      } else {
        const y = (1 - fPos(f)) * ph;
        ctx.fillRect(x0, y, pw, 1);
        ctx.fillStyle = CHART.text;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, padL - 6, Math.min(Math.max(y, 6), ph - 4));
      }
    }
    // Colour bar legend at the bottom right (sized to fit narrow screens), time label at the bottom left
    ctx.textBaseline = 'top';
    const legendY = horiz ? ph + 20 : ph + 5;
    const minTxt = `${Math.round(this.dbMin)}`;
    const maxTxt = `${Math.round(this.dbMax)} dB`;
    const barW = Math.round(Math.max(50, Math.min(120, (w - padL) * 0.3)));
    const maxW = ctx.measureText(maxTxt).width;
    const minW = ctx.measureText(minTxt).width;
    const barX = w - 8 - maxW - 4 - barW;
    const lg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    for (let i = 0; i <= 8; i++) {
      const v = Math.round((i / 8) * 255);
      lg.addColorStop(i / 8, `rgb(${LUT[v * 3]},${LUT[v * 3 + 1]},${LUT[v * 3 + 2]})`);
    }
    ctx.fillStyle = lg;
    ctx.fillRect(barX, legendY + 1, barW, 8);
    ctx.fillStyle = CHART.text;
    ctx.textAlign = 'right';
    ctx.fillText(minTxt, barX - 4, legendY);
    ctx.textAlign = 'left';
    ctx.fillText(maxTxt, barX + barW + 4, legendY);
    const room = barX - 4 - minW - 12 - padL;
    const long = horiz ? 'time ↑   (newest at top)' : 'time →   (newest at right)';
    const short = horiz ? 'time ↑' : 'time →';
    const timeTxt = room > ctx.measureText(long).width ? long : room > ctx.measureText(short).width ? short : '';
    if (timeTxt) ctx.fillText(timeTxt, padL, legendY);
    // Hover readout: frequency, note and the average level there
    const m = this.mouse;
    if (m && m.x > x0 && m.x < x0 + pw && m.y < ph) {
      const t = horiz ? (m.x - x0) / pw : 1 - m.y / ph;
      const f = this.fMin * Math.pow(this.fMax / this.fMin, t);
      this.tip.innerHTML = `<div class="tip-head">${formatFreq(f)} <span class="dim">${noteName(f)}</span></div>`;
      this.tip.style.display = 'block';
      this.tip.style.left = `${Math.min(m.x + 14, w - 150)}px`;
      this.tip.style.top = `${m.y}px`;
      if (horiz) {
        ctx.fillStyle = CHART.cursor;
        ctx.fillRect(Math.round(m.x), y0, 1, ph);
      }
    }
  }
}
