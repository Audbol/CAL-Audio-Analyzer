import { CHART } from './theme';
import { formatFreq, noteName } from '../dsp/freq';

export interface Series {
  id: string;
  label: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  width?: number;
  /** Per-point opacity (0..1), e.g. coherence blanking. */
  alpha?: ArrayLike<number>;
  dash?: number[];
  /** Fill area under the curve down to the bottom of the plot. */
  fill?: boolean;
  /** Treat as wrapped phase: break the line on ±180° jumps. */
  wrap?: number;
  /** Render as bars centred on each x (RTA bands). */
  bars?: number;
  /** Exclude from the hover readout. */
  quiet?: boolean;
  /** Secondary y axis (0..1 range drawn on the right), e.g. coherence. */
  secondary?: boolean;
  unit?: string;
}

export interface Marker {
  x: number;
  label?: string;
  color: string;
}

export interface PlotConfig {
  xType: 'log' | 'lin';
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  yUnit: string;
  xUnit?: string;
  yStep?: number;
  secondaryLabel?: string;
  title?: string;
  /** Allowed y range for zooming. */
  yLimits?: [number, number];
  formatX?: (x: number) => string;
  showNote?: boolean;
}

const COLORS = CHART;

/** Fast canvas line plot with log/linear x-axis, hover readout, y zoom/pan and markers. */
export class Plot {
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tip: HTMLDivElement;
  series: Series[] = [];
  markers: Marker[] = [];
  shades: { x0: number; x1: number; color: string }[] = [];
  cfg: PlotConfig;
  private readonly defaults: { yMin: number; yMax: number; xMin: number; xMax: number };
  private mouse: { x: number; y: number } | null = null;
  private drag: { y: number; yMin: number; yMax: number; x: number; xMin: number; xMax: number } | null = null;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private readonly pad = { l: 46, r: 14, t: 8, b: 22 };
  onRangeChange?: (yMin: number, yMax: number) => void;
  onClick?: (x: number) => void;

  constructor(cfg: PlotConfig) {
    this.cfg = { ...cfg };
    this.defaults = { yMin: cfg.yMin, yMax: cfg.yMax, xMin: cfg.xMin, xMax: cfg.xMax };
    if (cfg.secondaryLabel) this.pad.r = 40;
    this.el = document.createElement('div');
    this.el.className = 'plot';
    this.canvas = document.createElement('canvas');
    this.el.append(this.canvas);
    this.tip = document.createElement('div');
    this.tip.className = 'plot-tip';
    this.el.append(this.tip);
    if (cfg.title) {
      const t = document.createElement('div');
      t.className = 'plot-title';
      t.textContent = cfg.title;
      this.el.append(t);
    }
    const hint = document.createElement('div');
    hint.className = 'plot-hint';
    hint.textContent = 'Scroll: zoom · Drag: pan · Double-click: reset';
    this.el.append(hint);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindEvents();
  }

