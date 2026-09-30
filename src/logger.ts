import { thirdOctaveCentres } from './dsp/octave-bank';
import type { SplRow } from './dsp/spl';

/**
 * Continuous sound level logging: Leq and Lmax per interval (1 s to 15 min) with the third-octave spectrum,
 * a rolling Leq against a limit (e.g. a venue's 100 dB LAeq,15min) with alarms, and CSV export.
 *
 * The rows are measured by the SPL meter itself on the raw samples, cut at exact sample boundaries (see
 * SplMeter.startRows): nothing depends on the display, its refresh rate or the analysis settings.
 */

export interface LogRow {
  /** End of the interval (epoch ms). */
  t: number;
  /** Seconds of signal in the interval (exact: samples / sample rate). */
  dur: number;
  leq: number;
  max: number;
  /** Frequency weighting of leq / max. */
  w?: string;
  /** Unweighted third-octave band Leq (dB) at LOG_BANDS, or null. */
  bands: number[] | null;
}

export interface LoggerConfig {
  /** Logging interval (s). */
  interval: number;
  /** Level limit (dB, 0 = none), compared with the rolling Leq over `window`. */
  limit: number;
  /** Rolling Leq window for the limit (minutes). */
  window: number;
}

export interface LogFile {
  config: LoggerConfig;
  weighting: string;
  calibrated: boolean;
  started: number;
  rows: LogRow[];
}

export type LimitState = 'none' | 'ok' | 'near' | 'over';

/** What the logger needs from the SPL meter. */
export interface LogMeter {
  readonly fs: number;
  readonly weighting: string;
  startRows(seconds: number, onRow: (r: SplRow) => void): void;
  stopRows(): void;
  partialRow(): { samples: number; leq: number } | null;
}

export const LOG_BANDS = thirdOctaveCentres(25, 16000);
const STORE_KEY = 'cal-analyzer-log-v1';
/** Warn this many dB below the limit. */
export const NEAR_DB = 3;

export class SplLogger {
  rows: LogRow[] = [];
  config: LoggerConfig = { interval: 60, limit: 0, window: 15 };
  running = false;
  started = 0;
  weighting = 'A';
  calibrated = false;
  state: LimitState = 'none';
  /** Increases on every new row (views redraw only then). */
  version = 0;
  onState?: (s: LimitState, rolling: number) => void;
  private meter: LogMeter | null = null;
  private lastCheck = 0;
  /** Clock for row timestamps (tests override it). */
  now: () => number = () => Date.now();

