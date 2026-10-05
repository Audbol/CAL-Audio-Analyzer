import { CHART, seriesColor } from './theme';
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
  /** Colour of the fill (line fill or bar bodies); the series colour when not set. */
  fillColor?: string;
  /** Opacity of the fill (0..1); the theme's default when not set. */
  fillAlpha?: number;
  /** Treat as wrapped phase: break the line on ±180° jumps. */
  wrap?: number;
  /** Render as bars centred on each x (RTA bands): the bar width in 1/N octave. */
  bars?: number;
  /** With `bars`: draw only a marker line at each bar's level (e.g. peak hold). */
  cap?: boolean;
  /** Outline colour drawn under the line (keeps it readable on top of other curves). */
  halo?: string;
  /** Draw a shaded band between `y` (upper edge) and these values (lower edge) instead of a line. */
  band?: ArrayLike<number>;
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
  /** Label at the top of the plot (default: at the bottom). */
  top?: boolean;
}

/** A user's note at a frequency: a flag at the top of the plot with a line down to the axis. */
export interface PlotNote {
  x: number;
  label: string;
  color: string;
}

/** A labelled point (e.g. a highlighted peak): a ring at (x, y) with a label above it. */
export interface Pin {
  x: number;
  y: number;
  label: string;
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
  /** Part of the plot height the secondary axis (0–100 %) uses, from the bottom: [0.6, 1] = the top 40 %. */
  secondaryBand?: [number, number];
  title?: string;
  /** Allowed y range for zooming. */
  yLimits?: [number, number];
  formatX?: (x: number) => string;
  showNote?: boolean;
  /** Fit the y axis to the data once when it first appears entirely outside the visible range. */
  autoFit?: boolean;
}

const COLORS = CHART;

/** Fast canvas line plot with log/linear x-axis, hover readout, y zoom/pan and markers. */
export class Plot {
  /** Upper limit for the canvas pixel ratio (lowered by the app on slow devices). */
  static maxDpr = 2;
  private static instances = new Set<Plot>();

  /** Change the pixel-ratio limit of every plot (adaptive quality on slow devices). */
  /** Redraw every plot on its next `drawIf` (e.g. after a colour-scheme change). */
  static invalidateAll(): void {
    for (const p of Plot.instances) p.lastKey = null;
  }

  private lastKey: string | null = null;

  /**
   * Draw only when `key` (a summary of what is shown: data versions, settings) changed since the last draw,
   * or something else required a redraw. Resizing, zooming and the hover readout redraw directly.
   */
  drawIf(key: string): void {
    if (key === this.lastKey) return;
    this.draw();
    this.lastKey = key;
  }

