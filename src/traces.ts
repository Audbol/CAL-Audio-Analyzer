import { PALETTE } from './state';

export type TraceKind = 'tf' | 'rta' | 'sweep';

export interface Trace {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  kind: TraceKind;
  freqs: number[];
  /** dB */
  mag: number[];
  /** degrees */
  phase?: number[];
  coh?: number[];
  created: number;
  /** Display offset in dB. */
  offset: number;
  note?: string;
}

const KEY = 'cal-analyzer-traces-v1';

/** A change to the trace list, as exchanged between remote devices and the measurement host. */
export type TraceOp =
  | { op: 'add'; trace: Trace }
  | { op: 'update'; id: string; patch: Partial<Trace> }
  | { op: 'remove'; id: string }
  | { op: 'clear' };

export class TraceStore {
  traces: Trace[] = [];
  private listeners = new Set<() => void>();
  /**
   * Remote devices: changes are applied locally at once and forwarded here (to the measurement host, which
   * owns the shared trace list and broadcasts it to every device). Nothing is persisted on the remote.
   */
  sink: ((op: TraceOp) => void) | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.traces = JSON.parse(raw);
    } catch {
      this.traces = [];
    }
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(op?: TraceOp): void {
    if (this.sink) {
      if (op) this.sink(op);
    } else {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.traces));
      } catch {
        /* ignore quota errors */
      }
    }
    for (const l of this.listeners) l();
  }

  /** Remote devices: replace the list with the host's shared list. */
  setAll(traces: Trace[]): void {
    this.traces = traces;
    for (const l of this.listeners) l();
  }

  /** Host: apply a change made on a remote device. */
  apply(op: TraceOp): void {
    switch (op.op) {
      case 'add':
        if (!this.traces.some((t) => t.id === op.trace.id)) this.traces.push(op.trace);
        break;
      case 'update': {
        const t = this.traces.find((x) => x.id === op.id);
        if (t) Object.assign(t, op.patch);
        break;
      }
      case 'remove':
        this.traces = this.traces.filter((t) => t.id !== op.id);
        break;
      case 'clear':
        this.traces = [];
        break;
    }
    this.emit();
  }

  nextColor(): string {
    return PALETTE[(this.traces.length + 3) % PALETTE.length];
  }

  add(t: Omit<Trace, 'id' | 'created' | 'visible' | 'offset' | 'color'> & Partial<Pick<Trace, 'color'>>): Trace {
    const trace: Trace = {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      created: Date.now(),
      visible: true,
      offset: 0,
      color: t.color ?? this.nextColor(),
      ...t,
    } as Trace;
    this.traces.push(trace);
    this.emit({ op: 'add', trace });
    return trace;
  }

  update(id: string, patch: Partial<Trace>): void {
    const t = this.traces.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
    this.emit({ op: 'update', id, patch });
  }

  remove(id: string): void {
    this.traces = this.traces.filter((t) => t.id !== id);
    this.emit({ op: 'remove', id });
  }

  clear(): void {
    this.traces = [];
    this.emit({ op: 'clear' });
  }

  /**
   * Average the selected traces. Magnitudes are power-averaged (spatial average, as used for multi-position
   * system EQ); phase is vector-averaged; coherence is averaged.
   */
  average(ids: string[], name = 'Average'): Trace | null {
    const src = this.traces.filter((t) => ids.includes(t.id));
    if (src.length < 2) return null;
    const freqs = src[0].freqs;
    const n = freqs.length;
    const mag: number[] = new Array(n).fill(0);
    const re: number[] = new Array(n).fill(0);
    const im: number[] = new Array(n).fill(0);
    const coh: number[] = new Array(n).fill(0);
    const hasPhase = src.every((t) => t.phase);
    const hasCoh = src.every((t) => t.coh);
    for (const t of src) {
      for (let i = 0; i < n; i++) {
        const m = interpAt(t.freqs, t.mag, freqs[i]) + t.offset;
        mag[i] += Math.pow(10, m / 10);
        if (hasPhase) {
          const p = (interpAt(t.freqs, t.phase!, freqs[i]) * Math.PI) / 180;
          re[i] += Math.cos(p);
          im[i] += Math.sin(p);
        }
        if (hasCoh) coh[i] += interpAt(t.freqs, t.coh!, freqs[i]);
      }
    }
    return this.add({
      name,
      kind: src[0].kind,
      freqs: [...freqs],
      mag: mag.map((v) => 10 * Math.log10(v / src.length)),
      phase: hasPhase ? re.map((r, i) => (Math.atan2(im[i], r) * 180) / Math.PI) : undefined,
      coh: hasCoh ? coh.map((c) => c / src.length) : undefined,
      note: `Power average of ${src.length} traces`,
    });
  }
}

function interpAt(x: number[], y: number[], xi: number): number {
  const n = x.length;
  if (xi <= x[0]) return y[0];
  if (xi >= x[n - 1]) return y[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (x[m] <= xi) lo = m;
    else hi = m;
  }
  const t = (xi - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + (y[hi] - y[lo]) * t;
}

export function traceToCsv(t: Trace): string {
  const lines = [`* CAL Audio Analyzer export: ${t.name}`, `* ${new Date(t.created).toISOString()}`, 'Frequency(Hz),Magnitude(dB),Phase(deg),Coherence'];
  for (let i = 0; i < t.freqs.length; i++) {
    lines.push(
      [t.freqs[i].toFixed(3), (t.mag[i] + t.offset).toFixed(3), t.phase ? t.phase[i].toFixed(2) : '', t.coh ? t.coh[i].toFixed(4) : ''].join(','),
    );
  }
  return lines.join('\n');
}

/** Parse CSV / FRD / plain measurement text: frequency, magnitude [, phase [, coherence]]. */
export function parseTraceText(text: string): Pick<Trace, 'freqs' | 'mag' | 'phase' | 'coh'> {
  const freqs: number[] = [];
  const mag: number[] = [];
  const phase: number[] = [];
  const coh: number[] = [];
  let cols = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[*#;a-z"]/i.test(line)) continue;
    const parts = line.split(/[\s,;\t]+/).filter(Boolean).map(Number);
    if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite) || parts[0] <= 0) continue;
    cols = cols || parts.length;
    freqs.push(parts[0]);
    mag.push(parts[1]);
    if (parts.length > 2 && Number.isFinite(parts[2])) phase.push(parts[2]);
    if (parts.length > 3 && Number.isFinite(parts[3])) coh.push(parts[3]);
  }
  if (freqs.length < 2) throw new Error('No frequency/magnitude data found in file.');
  return {
    freqs,
    mag,
    phase: phase.length === freqs.length ? phase : undefined,
    coh: coh.length === freqs.length ? coh : undefined,
  };
}

export function download(name: string, content: string, type = 'text/csv'): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
