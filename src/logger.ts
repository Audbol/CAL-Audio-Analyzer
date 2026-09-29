import { octaveBandCentres } from './dsp/freq';

/**
 * Continuous sound level logging: Leq and Lmax per interval (1 s to 15 min) with the third-octave spectrum,
 * a rolling Leq against a limit (e.g. a venue's 100 dB LAeq,15min) with alarms, and CSV export.
 */

export interface LogRow {
  /** End of the interval (epoch ms). */
  t: number;
  /** Seconds of signal in the interval. */
  dur: number;
  leq: number;
  max: number;
  /** Third-octave band Leq (dB) at LOG_BANDS, or null without spectrum data. */
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
  integrator(): { sum: number; count: number };
  levelOf(meanSquare: number): number;
  takeMax(): number;
}

export const LOG_BANDS = octaveBandCentres(3, 25, 16000);
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
  private mark: { sum: number; count: number } | null = null;
  private markAt = 0;
  private max = -Infinity;
  private bandPow: Float64Array | null = null;
  private bandN = 0;
  private lastCheck = 0;
  /** Current (unfinished) interval: energy and seconds so far, for the rolling Leq. */
  private partial = { e: 0, dur: 0 };

  constructor(private persist = true) {
    if (!persist) return;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.load(JSON.parse(raw) as LogFile);
    } catch {
      /* no stored log */
    }
  }

  start(meter: LogMeter, weighting: string, calibrated: boolean, now = Date.now()): void {
    if (!this.rows.length) this.started = now;
    this.weighting = weighting;
    this.calibrated = calibrated;
    this.running = true;
    this.mark = meter.integrator();
    this.markAt = now;
    meter.takeMax();
    this.max = -Infinity;
    this.bandPow = null;
    this.bandN = 0;
    this.partial = { e: 0, dur: 0 };
  }

  stop(meter?: LogMeter, now = Date.now()): void {
    if (this.running && meter) this.close(meter, now);
    this.running = false;
    this.mark = null;
    this.save();
  }

  clear(): void {
    this.rows = [];
    this.started = this.running ? Date.now() : 0;
    this.state = 'none';
    this.version++;
    this.save();
  }

  /**
   * Called every frame while audio runs. `bands`: current third-octave band levels (dB, at LOG_BANDS) or null.
   */
  sample(meter: LogMeter, bands: ArrayLike<number> | null, now = Date.now()): void {
    if (!this.running || !this.mark) return;
    const m = meter.integrator();
    if (m.count < this.mark.count) {
      // The meter was recreated (audio restarted): start a new interval from here
      this.mark = m;
      this.markAt = now;
      return;
    }
    this.max = Math.max(this.max, meter.takeMax());
    if (bands) {
      if (!this.bandPow) this.bandPow = new Float64Array(LOG_BANDS.length);
      for (let i = 0; i < LOG_BANDS.length; i++) this.bandPow[i] += Math.pow(10, bands[i] / 10);
      this.bandN++;
    }
    const dCount = m.count - this.mark.count;
    this.partial = dCount > 0 ? { e: meter.levelOf((m.sum - this.mark.sum) / dCount), dur: (now - this.markAt) / 1000 } : { e: -Infinity, dur: 0 };
    if (now - this.markAt >= this.config.interval * 1000) this.close(meter, now);
    if (now - this.lastCheck >= 1000) {
      this.lastCheck = now;
      this.checkLimit(now);
    }
  }

  /** Finish the current interval as a row. */
  private close(meter: LogMeter, now: number): void {
    if (!this.mark) return;
    const m = meter.integrator();
    const dCount = m.count - this.mark.count;
    if (dCount > 0) {
      const dur = (now - this.markAt) / 1000;
      const bands = this.bandPow && this.bandN ? Array.from(this.bandPow, (p) => +(10 * Math.log10(p / this.bandN)).toFixed(1)) : null;
      this.rows.push({ t: now, dur: +dur.toFixed(2), leq: +meter.levelOf((m.sum - this.mark.sum) / dCount).toFixed(2), max: Number.isFinite(this.max) ? +this.max.toFixed(2) : NaN, bands });
      this.version++;
      this.save();
    }
    this.mark = m;
    this.markAt = now;
    this.max = -Infinity;
    this.bandPow = null;
    this.bandN = 0;
    this.partial = { e: -Infinity, dur: 0 };
  }

  /** Energy-average Leq of the rows (and the current interval) in the last `minutes`. */
  rolling(minutes = this.config.window, now = Date.now()): number {
    const from = now - minutes * 60000;
    let e = 0;
    let dur = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r.t <= from) break;
      // Only the part of the row inside the window counts
      const d = Math.min(r.dur, (r.t - from) / 1000);
      e += Math.pow(10, r.leq / 10) * d;
      dur += d;
    }
    if (this.running && this.partial.dur > 0 && Number.isFinite(this.partial.e)) {
      e += Math.pow(10, this.partial.e / 10) * this.partial.dur;
      dur += this.partial.dur;
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
    const w = this.weighting;
    const unit = this.calibrated ? 'dB' : 'dBFS';
    const head = ['time', 'seconds', `L${w}eq (${unit})`, `L${w}Fmax (${unit})`, ...LOG_BANDS.map((f) => `${f < 1000 ? Math.round(f) : `${+(f / 1000).toFixed(1)}k`} Hz Leq (Z)`)];
    const lines = this.rows.map((r) => [new Date(r.t).toISOString(), r.dur, r.leq, Number.isFinite(r.max) ? r.max : '', ...(r.bands ?? LOG_BANDS.map(() => ''))].join(','));
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
