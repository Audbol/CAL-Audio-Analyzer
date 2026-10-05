import { CHART } from './theme';
import { formatFreq } from '../dsp/freq';
import { drawWatermark, onWatermarkChange } from './watermark';
import type { WaterfallResult } from '../dsp/waterfall';

/** Camera: turn around the vertical axis (yaw) and tilt (pitch), degrees; zoom 1 = fit. */
export interface WaterfallView {
  yaw: number;
  pitch: number;
  zoom: number;
}

export const DEFAULT_WATERFALL_VIEW: WaterfallView = { yaw: 32, pitch: 24, zoom: 1 };

/** Box proportions (world units): frequency across (−1…1), time going back, level up. */
const DEPTH = 1.35;
const HEIGHT = 0.85;

interface P2 {
  x: number;
  y: number;
}

/**
 * 3-D waterfall (cumulative spectral decay): frequency across, level up, time going back. Drag to turn it
 * (or the arrow keys), the wheel zooms, a double-click (or Home) goes back to the standard view. Slices are drawn
 * far to near and filled, so nearer slices hide the ones behind them from any angle.
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
  view: WaterfallView = { ...DEFAULT_WATERFALL_VIEW };
  /** Called after the user turned or zoomed the view (to remember it). */
  onViewChange: ((v: WaterfallView) => void) | null = null;
  private interactive = false;
  private unwatch: () => void;

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
    this.unwatch = onWatermarkChange(() => this.draw());
  }

  dispose(): void {
    this.observer.disconnect();
    this.unwatch();
  }

  /** Turn with the mouse, touch, keys and wheel (the Room tab; the report's copy stays still). */
  enableRotation(): void {
    if (this.interactive) return;
    this.interactive = true;
    const c = this.canvas;
    c.tabIndex = 0;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Waterfall in 3-D: drag or use the arrow keys to turn it, Home for the standard view');
    c.style.touchAction = 'none';
    c.style.cursor = 'grab';
    let drag: { id: number; x: number; y: number; yaw: number; pitch: number } | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.view.yaw, pitch: this.view.pitch };
      c.setPointerCapture(e.pointerId);
      c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.setView({ yaw: drag.yaw + (e.clientX - drag.x) * 0.45, pitch: drag.pitch + (e.clientY - drag.y) * 0.35 });
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      c.style.cursor = 'grab';
      this.onViewChange?.({ ...this.view });
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', () => this.resetView());
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.setView({ zoom: this.view.zoom * Math.exp(-e.deltaY * 0.0015) });
        this.onViewChange?.({ ...this.view });
      },
      { passive: false },
    );
    c.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 15 : 5;
      const v = this.view;
      if (e.key === 'ArrowLeft') this.setView({ yaw: v.yaw - step });
      else if (e.key === 'ArrowRight') this.setView({ yaw: v.yaw + step });
      else if (e.key === 'ArrowUp') this.setView({ pitch: v.pitch + step });
      else if (e.key === 'ArrowDown') this.setView({ pitch: v.pitch - step });
      else if (e.key === '+' || e.key === '=') this.setView({ zoom: v.zoom * 1.15 });
      else if (e.key === '-') this.setView({ zoom: v.zoom / 1.15 });
      else if (e.key === 'Home') return this.resetView();
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.onViewChange?.({ ...this.view });
    });
    this.draw();
  }

  /** Change the camera (limited: from level to nearly straight down, zoom 0.5–3). */
  setView(v: Partial<WaterfallView>): void {
    const n = { ...this.view, ...v };
    n.yaw = ((((n.yaw + 180) % 360) + 360) % 360) - 180;
    n.pitch = Math.max(0, Math.min(85, n.pitch));
    n.zoom = Math.max(0.5, Math.min(3, n.zoom));
    this.view = n;
    this.draw();
  }

  resetView(): void {
    this.setView({ ...DEFAULT_WATERFALL_VIEW });
    this.onViewChange?.({ ...this.view });
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
    drawWatermark(ctx, 0, 0, w, H);
    const d = this.data;
    ctx.font = "11px 'Inter Variable', Inter, system-ui, sans-serif";
    if (!d || !d.slices.length) {
      ctx.fillStyle = CHART.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyText, w / 2, H / 2);
      return;
    }
    const narrow = w < 520;
    const pad = { l: narrow ? 40 : 52, r: narrow ? 48 : 64, t: 30, b: 30 };
    const n = d.slices.length;
    const f0 = d.freqs[0];
    const f1 = d.freqs[d.freqs.length - 1];
    const top = 3;
    const floor = -this.range;
    // World coordinates: x frequency (−1…1), y level (0…HEIGHT), z time (front −DEPTH/2 … back +DEPTH/2)
    const wx = (f: number) => -1 + (2 * Math.log(f / f0)) / Math.log(f1 / f0);
    const wy = (db: number) => ((Math.max(floor, Math.min(top, db)) - floor) / (top - floor)) * HEIGHT;
    const wz = (k: number) => -DEPTH / 2 + (k / Math.max(1, n - 1)) * DEPTH;
    const yaw = (this.view.yaw * Math.PI) / 180;
    const pitch = (this.view.pitch * Math.PI) / 180;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    // Orthographic camera: x across the screen, up on the screen, depth away from the viewer
    const rot = (x: number, y: number, z: number) => {
      const xr = x * cy + z * sy;
      const zr = -x * sy + z * cy;
      return { x: xr, up: (y - HEIGHT / 2) * cp + zr * sp, depth: zr * cp - (y - HEIGHT / 2) * sp };
    };
    // Fit the box (all eight corners) into the plot area for this angle, then zoom around the centre
    const corners: { x: number; up: number }[] = [];
    for (const x of [-1, 1]) for (const y of [0, HEIGHT]) for (const z of [-DEPTH / 2, DEPTH / 2]) corners.push(rot(x, y, z));
    const minX = Math.min(...corners.map((c) => c.x));
    const maxX = Math.max(...corners.map((c) => c.x));
    const minU = Math.min(...corners.map((c) => c.up));
    const maxU = Math.max(...corners.map((c) => c.up));
    const availW = w - pad.l - pad.r;
    const availH = H - pad.t - pad.b;
    if (availW < 40 || availH < 30) return;
    const scale = Math.min(availW / Math.max(1e-6, maxX - minX), availH / Math.max(1e-6, maxU - minU)) * this.view.zoom;
    const ox = pad.l + availW / 2 - ((minX + maxX) / 2) * scale;
    const oy = pad.t + availH / 2 + ((minU + maxU) / 2) * scale;
    const P = (x: number, y: number, z: number): P2 => {
      const r = rot(x, y, z);
      return { x: ox + r.x * scale, y: oy - r.up * scale };
    };
    const depthOf = (x: number, y: number, z: number) => rot(x, y, z).depth;
    const line = (a: P2, b: P2) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    const zFront = -DEPTH / 2;
    const zBack = DEPTH / 2;
    // The walls farthest from the viewer carry the grid: the far time end and the far frequency side
    const farZ = depthOf(0, 0, zBack) >= depthOf(0, 0, zFront) ? zBack : zFront;
    const nearZ = farZ === zBack ? zFront : zBack;
    const farX = depthOf(1, 0, 0) >= depthOf(-1, 0, 0) ? 1 : -1;
    const nearX = -farX;

    ctx.lineWidth = 1;
    // Floor: frequency lines from front to back
    const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f >= f0 && f <= f1);
    ctx.strokeStyle = CHART.grid;
    for (const f of ticks) line(P(wx(f), 0, zFront), P(wx(f), 0, zBack));
    // Floor: time lines across
    const tMax = d.times[n - 1];
    const tStep = niceStep(tMax / 4);
    const tz = (t: number) => (tMax > 0 ? -DEPTH / 2 + (t / tMax) * DEPTH : zFront);
    if (tMax > 0 && n > 1) for (let t = 0; t <= tMax + 1e-9; t += tStep) line(P(-1, 0, tz(t)), P(1, 0, tz(t)));
    // Far walls: level lines
    const dbStep = this.range > 30 ? 10 : 6;
    for (let db = 0; db >= floor; db -= dbStep) {
      ctx.strokeStyle = db === 0 ? CHART.gridMajor : CHART.grid;
      const y = wy(db);
      ctx.beginPath();
      const a = P(-1, y, farZ);
      const b = P(1, y, farZ);
      const c = P(farX, y, nearZ);
      // Along the far end wall, then down the far side wall
      const [s, e] = farX === 1 ? [a, b] : [b, a];
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    // Box edges on the floor and the far vertical edge
    ctx.strokeStyle = CHART.gridMajor;
    line(P(-1, 0, zFront), P(1, 0, zFront));
    line(P(-1, 0, zBack), P(1, 0, zBack));
    line(P(-1, 0, zFront), P(-1, 0, zBack));
    line(P(1, 0, zFront), P(1, 0, zBack));
    line(P(farX, 0, farZ), P(farX, HEIGHT, farZ));

    // Slices far to near: filled with the background so nearer slices hide farther ones
    const day = CHART.bg === '#ffffff';
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => depthOf(0, HEIGHT / 2, wz(b)) - depthOf(0, HEIGHT / 2, wz(a)));
    const xs = Array.from(d.freqs, (f) => wx(f));
    for (const k of order) {
      const z = wz(k);
      const s = d.slices[k];
      const frac = k / Math.max(1, n - 1); // 0 first … 1 last
      ctx.beginPath();
      let p = P(-1, 0, z);
      ctx.moveTo(p.x, p.y);
      for (let i = 0; i < xs.length; i++) {
        p = P(xs[i], wy(s[i]), z);
        ctx.lineTo(p.x, p.y);
      }
      p = P(1, 0, z);
      ctx.lineTo(p.x, p.y);
      ctx.closePath();
      // Colour runs from warm (early) to cool (late)
      const hue = 18 + frac * 190;
      ctx.fillStyle = day ? `hsla(${hue}, 85%, 92%, 0.96)` : `hsla(${hue}, 70%, 9%, 0.96)`;
      ctx.fill();
      ctx.strokeStyle = day ? `hsl(${hue}, 80%, ${32 + frac * 12}%)` : `hsl(${hue}, 90%, ${62 - frac * 14}%)`;
      ctx.lineWidth = k === 0 ? 2 : 1;
      ctx.stroke();
    }

    // Labels: frequencies along the near floor edge, times along the near side, levels up the far corner
    ctx.fillStyle = CHART.text;
    ctx.lineWidth = 1;
    const centre = P(0, 0, 0);
    const away = (p: P2, from: P2, dist: number): P2 => {
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const l = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / l) * dist, y: p.y + (dy / l) * dist };
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Frequency labels: skip ones that would overlap when the axis is seen end-on
    let lastF: P2 | null = null;
    const nearZMid = P(0, 0, nearZ);
    for (const f of ticks) {
      const base = P(wx(f), 0, nearZ);
      const q = away(base, { x: base.x - (nearZMid.x - centre.x), y: base.y - (nearZMid.y - centre.y) }, 14);
      if (lastF && Math.hypot(q.x - lastF.x, q.y - lastF.y) < 30) continue;
      ctx.fillText(formatFreq(f), q.x, q.y);
      lastF = q;
    }
    if (tMax > 0 && n > 1) {
      let lastT: P2 | null = null;
      const sideMid = P(nearX, 0, 0);
      for (let t = 0; t <= tMax + 1e-9; t += tStep) {
        const base = P(nearX, 0, tz(t));
        const q = away(base, { x: base.x - (sideMid.x - centre.x), y: base.y - (sideMid.y - centre.y) }, 22);
        if (lastT && Math.hypot(q.x - lastT.x, q.y - lastT.y) < 30) continue;
        ctx.fillText(`${+t.toFixed(1)} ms`, q.x, q.y);
        lastT = q;
      }
    }
    // Level labels on the vertical edge of the far corner that sits farther left or right on the screen
    const cornerA = P(farX, 0, nearZ);
    const cornerB = P(-farX, 0, farZ);
    const edge = Math.abs(cornerA.x - centre.x) > Math.abs(cornerB.x - centre.x) ? { x: farX, z: nearZ } : { x: -farX, z: farZ };
    const edgeBase = P(edge.x, 0, edge.z);
    const left = edgeBase.x < centre.x;
    ctx.textAlign = left ? 'right' : 'left';
    // Seen from high above the level axis is short: labels only where they fit
    const topP = P(edge.x, HEIGHT, edge.z);
    if (Math.abs(topP.y - edgeBase.y) > 60) {
      ctx.strokeStyle = CHART.gridMajor;
      line(edgeBase, P(edge.x, wy(0), edge.z));
      let lastY = Infinity;
      for (let db = 0; db >= floor; db -= dbStep) {
        const p = P(edge.x, wy(db), edge.z);
        if (Math.abs(p.y - lastY) < 13) continue;
        ctx.fillText(`${db}`, p.x + (left ? -6 : 6), p.y);
        lastY = p.y;
      }
      ctx.fillText('dB', topP.x + (left ? -6 : 6), topP.y - 14);
    }
    if (this.interactive) {
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.globalAlpha = 0.7;
      ctx.fillText(narrow ? 'Drag to turn' : 'Drag to turn · wheel to zoom · double-click for the standard view', w - 10, 8);
      ctx.globalAlpha = 1;
    }
  }
}

function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
