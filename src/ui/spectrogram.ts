import { formatFreq, noteName } from '../dsp/freq';
import { CHART } from './theme';

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
  private readonly padL = 46;
  private readonly padB = 22;

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
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.mouse = null;
      this.tip.style.display = 'none';
    });
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Push one spectrum: power values on linear bins with bin spacing df. */
  push(power: ArrayLike<number>, df: number, offsetDb = 0): void {
    this.imgCtx.drawImage(this.img, -1, 0);
    const d = this.column.data;
    const range = this.dbMax - this.dbMin;
    const nb = power.length;
    for (let r = 0; r < this.rows; r++) {
      // Row 0 = top = fMax
      const t0 = 1 - (r + 1) / this.rows;
      const t1 = 1 - r / this.rows;
      const f0 = this.fMin * Math.pow(this.fMax / this.fMin, t0);
      const f1 = this.fMin * Math.pow(this.fMax / this.fMin, t1);
      let b0 = Math.floor(f0 / df);
      let b1 = Math.ceil(f1 / df);
      b0 = Math.max(1, Math.min(nb - 1, b0));
      b1 = Math.max(b0, Math.min(nb - 1, b1));
      let m = 0;
      for (let b = b0; b <= b1; b++) if (power[b] > m) m = power[b];
      const db = 10 * Math.log10(Math.max(m, 1e-30)) + offsetDb;
      const v = Math.max(0, Math.min(255, Math.round(((db - this.dbMin) / range) * 255)));
      d[r * 4] = LUT[v * 3];
      d[r * 4 + 1] = LUT[v * 3 + 1];
      d[r * 4 + 2] = LUT[v * 3 + 2];
      d[r * 4 + 3] = 255;
    }
    this.imgCtx.putImageData(this.column, this.cols - 1, 0);
  }

  clear(): void {
    this.imgCtx.fillStyle = '#000';
    this.imgCtx.fillRect(0, 0, this.cols, this.rows);
  }

  draw(): void {
    const ctx = this.ctx;
    const { w, h, padL, padB } = this;
    if (!w || !h) return;
    ctx.fillStyle = CHART.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.img, padL, 0, w - padL - 8, h - padB);
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillStyle = CHART.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f < this.fMin || f > this.fMax) continue;
      const y = (1 - Math.log(f / this.fMin) / Math.log(this.fMax / this.fMin)) * (h - padB);
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, padL - 6, Math.min(Math.max(y, 6), h - padB - 4));
      ctx.fillStyle = CHART.grid;
      ctx.fillRect(padL, y, w - padL - 8, 1);
      ctx.fillStyle = CHART.text;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('time →   (newest at right)', padL + (w - padL) / 2, h - padB + 5);
    // Colour bar legend
    const lg = ctx.createLinearGradient(0, 0, 120, 0);
    for (let i = 0; i <= 8; i++) {
      const v = Math.round((i / 8) * 255);
      lg.addColorStop(i / 8, `rgb(${LUT[v * 3]},${LUT[v * 3 + 1]},${LUT[v * 3 + 2]})`);
    }
    ctx.fillStyle = lg;
    ctx.fillRect(w - 138, h - padB + 6, 120, 8);
    ctx.fillStyle = CHART.text;
    ctx.textAlign = 'right';
    ctx.fillText(`${this.dbMin}`, w - 142, h - padB + 5);
    ctx.textAlign = 'left';
    ctx.fillText(`${this.dbMax} dB`, w - 14, h - padB + 5);
    if (this.mouse && this.mouse.x > padL && this.mouse.y < h - padB) {
      const t = 1 - this.mouse.y / (h - padB);
      const f = this.fMin * Math.pow(this.fMax / this.fMin, t);
      this.tip.innerHTML = `<div class="tip-head">${formatFreq(f)} <span class="dim">${noteName(f)}</span></div>`;
      this.tip.style.display = 'block';
      this.tip.style.left = `${Math.min(this.mouse.x + 14, w - 150)}px`;
      this.tip.style.top = `${this.mouse.y}px`;
    }
  }
}