  constructor(private persist = true) {
    if (!persist) return;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.load(JSON.parse(raw) as LogFile);
    } catch {
      /* no stored log */
    }
  }

  start(meter: LogMeter, weighting: string, calibrated: boolean): void {
    if (!this.rows.length) this.started = this.now();
    this.weighting = weighting;
    this.calibrated = calibrated;
    this.running = true;
    this.attach(meter);
  }

  /** Follow a (new) meter: audio restarted, or the meter was recreated. */
  attach(meter: LogMeter): void {
    if (this.meter && this.meter !== meter) this.meter.stopRows();
    this.meter = meter;
    if (this.running) meter.startRows(this.config.interval, (r) => this.addRow(r, meter.fs));
  }

  stop(): void {
    this.running = false;
    this.meter?.stopRows();
    this.meter = null;
    this.save();
  }

  /** A new interval length applies from the next row; the unfinished row is logged as it is (not lost). */
  setInterval(seconds: number): void {
    this.config.interval = seconds;
    if (this.running && this.meter) {
      this.meter.stopRows();
      this.attach(this.meter);
    }
    this.save();
  }

  clear(): void {
    this.rows = [];
    this.started = this.running ? this.now() : 0;
    this.state = 'none';
    this.version++;
    this.save();
  }

  private addRow(r: SplRow, fs: number): void {
    this.rows.push({
      t: this.now(),
      dur: +(r.samples / fs).toFixed(4),
      leq: +r.leq.toFixed(2),
      max: Number.isFinite(r.max) ? +r.max.toFixed(2) : NaN,
      w: r.weighting,
      bands: r.bands ? r.bands.map((v) => (Number.isFinite(v) ? +v.toFixed(1) : NaN)) : null,
    });
    this.weighting = r.weighting;
    this.version++;
    this.save();
    this.checkLimit(this.now());
  }

  /** Called regularly (any rate): keeps the limit state current between rows. */
  tick(now = this.now()): void {
    if (!this.running || now - this.lastCheck < 1000) return;
    this.lastCheck = now;
    this.checkLimit(now);
  }

  /** Energy-average Leq of the rows (and the unfinished row) in the last `minutes`. */
  rolling(minutes = this.config.window, now = this.now()): number {
    const from = now - minutes * 60000;
    let e = 0;
    let dur = 0;
    const p = this.running && this.meter ? this.meter.partialRow() : null;
    if (p) {
      const d = Math.min(p.samples / this.meter!.fs, minutes * 60);
      e += Math.pow(10, p.leq / 10) * d;
      dur += d;
    }
    for (let i = this.rows.length - 1; i >= 0 && dur < minutes * 60; i--) {
      const r = this.rows[i];
      if (r.t <= from) break;
      // Only the part of the row inside the window counts
      const d = Math.min(r.dur, minutes * 60 - dur);
      e += Math.pow(10, r.leq / 10) * d;
      dur += d;
    }
    return dur > 0 ? 10 * Math.log10(e / dur) : -Infinity;
  }

  private checkLimit(now: number): void {
    const lim = this.config.limit;
    const r = this.rolling(this.config.window, now);
    const st: LimitState = !lim || !Number.isFinite(r) ? 'none' : r > lim ? 'over' : r > lim - NEAR_DB ? 'near' : 'ok';
    if (st !== this.state) {
      this.state = st;
      this.onState?.(st, r);
    }
  }

  /** Overall figures for the log. */
  summary(): { leq: number; max: number; duration: number; overMinutes: number } | null {
    if (!this.rows.length) return null;
    let e = 0;
    let dur = 0;
    let max = -Infinity;
    let over = 0;
    for (const r of this.rows) {
      e += Math.pow(10, r.leq / 10) * r.dur;
      dur += r.dur;
      if (Number.isFinite(r.max)) max = Math.max(max, r.max);
      if (this.config.limit && r.leq > this.config.limit) over += r.dur;
    }
    return { leq: 10 * Math.log10(e / dur), max, duration: dur, overMinutes: over / 60 };
  }

  toCsv(): string {
    const unit = this.calibrated ? 'dB' : 'dBFS';
    const head = ['time', 'seconds', 'weighting', `Leq (${unit})`, `LFmax (${unit})`, ...LOG_BANDS.map((f) => `${f < 1000 ? Math.round(f) : `${+(f / 1000).toFixed(1)}k`} Hz Leq (Z)`)];
    const lines = this.rows.map((r) => [new Date(r.t).toISOString(), r.dur, r.w ?? this.weighting, r.leq, Number.isFinite(r.max) ? r.max : '', ...LOG_BANDS.map((_, k) => (r.bands && Number.isFinite(r.bands[k]) ? r.bands[k] : ''))].join(','));
    return [head.join(','), ...lines].join('\n');
  }

  snapshot(): LogFile {
    return { config: { ...this.config }, weighting: this.weighting, calibrated: this.calibrated, started: this.started, rows: this.rows.map((r) => ({ ...r })) };
  }

  load(f: LogFile | null): void {
    this.rows = f?.rows?.filter((r) => r && Number.isFinite(r.t) && Number.isFinite(r.leq)) ?? [];
    if (f?.config) this.config = { ...this.config, ...f.config };
    this.weighting = f?.weighting ?? 'A';
    this.calibrated = !!f?.calibrated;
    this.started = f?.started ?? (this.rows[0]?.t ?? 0);
    this.state = 'none';
    this.version++;
  }

  save(): void {
    if (!this.persist) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.snapshot()));
    } catch {
      /* storage full: the log stays in memory */
    }
  }
}
