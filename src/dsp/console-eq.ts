import { byBand, isBand, type PeqFilter } from './eq';

/**
 * EQ profiles of live mixing consoles: how many parametric bands the output (or channel) EQ has, the gain and
 * width ranges, whether the outer bands can be shelves, and how the console shows width (Q or octaves). The EQ
 * assistant then only suggests filters that console can set, and lists them the way it labels them.
 *
 * `documented`: the ranges are from the manufacturer's documentation. `typical`: from the console family's
 * usual behaviour; check them against your console and software version.
 */
export interface ConsoleEqProfile {
  id: string;
  /** Shown in the list, e.g. "Yamaha CL / QL". */
  name: string;
  /** Which EQ: "Mix / matrix output, 4 bands". */
  section: string;
  bands: number;
  gainMin: number;
  gainMax: number;
  qMin: number;
  qMax: number;
  /** How width is shown on the console: as Q, or as a width in octaves. */
  width: 'q' | 'octaves';
  /** Octave widths are also shown as fractions where they are one (1/3, 1/6, 1/9…), as on the console. */
  fractions?: boolean;
  /** High-pass slopes (dB/octave) the output has, in addition to the bands (empty: none). */
  hpf: number[];
  /** The first and last band can be shelves. */
  shelves: boolean;
  /** Band names in order of frequency (fewer filters use the first names). */
  bandNames: string[];
  source: 'documented' | 'typical';
  note: string;
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `Band ${i + 1}`);