  static setMaxDpr(v: number): void {
    if (v === Plot.maxDpr) return;
    Plot.maxDpr = v;
    for (const p of Plot.instances) {
      p.resize();
      p.draw();
    }
  }
  readonly el: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tip: HTMLDivElement;
  series: Series[] = [];
  markers: Marker[] = [];
  pins: Pin[] = [];
  notes: PlotNote[] = [];
  /** Shown in the middle of an empty plot (no series), e.g. what to do to get data. */
  placeholder = '';
  /** Where each note's flag was drawn (CSS px), for clicks. */
  private noteBoxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  /** A click (or tap) on a note's flag. */
  onNoteClick?: (index: number) => void;
  private tap: { x: number; y: number } | null = null;
  shades: { x0: number; x1: number; color: string }[] = [];
  cfg: PlotConfig;
  private readonly defaults: { yMin: number; yMax: number; xMin: number; xMax: number };
  private mouse: { x: number; y: number } | null = null;
  private drag: { y: number; yMin: number; yMax: number; x: number; xMin: number; xMax: number } | null = null;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private readonly pad = { l: 46, r: 14, t: 8, b: 22 };
  /** Fixed pixel ratio (off-screen rendering for reports); null = the screen's. */
  forceDpr: number | null = null;
  private readonly observer: ResizeObserver;
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
    this.el.append(this.zoomBar());
    this.ctx = this.canvas.getContext('2d')!;
    Plot.instances.add(this);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.el);
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
    c.addEventListener('pointerleave', (e) => {
      this.drag = null;
      // On touch screens the finger lifting ends the gesture: keep the tapped readout visible
      if (e.pointerType === 'touch') return;
      this.mouse = null;
      this.drag = null;
      this.tip.style.display = 'none';
      this.draw();
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') {
        // Touch: tap / slide sideways to read values; vertical swipes scroll the page (no axis panning)
        const r = c.getBoundingClientRect();
        this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.tap = { ...this.mouse };
        this.draw();
        return;
      }
      c.setPointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      this.drag = { y: e.clientY - r.top, yMin: this.cfg.yMin, yMax: this.cfg.yMax, x: e.clientX - r.left, xMin: this.cfg.xMin, xMax: this.cfg.xMax };
    });
    c.addEventListener('pointerup', (e) => {
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      const r = c.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const start = e.pointerType === 'touch' ? this.tap : this.drag;
      if (start && Math.abs(at.y - start.y) < (e.pointerType === 'touch' ? 8 : 3) && Math.abs(at.x - start.x) < (e.pointerType === 'touch' ? 8 : 3)) this.click(at.x, at.y);
      this.drag = null;
      this.tap = null;
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

  /** Zoom / pan / fit buttons: the only way to change the scale on touch screens, handy with a mouse too. */
  private zoomBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'plot-zoom';
    const btn = (label: string, title: string, act: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.dataset.act = act;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('dblclick', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        run();
        this.draw();
      });
      bar.append(b);
    };
    btn('▲', 'Move up', 'up', () => this.panY(0.2));
    btn('▼', 'Move down', 'down', () => this.panY(-0.2));
    btn('−', 'Zoom out', 'out', () => this.zoomY(1.4));
    btn('+', 'Zoom in', 'in', () => this.zoomY(1 / 1.4));
    btn('Fit', 'Fit the scale to the data', 'fit', () => this.fitY());
    return bar;
  }

  /** Scale the y range around its centre (k > 1 zooms out). */
  /** A click: on a note's flag, else at a frequency. */
  private click(px: number, py: number): void {
    const i = this.noteBoxes.findIndex((b) => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1);
    if (i >= 0 && this.onNoteClick) return this.onNoteClick(i);
    this.onClick?.(this.xFromPx(px));
  }

  /** Note flags at the top of the plot, in rows so they don't overlap. */
  private drawNotes(): void {
    const ctx = this.ctx;
    const { w, hgt: H, pad } = this;
    this.noteBoxes = [];
    if (!this.notes.length) return;
    ctx.font = "600 11px 'Inter Variable', Inter, system-ui, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const rows: number[] = [];
    const rowH = 18;
    for (const n of this.notes) {
      const x = this.xToPx(n.x);
      const tw = Math.min(220, ctx.measureText(n.label).width) + 12;
      // Flag to the right of its line, flipped left near the right edge
      const left = x + tw > w - pad.r ? x - tw : x;
      let row = rows.findIndex((end) => end < left - 4);
      if (row < 0) row = rows.length;
      rows[row] = left + tw;
      const y0 = pad.t + 4 + row * (rowH + 3);
      const c = seriesColor(n.color);
      ctx.strokeStyle = c;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, H - pad.b);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.roundRect(left, y0, tw, rowH, 4);
      ctx.fill();
      // Dark text on a light flag, white on a dark one
      const rgb = /^#([0-9a-f]{6})$/i.test(c) ? [0, 2, 4].map((k) => parseInt(c.slice(1 + k, 3 + k), 16)) : [255, 255, 255];
      ctx.fillStyle = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140 ? '#0b0d12' : '#ffffff';
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, y0, tw - 4, rowH);
      ctx.clip();
      ctx.fillText(n.label, left + 6, y0 + rowH / 2 + 0.5);
      ctx.restore();
      this.noteBoxes.push({ x0: left, x1: left + tw, y0, y1: y0 + rowH });
    }
  }

  zoomY(k: number): void {
    const c = (this.cfg.yMin + this.cfg.yMax) / 2;
    const half = ((this.cfg.yMax - this.cfg.yMin) / 2) * k;
    const [lo, hi] = this.cfg.yLimits ?? [-Infinity, Infinity];
    if (half * 2 > hi - lo) return this.setY(lo, hi);
    this.setY(c - half, c + half);
  }

  /** Move the view by a fraction of its height (positive shows higher values). */
  panY(frac: number): void {
    const d = (this.cfg.yMax - this.cfg.yMin) * frac;
    this.setY(this.cfg.yMin + d, this.cfg.yMax + d);
  }

  /** Values of the visible primary-axis series inside the x range (for fitting the scale). */
  private visibleValues(): number[] {
    const vals: number[] = [];
    for (const s of this.series) {
      if (s.secondary) continue;
      const n = Math.min(s.x.length, s.y.length);
      const step = Math.max(1, Math.floor(n / 600));
      for (let i = 0; i < n; i += step) {
        const x = s.x[i];
        const y = s.y[i];
        if (x >= this.cfg.xMin && x <= this.cfg.xMax && Number.isFinite(y) && y > -190) vals.push(y);
      }
    }
    return vals;
  }

  /** Fit the y axis to the data currently shown (ignoring outliers). Returns false when there is no data. */
  fitY(): boolean {
    const vals = this.visibleValues().sort((a, b) => a - b);
    if (vals.length < 4) return false;
    const pick = (q: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(q * (vals.length - 1))))];
    let lo = pick(0.02);
    let hi = pick(1);
    const step = this.cfg.yStep ?? 10;
    const span = Math.max(hi - lo, step * 2);
    lo = Math.floor((lo - span * 0.15) / step) * step;
    hi = Math.ceil((hi + span * 0.1) / step) * step;
    this.setY(lo, hi);
    return true;
  }

  private autoFitted = false;

  private maybeAutoFit(): void {
    if (!this.cfg.autoFit || this.autoFitted) return;
    const vals = this.visibleValues();
    if (vals.length < 20) return;
    const outside = vals.filter((v) => v > this.cfg.yMax || v < this.cfg.yMin).length;
    this.autoFitted = true;
    if (outside / vals.length > 0.9) this.fitY();
  }

  /** Shift the y range and its reset defaults, e.g. when a calibration offset changes the units. */
  shiftY(d: number): void {
    this.defaults.yMin += d;
    this.defaults.yMax += d;
    this.cfg.yMin += d;
    this.cfg.yMax += d;
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

  /** Stop tracking a plot that is no longer used (temporary plots). */
  dispose(): void {
    this.observer.disconnect();
    Plot.instances.delete(this);
  }

  /** Re-measure the plot (runs automatically; the panel dock also calls it when a panel changes window). */
  resize(): void {
    const r = this.el.getBoundingClientRect();
    // Beyond 2× the extra pixels are invisible on a graph but cost a lot of drawing time on phones
    this.dpr = this.forceDpr ?? Math.min(Plot.maxDpr, this.el.ownerDocument.defaultView?.devicePixelRatio || window.devicePixelRatio || 1);
    this.w = Math.max(10, r.width);
    // Narrow plots (phones) get a tighter left margin
    this.pad.l = this.w < 520 ? 36 : 46;
    if (this.cfg.secondaryLabel) this.pad.r = this.w < 520 ? 32 : 40;
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
    const band = this.cfg.secondaryBand;
    const t = secondary ? (band ? band[0] + y * (band[1] - band[0]) : y) : (y - this.cfg.yMin) / (this.cfg.yMax - this.cfg.yMin);
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
    this.lastKey = null;
    if (!w || !H) return;
    this.maybeAutoFit();
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
    this.drawPins();
    this.drawNotes();
    for (const m of this.markers) {
      const x = this.xToPx(m.x);
      ctx.strokeStyle = seriesColor(m.color);
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, H - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.label) {
        ctx.fillStyle = seriesColor(m.color);
        ctx.font = "10px 'Inter Variable', Inter, system-ui, sans-serif";
        ctx.fillText(m.label, x + 3, m.top ? pad.t + 24 : H - pad.b - 5);
      }
    }
    ctx.restore();
    if (this.placeholder && !this.series.some((s) => !s.quiet && s.x.length)) {
      ctx.font = "500 13px 'Inter Variable', Inter, system-ui, sans-serif";
      ctx.fillStyle = COLORS.text;
      ctx.globalAlpha = 0.8;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.placeholder, pad.l + (w - pad.l - pad.r) / 2, pad.t + (H - pad.t - pad.b) / 2);
      ctx.globalAlpha = 1;
    }
    this.drawCursor();
  }

  /** Labelled points on top of the curves; labels stay inside the plot and are kept apart. */
  private drawPins(): void {
    const ctx = this.ctx;
    const { w, pad } = this;
    ctx.font = "600 11px 'Inter Variable', Inter, system-ui, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const placed: { x0: number; x1: number; y: number }[] = [];
    for (const p of this.pins) {
      if (!Number.isFinite(p.y) || p.x < this.cfg.xMin || p.x > this.cfg.xMax) continue;
      const x = this.xToPx(p.x);
      const y = this.yToPx(p.y);
      const color = seriesColor(p.color);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.bg;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      // Label box above the point (below it when there is no room), clear of other labels
      const tw = ctx.measureText(p.label).width + 10;
      const lx = Math.max(pad.l + 2, Math.min(w - pad.r - tw - 2, x - tw / 2));
      let ly = y - 20 < pad.t + 10 ? y + 20 : y - 20;
      for (const o of placed) if (lx < o.x1 && lx + tw > o.x0 && Math.abs(ly - o.y) < 18) ly = o.y - 20 < pad.t + 10 ? o.y + 20 : o.y - 20;
      placed.push({ x0: lx, x1: lx + tw, y: ly });
      ctx.fillStyle = COLORS.bg;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(lx, ly - 9, tw, 18);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(lx + 0.5, ly - 8.5, tw - 1, 17);
      ctx.fillStyle = COLORS.fg;
      ctx.fillText(p.label, lx + 5, ly + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const { w, hgt: H, pad } = this;
    const { xMin, xMax, yMin, yMax, xType } = this.cfg;
    ctx.font = "10px 'Inter Variable', Inter, system-ui, sans-serif";
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
        ctx.fillText(this.cfg.formatX ? this.cfg.formatX(v) : trimNum(v), x, H - pad.b + 5);
      }
      // The unit in the free corner under the y axis labels
      if (this.cfg.xUnit && !this.cfg.formatX) {
        ctx.textAlign = 'right';
        ctx.fillText(this.cfg.xUnit, pad.l - 6, H - pad.b + 5);
        ctx.textAlign = 'center';
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
      // A band of its own: a faint line where it starts
      if (this.cfg.secondaryBand && this.cfg.secondaryBand[0] > 0) {
        const y = Math.round(this.yToPx(0, true)) + 0.5;
        ctx.strokeStyle = COLORS.grid;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(w - pad.r, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  private drawSeries(s: Series): void {
    const ctx = this.ctx;
    const n = Math.min(s.x.length, s.y.length);
    if (!n) return;
    const color = seriesColor(s.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = (s.width ?? 1.5) * COLORS.lineScale;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash ?? []);
    const xMin = this.cfg.xMin;
    const xMax = this.cfg.xMax;
    const bottom = this.hgt - this.pad.b;
    if (s.band) {
      // Shaded band (e.g. a target's tolerance): upper edge left → right, lower edge back
      const lo = s.band;
      const path = new Path2D();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(s.y[i])) continue;
        const px = this.xToPx(s.x[i]);
        const py = this.yToPx(s.y[i], s.secondary);
        if (!started) path.moveTo(px, py);
        else path.lineTo(px, py);
        started = true;
      }
      for (let i = n - 1; i >= 0; i--) if (Number.isFinite(lo[i])) path.lineTo(this.xToPx(s.x[i]), this.yToPx(lo[i], s.secondary));
      path.closePath();
      ctx.globalAlpha = 0.14;
      ctx.fill(path);
      ctx.globalAlpha = 1;
      return;
    }
    if (s.bars) {
      const half = Math.pow(2, 1 / (2 * s.bars));
      const cap = Math.max(1.5, 2 * COLORS.lineScale);
      const fill = new Path2D();
      const tops = new Path2D();
      for (let i = 0; i < n; i++) {
        const x = s.x[i];
        if (x < xMin / 2 || x > xMax * 2 || !Number.isFinite(s.y[i])) continue;
        const x0 = this.xToPx(x / half);
        const x1 = this.xToPx(x * half);
        const gap = Math.min(2, (x1 - x0) * 0.12);
        const y = Math.max(this.pad.t - cap, this.yToPx(s.y[i], s.secondary));
        if (!s.cap && y < bottom) fill.rect(x0 + gap, y, Math.max(1, x1 - x0 - 2 * gap), bottom - y);
        tops.rect(x0 + gap, y - cap / 2, Math.max(1, x1 - x0 - 2 * gap), cap);
      }
      if (!s.cap && s.fillAlpha !== 0) {
        ctx.fillStyle = s.fillColor ? seriesColor(s.fillColor) : color;
        ctx.globalAlpha = s.fillAlpha ?? 0.45;
        ctx.fill(fill);
        ctx.fillStyle = color;
      }
      ctx.globalAlpha = 1;
      ctx.fill(tops);
      return;
    }
    if (s.alpha) {
      // Per-segment alpha (coherence blanking), batched into a few opacity levels: one stroke per level
      // instead of one per segment keeps this fast on phones and older devices
      const LEVELS = 8;
      const paths: Path2D[] = [];
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
        const lvl = Math.min(LEVELS - 1, Math.round(a * (LEVELS - 1)));
        const p = (paths[lvl] ??= new Path2D());
        p.moveTo(this.xToPx(x0), this.yToPx(y0, s.secondary));
        p.lineTo(this.xToPx(x1), this.yToPx(y1, s.secondary));
      }
      paths.forEach((p, lvl) => {
        if (!p) return;
        ctx.globalAlpha = Math.max(0.03, lvl / (LEVELS - 1));
        ctx.stroke(p);
      });
      ctx.globalAlpha = 1;
      return;
    }
    ctx.beginPath();
    let pen = false;
    let firstX = 0;
    let lastX = 0;
    // Only the visible x range (plus one point either side, so lines run to the edges)
    let i0 = 0;
    let i1 = n - 1;
    while (i0 < n - 1 && s.x[i0 + 1] < xMin) i0++;
    while (i1 > 0 && s.x[i1 - 1] > xMax) i1--;
    // Dense series (e.g. a 16k-point impulse response on a 1000-pixel plot): draw each pixel column as the
    // line through its first, lowest, highest and last point. Looks identical, draws a fraction of the segments.
    const dense = !s.wrap && i1 - i0 > 3 * (this.w - this.pad.l - this.pad.r);
    let col = NaN;
    let yF = 0;
    let yLo = 0;
    let yHi = 0;
    let yL = 0;
    const flush = () => {
      if (Number.isNaN(col)) return;
      if (!pen) {
        ctx.moveTo(col, yF);
        if (!firstX) firstX = col;
        pen = true;
      } else ctx.lineTo(col, yF);
      if (yLo !== yF) ctx.lineTo(col, yLo);
      if (yHi !== yLo) ctx.lineTo(col, yHi);
      if (yL !== yHi) ctx.lineTo(col, yL);
      lastX = col;
      col = NaN;
    };
    for (let i = i0; i <= i1; i++) {
      const x = s.x[i];
      const y = s.y[i];
      if (!Number.isFinite(y) || (x <= 0 && this.cfg.xType === 'log')) {
        if (dense) flush();
        pen = false;
        continue;
      }
      const px = this.xToPx(x);
      const py = this.yToPx(y, s.secondary);
      if (dense) {
        const c = Math.round(px);
        if (c !== col) {
          flush();
          col = c;
          yF = yLo = yHi = yL = py;
        } else {
          if (py < yLo) yLo = py;
          if (py > yHi) yHi = py;
          yL = py;
        }
        continue;
      }
      if (pen && s.wrap && Math.abs(y - s.y[i - 1]) > s.wrap) pen = false;
      if (!pen) {
        ctx.moveTo(px, py);
        if (!firstX) firstX = px;
        pen = true;
      } else ctx.lineTo(px, py);
      lastX = px;
    }
    if (dense) flush();
    if (s.halo) {
      ctx.save();
      ctx.strokeStyle = s.halo;
      ctx.lineWidth += 3;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    }
    ctx.stroke();
    if (s.fill && s.fillAlpha !== 0) {
      ctx.lineTo(lastX, bottom);
      ctx.lineTo(firstX, bottom);
      ctx.closePath();
      if (s.fillColor) ctx.fillStyle = seriesColor(s.fillColor);
      ctx.globalAlpha = s.fillAlpha ?? COLORS.fillAlpha;
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
      const v = s.bars ? barAt(s, x) : sampleAt(s.x, s.y, x);
      if (v === null) continue;
      const unit = s.unit ?? this.cfg.yUnit;
      const val = s.secondary ? `${(v * 100).toFixed(0)}%` : `${v.toFixed(1)} ${unit}`;
      rows.push(`<div><i style="background:${seriesColor(s.color)}"></i>${escapeHtml(s.label)} <b>${val}</b></div>`);
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
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
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

/** Level of the bar under frequency x (bars are 1/N octave wide around each centre). */
function barAt(s: Series, x: number): number | null {
  const half = Math.pow(2, 1 / (2 * (s.bars ?? 3)));
  for (let i = 0; i < s.x.length; i++) {
    if (x >= s.x[i] / half && x < s.x[i] * half) return Number.isFinite(s.y[i]) ? s.y[i] : null;
  }
  return null;
}
