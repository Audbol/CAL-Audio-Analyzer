import { CHART } from './theme';
import { formatFreq } from '../dsp/freq';
import type { WaterfallResult } from '../dsp/waterfall';

/**
 * 3-D waterfall (cumulative spectral decay) drawn in oblique projection: frequency across, level up, time
 * going back and to the right. Slices are drawn back to front and filled, so later slices hide behind earlier ones.
 */
export class WaterfallPlot {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  forceDpr: number | null = null;
  data: WaterfallResult | null = null;
  /** Dynamic range shown below the peak (dB). */
  range = 45;
  emptyText = 'Run a sweep to see the decay';

  constructor(title?: string) {
    this.el = document.createElement('div');
    this.el.className = 'plot waterfall';
    this.canvas = document.createElement('canvas');
    this.el.append(this.canvas);
    if (title) {
      const t = document.createElement('div');
      t.className = 'plot-title';
      t.textContent = title;
      this.el.append(t);
    }
    this.ctx = this.canvas.getContext('2d')!;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.el);
  }

  dispose(): void {
    this.observer.disconnect();
  }

  resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = this.forceDpr ?? Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(10, r.width);
    this.hgt = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.hgt * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.hgt}px`;
    this.draw();
  }

  draw(): void {
    const { ctx, w, hgt: H } = this;
    if (!w || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = CHART.bg;
    ctx.fillRect(0, 0, w, H);
    const d = this.data;
    ctx.font = '11px Inter, system-ui, sans-serif';
    if (!d || !d.slices.length) {
      ctx.fillStyle = CHART.text;
      ctx.textAlign = 'center';
      ctx.fillText(this.emptyText, w / 2, H / 2);
      return;
    }
    const narrow = w < 520;
    // Depth of the time axis (oblique projection)
    const depthX = Math.min(w * 0.22, 220);
    const depthY = Math.min(H * 0.34, 170);
    const pad = { l: narrow ? 36 : 46, r: 58 + depthX, t: 24 + depthY, b: 24 };
    const plotW = w - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    if (plotW < 40 || plotH < 30) return;
    const f0 = d.freqs[0];
    const f1 = d.freqs[d.freqs.length - 1];
    const top = 3;
    const floor = -this.range;
    const X = (f: number) => pad.l + (Math.log(f / f0) / Math.log(f1 / f0)) * plotW;
    const Y = (db: number) => pad.t + ((top - Math.max(floor, Math.min(top, db))) / (top - floor)) * plotH;
    const n = d.slices.length;
    const off = (k: number) => ({ x: (k / Math.max(1, n - 1)) * depthX, y: -(k / Math.max(1, n - 1)) * depthY });

    // Grid: dB lines on the back wall and frequency lines on the floor
    ctx.lineWidth = 1;
    const back = off(n - 1);
    const dbStep = this.range > 30 ? 10 : 6;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = 0; db >= floor; db -= dbStep) {
      const y = Y(db);
      ctx.strokeStyle = db === 0 ? CHART.gridMajor : CHART.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + back.x, y + back.y);
      ctx.lineTo(pad.l + plotW + back.x, y + back.y);
      ctx.stroke();
      ctx.fillStyle = CHART.text;
      ctx.fillText(`${db}`, pad.l - 6, y);
    }
    const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f >= f0 && f <= f1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of ticks) {
      const x = X(f);
      ctx.strokeStyle = CHART.grid;
      ctx.beginPath();
      ctx.moveTo(x, Y(floor));
      ctx.lineTo(x + back.x, Y(floor) + back.y);
      ctx.stroke();
      ctx.fillStyle = CHART.text;
      ctx.fillText(formatFreq(f), x, H - pad.b + 6);
    }

    // Slices, back to front: filled with the background so nearer slices hide farther ones
    const day = CHART.bg === '#ffffff';
    for (let k = n - 1; k >= 0; k--) {
      const o = off(k);
      const s = d.slices[k];
      const frac = k / Math.max(1, n - 1); // 0 front … 1 back
      ctx.beginPath();
      ctx.moveTo(X(d.freqs[0]) + o.x, Y(floor) + o.y);
      for (let i = 0; i < d.freqs.length; i++) ctx.lineTo(X(d.freqs[i]) + o.x, Y(s[i]) + o.y);
      ctx.lineTo(X(f1) + o.x, Y(floor) + o.y);
      ctx.closePath();
      // Colour runs from warm (early) to cool (late)
      const hue = 18 + frac * 190;
      ctx.fillStyle = day ? `hsla(${hue}, 85%, 92%, 0.96)` : `hsla(${hue}, 70%, 9%, 0.96)`;
      ctx.fill();
      ctx.strokeStyle = day ? `hsl(${hue}, 80%, ${32 + frac * 12}%)` : `hsl(${hue}, 90%, ${62 - frac * 14}%)`;
      ctx.lineWidth = k === 0 ? 2 : 1;
      ctx.stroke();
    }

    // Time axis along the right-hand floor edge
    ctx.strokeStyle = CHART.gridMajor;
    ctx.beginPath();
    ctx.moveTo(pad.l + plotW, Y(floor));
    ctx.lineTo(pad.l + plotW + back.x, Y(floor) + back.y);
    ctx.stroke();
    ctx.fillStyle = CHART.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tMax = d.times[n - 1];
    const tStep = niceStep(tMax / 4);
    for (let t = 0; t <= tMax + 1e-9; t += tStep) {
      const o = off((t / tMax) * (n - 1));
      ctx.fillText(`${+t.toFixed(1)} ms`, pad.l + plotW + o.x + 6, Y(floor) + o.y + 2);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('dB', 4, pad.t - 16);
  }
}

function niceStep(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