export const CONSOLE_PROFILES: ConsoleEqProfile[] = [
  {
    id: 'generic',
    name: 'Any processor',
    section: 'Up to 8 parametric filters',
    bands: 8,
    gainMin: -15,
    gainMax: 15,
    qMin: 0.3,
    qMax: 10,
    width: 'q',
    shelves: true,
    hpf: [6, 12, 18, 24, 36, 48],
    bandNames: numbered(8),
    source: 'documented',
    note: 'No console limits: the filters as the assistant finds them.',
  },
  {
    id: 'digico-4',
    name: 'DiGiCo SD / Quantum',
    section: 'Output EQ, 4 bands',
    bands: 4,
    gainMin: -18,
    gainMax: 18,
    qMin: 0.1,
    qMax: 20,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['Band 1 (Low)', 'Band 2 (Low-mid)', 'Band 3 (High-mid)', 'Band 4 (High)'],
    source: 'documented',
    note: 'Bands 1 and 4 can be shelves (shelf Q 0.10–0.85). Every band can also be made dynamic.',
  },
  {
    id: 'digico-8',
    name: 'DiGiCo SD / Quantum',
    section: 'Output EQ, 8 bands (pre + post insert)',
    bands: 8,
    gainMin: -18,
    gainMax: 18,
    qMin: 0.1,
    qMax: 20,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['Pre 1', 'Pre 2', 'Pre 3', 'Pre 4', 'Post 1', 'Post 2', 'Post 3', 'Post 4'],
    source: 'documented',
    note: 'Larger SD and Quantum consoles have four bands before and four after the output insert.',
  },
  {
    id: 'yamaha-cl',
    name: 'Yamaha CL / QL',
    section: 'Mix / matrix / stereo EQ, 4 bands',
    bands: 4,
    gainMin: -18,
    gainMax: 18,
    qMin: 0.1,
    qMax: 16,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LOW', 'LOW-MID', 'HIGH-MID', 'HIGH'],
    source: 'typical',
    note: 'LOW and HIGH can be shelves. For more bands, insert an 8-band PEQ from the rack. EQ type I (precise) matches these filters best.',
  },
  {
    id: 'yamaha-peq8',
    name: 'Yamaha RIVAGE PM / DM7',
    section: 'Output 8-band PEQ',
    bands: 8,
    gainMin: -18,
    gainMax: 18,
    qMin: 0.1,
    qMax: 16,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: numbered(8),
    source: 'typical',
    note: 'Choose the Precise EQ type: its bells and shelves match these filters most closely.',
  },
  {
    id: 'avid-s6l',
    name: 'Avid VENUE S6L',
    section: 'Output EQ, 7 bands',
    bands: 7,
    gainMin: -18,
    gainMax: 18,
    qMin: 0.1,
    qMax: 10,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LF', 'LMF 1', 'LMF 2', 'MF', 'HMF 1', 'HMF 2', 'HF'],
    source: 'typical',
    note: 'Outputs and matrices have a 7-band parametric EQ (plus a 31-band graphic); the outer bands can be shelves.',
  },
  {
    id: 'ah-dlive',
    name: 'Allen & Heath dLive / Avantis / SQ',
    section: 'Mix output PEQ, 4 bands',
    bands: 4,
    gainMin: -15,
    gainMax: 15,
    // Width 1.5 to 1/9 octave
    qMin: 0.92,
    qMax: 13,
    width: 'octaves',
    fractions: true,
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LF', 'LM', 'HM', 'HF'],
    source: 'documented',
    note: 'Width is set in octaves (shown as decimals and as 1/3, 1/6, 1/9…); LF and HF can be shelves. Allen & Heath’s octave width is not quite the usual Q conversion, so a band can come out slightly wider or narrower than predicted: check it with a measurement. Mixes also have a 28-band graphic EQ.',
  },
  {
    id: 'x32-bus',
    name: 'Midas M32 / Behringer X32',
    section: 'Bus / matrix / main EQ, 6 bands',
    bands: 6,
    gainMin: -15,
    gainMax: 15,
    qMin: 0.3,
    qMax: 10,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LOW', 'LO-MID', 'MID', 'HI-MID', 'HIGH 2', 'HIGH'],
    source: 'typical',
    note: 'Buses, matrices and mains have 6 bands; set them to PEQ (not VEQ) to match these filters. LOW and HIGH can be shelves.',
  },
  {
    id: 'wing-bus',
    name: 'Behringer WING',
    section: 'Bus / matrix / main EQ, 8 bands',
    bands: 8,
    gainMin: -15,
    gainMax: 15,
    qMin: 0.44,
    qMax: 10,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['L', '1', '2', '3', '4', '5', '6', 'H'],
    source: 'typical',
    note: 'Buses, matrices and mains have 8 bands (L, 1–6, H) with the WING EQ; L and H can be shelves.',
  },
  {
    id: 'midas-hd96',
    name: 'Midas HD96',
    section: 'Output EQ, 4 bands',
    bands: 4,
    gainMin: -15,
    gainMax: 15,
    qMin: 0.3,
    qMax: 10,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LF', 'LMF', 'HMF', 'HF'],
    source: 'typical',
    note: 'Outputs have a 4-band parametric EQ with shelf options on the outer bands; insert a GEQ or PEQ for more.',
  },
  {
    id: 'midas-pro',
    name: 'Midas PRO series',
    section: 'Output EQ, 4 bands',
    bands: 4,
    gainMin: -15,
    gainMax: 15,
    // Width 2 to 0.1 octave
    qMin: 0.67,
    qMax: 14.4,
    width: 'octaves',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LF', 'LMF', 'HMF', 'HF'],
    source: 'typical',
    note: 'Width is set in octaves (0.1 to 2), not Q. The outer bands can be shelves.',
  },
  {
    id: 'ssl-live',
    name: 'SSL Live',
    section: 'Matrix EQ, 4 bands',
    bands: 4,
    gainMin: -18,
    gainMax: 18,
    qMin: 0.1,
    qMax: 10,
    width: 'q',
    shelves: true,
    hpf: [12, 24],
    bandNames: ['LF', 'LMF', 'HMF', 'HF'],
    source: 'typical',
    note: 'Use constant-Q mode (not SSL Legacy) to match these filters; LF and HF can be shelves. The effects rack adds a 6- or 10-band PEQ.',
  },
];

export function profileById(id: string): ConsoleEqProfile {
  return CONSOLE_PROFILES.find((p) => p.id === id) ?? CONSOLE_PROFILES[0];
}

/** Bandwidth in octaves of a bell with this Q (as consoles that show width in octaves define it). */
export function qToOctaves(q: number): number {
  return (2 / Math.LN2) * Math.asinh(1 / (2 * q));
}

export function octavesToQ(n: number): number {
  const p = Math.pow(2, n);
  return Math.sqrt(p) / (p - 1);
}