  private bindEvents(): void {
    const c = this.canvas;
    // Pointer events with capture (rather than window listeners) so plots keep working when their panel
    // is moved into a detached window
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.drag) {
        const plotH = this.hgt - this.pad.t - this.pad.b;
        const dy = ((this.mouse.y - this.drag.y) / plotH) * (this.drag.yMax - this.drag.yMin);
        this.setY(this.drag.yMin + dy, this.drag.yMax + dy);
        if (e.shiftKey) {
          const plotW = this.w - this.pad.l - this.pad.r;
          const frac = (this.mouse.x - this.drag.x) / plotW;
          if (this.cfg.xType === 'log') {
            const span = Math.log(this.drag.xMax / this.drag.xMin);
            const k = Math.exp(-frac * span);
            this.setX(this.drag.xMin * k, this.drag.xMax * k);
          } else {
            const span = this.drag.xMax - this.drag.xMin;
            this.setX(this.drag.xMin - frac * span, this.drag.xMax - frac * span);
          }
        }
      }
      this.draw();
    });
    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      this.drag = null;
      this.tip.style.display = 'none';
      this.draw();
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      this.drag = { y: e.clientY - r.top, yMin: this.cfg.yMin, yMax: this.cfg.yMax, x: e.clientX - r.left, xMin: this.cfg.xMin, xMax: this.cfg.xMax };
    });
    c.addEventListener('pointerup', (e) => {
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (this.drag && this.mouse && Math.abs(this.mouse.y - this.drag.y) < 3 && Math.abs(this.mouse.x - this.drag.x) < 3) {
        this.onClick?.(this.xFromPx(this.mouse.x));
      }
      this.drag = null;
    });
    c.addEventListener('dblclick', () => this.resetZoom());
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const k = Math.exp(Math.sign(e.deltaY) * 0.12);
        if (e.shiftKey || e.ctrlKey) {
          const x = this.xFromPx(e.clientX - r.left);
          if (this.cfg.xType === 'log') {
            const lo = x * Math.pow(this.cfg.xMin / x, k);
            const hi = x * Math.pow(this.cfg.xMax / x, k);
            this.setX(lo, hi);
          } else {
            this.setX(x + (this.cfg.xMin - x) * k, x + (this.cfg.xMax - x) * k);
          }
        } else {
          const y = this.yFromPx(e.clientY - r.top);
          this.setY(y + (this.cfg.yMin - y) * k, y + (this.cfg.yMax - y) * k);
        }
        this.draw();
      },
      { passive: false },
    );
  }

  resetZoom(): void {
    this.setY(this.defaults.yMin, this.defaults.yMax);
    this.setX(this.defaults.xMin, this.defaults.xMax);
    this.draw();
  }

  setDefaults(d: Partial<{ yMin: number; yMax: number; xMin: number; xMax: number }>): void {
    Object.assign(this.defaults, d);
    Object.assign(this.cfg, d);
  }

  setY(yMin: number, yMax: number): void {
    const [lo, hi] = this.cfg.yLimits ?? [-Infinity, Infinity];
    if (yMax - yMin < 1e-3) return;
    if (yMin < lo) {
      yMax += lo - yMin;
      yMin = lo;
    }
    if (yMax > hi) {
      yMin -= yMax - hi;
      yMax = hi;
    }
    this.cfg.yMin = Math.max(yMin, lo);
    this.cfg.yMax = yMax;
    this.onRangeChange?.(this.cfg.yMin, this.cfg.yMax);
  }

  setX(xMin: number, xMax: number): void {
    const lo = this.defaults.xMin;
    const hi = this.defaults.xMax;
    if (this.cfg.xType === 'log') {
      if (xMax / xMin < 1.5) return;
    } else if (xMax - xMin < (hi - lo) * 0.002) return;
    this.cfg.xMin = Math.max(xMin, lo);
    this.cfg.xMax = Math.min(xMax, hi);
  }

  /** Re-measure the plot (runs automatically; the panel dock also calls it when a panel changes window). */
  resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = this.el.ownerDocument.defaultView?.devicePixelRatio || window.devicePixelRatio || 1;
    this.w = Math.max(10, r.width);
    this.hgt = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.hgt * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.hgt}px`;
    this.draw();
  }

  xToPx(x: number): number {
    const { xMin, xMax, xType } = this.cfg;
    const plotW = this.w - this.pad.l - this.pad.r;
    const t = xType === 'log' ? Math.log(x / xMin) / Math.log(xMax / xMin) : (x - xMin) / (xMax - xMin);
    return this.pad.l + t * plotW;
  }

  xFromPx(px: number): number {
    const { xMin, xMax, xType } = this.cfg;
    const plotW = this.w - this.pad.l - this.pad.r;
    const t = (px - this.pad.l) / plotW;
    return xType === 'log' ? xMin * Math.pow(xMax / xMin, t) : xMin + t * (xMax - xMin);
  }

  yToPx(y: number, secondary = false): number {
    const plotH = this.hgt - this.pad.t - this.pad.b;
    const t = secondary ? y : (y - this.cfg.yMin) / (this.cfg.yMax - this.cfg.yMin);
    return this.pad.t + (1 - t) * plotH;
  }

  yFromPx(py: number): number {
    const plotH = this.hgt - this.pad.t - this.pad.b;
    const t = 1 - (py - this.pad.t) / plotH;
    return this.cfg.yMin + t * (this.cfg.yMax - this.cfg.yMin);
  }

  private fmtX(x: number): string {
    if (this.cfg.formatX) return this.cfg.formatX(x);
    if (this.cfg.xType === 'log') return formatFreq(x);
    return `${x.toFixed(Math.abs(this.cfg.xMax - this.cfg.xMin) < 10 ? 2 : 1)} ${this.cfg.xUnit ?? ''}`;
  }

  draw(): void {
    const ctx = this.ctx;
    const { w, hgt: H, pad } = this;
    if (!w || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, H);
    this.drawGrid();
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, w - pad.l - pad.r, H - pad.t - pad.b);
    ctx.clip();
    for (const s of this.shades) {
      ctx.fillStyle = s.color;
      const x0 = this.xToPx(s.x0);
      ctx.fillRect(x0, pad.t, this.xToPx(s.x1) - x0, H - pad.t - pad.b);
    }
    for (const s of this.series) this.drawSeries(s);
    for (const m of this.markers) {
      const x = this.xToPx(m.x);
      ctx.strokeStyle = m.color;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, H - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = m.color;
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.fillText(m.label, x + 3, H - pad.b - 5);
      }
    }
    ctx.restore();
    this.drawCursor();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const { w, hgt: H, pad } = this;
    const { xMin, xMax, yMin, yMax, xType } = this.cfg;
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.lineWidth = 1;
    // X grid
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (xType === 'log') {
      for (let dec = Math.pow(10, Math.floor(Math.log10(xMin))); dec <= xMax; dec *= 10) {
        for (let m = 1; m < 10; m++) {
          const f = dec * m;
          if (f < xMin || f > xMax) continue;
          const x = Math.round(this.xToPx(f)) + 0.5;
          ctx.strokeStyle = m === 1 ? COLORS.gridMajor : COLORS.grid;
          ctx.beginPath();
          ctx.moveTo(x, pad.t);
          ctx.lineTo(x, H - pad.b);
          ctx.stroke();
          const span = Math.log10(xMax / xMin);
          if (m === 1 || m === 2 || m === 5 || (span < 1.6 && m !== 7 && m !== 9)) {
            ctx.fillStyle = COLORS.text;
            ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, H - pad.b + 5);
          }
        }
      }
    } else {
      const step = niceStep((xMax - xMin) / Math.max(4, (w - pad.l - pad.r) / 90));
      for (let v = Math.ceil(xMin / step) * step; v <= xMax + 1e-9; v += step) {
        const x = Math.round(this.xToPx(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < 1e-9 ? COLORS.gridMajor : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, H - pad.b);
        ctx.stroke();
        ctx.fillStyle = COLORS.text;
        ctx.fillText(trimNum(v), x, H - pad.b + 5);
      }
    }
    // Y grid
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ystep = this.cfg.yStep && (yMax - yMin) / this.cfg.yStep < 16 ? this.cfg.yStep : niceStep((yMax - yMin) / Math.max(3, (H - pad.t - pad.b) / 34));
    for (let v = Math.ceil(yMin / ystep) * ystep; v <= yMax + 1e-9; v += ystep) {
      const y = Math.round(this.yToPx(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? COLORS.gridMajor : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(trimNum(v), pad.l - 6, y);
    }
    ctx.save();
    ctx.translate(10, pad.t + (H - pad.t - pad.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(this.cfg.yUnit, 0, 0);
    ctx.restore();
    if (this.cfg.secondaryLabel) {
      ctx.textAlign = 'left';
      for (const v of [0, 0.5, 1]) {
        ctx.fillText(`${v * 100}%`, w - pad.r + 5, this.yToPx(v, true));
      }
    }
  }

  private drawSeries(s: Series): void {
    const ctx = this.ctx;
    const n = Math.min(s.x.length, s.y.length);
    if (!n) return;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width ?? 1.5;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash ?? []);
    const xMin = this.cfg.xMin;
    const xMax = this.cfg.xMax;
    const bottom = this.hgt - this.pad.b;
    if (s.bars) {
      const half = Math.pow(2, 1 / (2 * s.bars));
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < n; i++) {
        const x = s.x[i];
        if (x < xMin / 2 || x > xMax * 2 || !Number.isFinite(s.y[i])) continue;
        const x0 = this.xToPx(x / half) + 1;
        const x1 = this.xToPx(x * half) - 1;
        const y = this.yToPx(s.y[i], s.secondary);
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), bottom - y);
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (s.alpha) {
      // Per-segment alpha (coherence blanking)
      for (let i = 1; i < n; i++) {
        const x0 = s.x[i - 1];
        const x1 = s.x[i];
        if (x1 < xMin || x0 > xMax) continue;
        const y0 = s.y[i - 1];
        const y1 = s.y[i];
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
        if (s.wrap && Math.abs(y1 - y0) > s.wrap) continue;
        const a = Math.min(s.alpha[i - 1], s.alpha[i]);
        if (a < 0.03) continue;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(this.xToPx(x0), this.yToPx(y0, s.secondary));
        ctx.lineTo(this.xToPx(x1), this.yToPx(y1, s.secondary));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      return;
    }
    ctx.beginPath();
    let pen = false;
    let firstX = 0;
    let lastX = 0;
    for (let i = 0; i < n; i++) {
      const x = s.x[i];
      const y = s.y[i];
      if (!Number.isFinite(y) || x <= 0 && this.cfg.xType === 'log') {
        pen = false;
        continue;
      }
      const px = this.xToPx(x);
      const py = this.yToPx(y, s.secondary);
      if (pen && s.wrap && Math.abs(y - s.y[i - 1]) > s.wrap) pen = false;
      if (!pen) {
        ctx.moveTo(px, py);
        if (!firstX) firstX = px;
        pen = true;
      } else ctx.lineTo(px, py);
      lastX = px;
    }
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(lastX, bottom);
      ctx.lineTo(firstX, bottom);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  private drawCursor(): void {
    const m = this.mouse;
    if (!m || m.x < this.pad.l || m.x > this.w - this.pad.r) {
      this.tip.style.display = 'none';
      return;
    }
    const ctx = this.ctx;
    ctx.strokeStyle = COLORS.cursor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(m.x) + 0.5, this.pad.t);
    ctx.lineTo(Math.round(m.x) + 0.5, this.hgt - this.pad.b);
    ctx.stroke();
    const x = this.xFromPx(m.x);
    const rows: string[] = [];
    let head = this.fmtX(x);
    if (this.cfg.showNote && this.cfg.xType === 'log') head += ` <span class="dim">${noteName(x)}</span>`;
    if (this.cfg.xType === 'log') head += ` <span class="dim">λ ${(343 / x).toFixed(x > 343 ? 3 : 2)} m</span>`;
    rows.push(`<div class="tip-head">${head}</div>`);
    for (const s of this.series) {
      if (s.quiet) continue;
      const v = sampleAt(s.x, s.y, x);
      if (v === null) continue;
      const unit = s.unit ?? this.cfg.yUnit;
      const val = s.secondary ? `${(v * 100).toFixed(0)}%` : `${v.toFixed(1)} ${unit}`;
      rows.push(`<div><i style="background:${s.color}"></i>${escapeHtml(s.label)} <b>${val}</b></div>`);
    }
    if (rows.length === 1) rows.push(`<div class="dim">${this.yFromPx(m.y).toFixed(1)} ${this.cfg.yUnit}</div>`);
    this.tip.innerHTML = rows.join('');
    this.tip.style.display = 'block';
    const tipW = this.tip.offsetWidth;
    const left = m.x + 14 + tipW > this.w ? m.x - 14 - tipW : m.x + 14;
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${Math.min(Math.max(m.y - 20, 4), this.hgt - this.tip.offsetHeight - 4)}px`;
  }
}

function sampleAt(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 1 || x < xs[0] || x > xs[n - 1]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const a = ys[lo];
  const b = ys[hi];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : Number.isFinite(b) ? b : null;
  const t = xs[hi] === xs[lo] ? 0 : (x - xs[lo]) / (xs[hi] - xs[lo]);
  return a + (b - a) * t;
}

export function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}

function trimNum(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