/** A filter brought within a console's ranges and to the precision it shows. */
export function fitToProfile(f: PeqFilter, p: ConsoleEqProfile): PeqFilter {
  if (f.type === 'highpass') {
    // The nearest slope the console has, the frequency as it shows it
    const slopes = p.hpf.length ? p.hpf : [12];
    const slope = slopes.reduce((a, b) => (Math.abs(b - (f.slope ?? 12)) < Math.abs(a - (f.slope ?? 12)) ? b : a));
    const fr = Math.min(1000, Math.max(20, f.f));
    return { ...f, f: fr < 100 ? Math.round(fr) : Math.round(fr / 5) * 5, gain: 0, q: 0.707, slope };
  }
  // Any processor: only the ranges, at full precision
  if (p.id === 'generic') return { ...f, gain: Math.min(p.gainMax, Math.max(p.gainMin, f.gain)), q: Math.min(p.qMax, Math.max(p.qMin, f.q)) };
  const gain = Math.round(Math.min(p.gainMax, Math.max(p.gainMin, f.gain)) * 10) / 10;
  let q = Math.min(p.qMax, Math.max(p.qMin, f.q));
  // At the precision the console shows: the width in octaves (two decimals) on octave consoles, else Q
  if (p.width === 'octaves') q = octavesToQ(Math.round(qToOctaves(q) * 100) / 100);
  else q = q < 1 ? Math.round(q * 100) / 100 : Math.round(q * 10) / 10;
  const fr = Math.min(20000, Math.max(20, f.f));
  return { ...f, f: fr < 1000 ? Math.round(fr) : Math.round(fr / 10) * 10, gain, q };
}

/** How the console labels a filter's width. */
export function widthLabel(q: number, p: ConsoleEqProfile): string {
  return p.width === 'octaves' ? `width ${octaveText(qToOctaves(q), p)}` : `Q ${formatQ(q)}`;
}

/** The console's word for the width control. */
export function widthName(p: ConsoleEqProfile): string {
  return p.width === 'octaves' ? 'Width' : 'Q';
}

/** Q as consoles show it: two decimals below 1, one above. */
export function formatQ(q: number): string {
  return q < 1 ? q.toFixed(2) : q.toFixed(1);
}

/** The nearest simple fraction of an octave (1/2 … 1/12), when the width is within 2 % of one. */
export function octaveFraction(n: number): string | null {
  for (let k = 2; k <= 12; k++) if (Math.abs(n * k - 1) < 0.02) return `1/${k}`;
  return null;
}

/** An octave width as the console shows it: "0.33 oct (1/3)" on consoles that use fractions. */
export function octaveText(n: number, p: ConsoleEqProfile): string {
  const frac = p.fractions ? octaveFraction(n) : null;
  return `${n.toFixed(2)} oct${frac ? ` (${frac})` : ''}`;
}

/** Bring a value typed in the console's own units (Q, or width in octaves) to a filter Q. */
export function widthToQ(v: number, p: ConsoleEqProfile): number {
  return p.width === 'octaves' ? octavesToQ(v) : v;
}

const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const kind = (f: PeqFilter) => (f.type === 'lowshelf' ? 'low shelf' : f.type === 'highshelf' ? 'high shelf' : f.type === 'highpass' ? 'high-pass' : 'bell');

/** One band as the console shows it: its name, the filter type, and frequency, gain and width as text. */
export interface ConsoleBand {
  name: string;
  kind: string;
  freq: string;
  /** Signed, e.g. "+3.0 dB"; empty for a high-pass. */
  gain: string;
  /** "Q 4.3", "0.33 oct (1/3)", or the high-pass slope "24 dB/oct". */
  width: string;
}

/** The filters as the console shows them, in its band order (the high-pass first). */
export function consoleBands(filters: PeqFilter[], p: ConsoleEqProfile): ConsoleBand[] {
  const sorted = [...filters].sort(byBand);
  let band = 0;
  return sorted.map((f) => {
    if (!isBand(f)) return { name: 'HPF', kind: kind(f), freq: fmtF(f.f), gain: '', width: `${f.slope ?? 12} dB/oct` };
    const i = band++;
    return { name: p.bandNames[i] ?? `Band ${i + 1}`, kind: kind(f), freq: fmtF(f.f), gain: `${f.gain > 0 ? '+' : ''}${f.gain.toFixed(1)} dB`, width: widthLabel(f.q, p) };
  });
}

/** The filters as a list to enter on the console, band by band. */
export function consoleText(filters: PeqFilter[], p: ConsoleEqProfile): string {
  const lines = consoleBands(filters, p).map((b) => (b.gain ? `${b.name}: ${b.kind}, ${b.freq}, ${b.gain}, ${b.width}` : `${b.name}: ${b.kind}, ${b.freq}, ${b.width}`));
  return [`${p.name} – ${p.section}`, ...lines].join('\n');
}
