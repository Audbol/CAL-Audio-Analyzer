import type { Workspace } from './workspaces';
import type { CustomTheme } from './ui/themes';
import type { WaterfallView } from './ui/waterfall-plot';
import type { FillGradient } from './ui/plot';
import { DEFAULT_CROSSOVER, type CrossoverDesign } from './dsp/crossover';
import { DEFAULT_WATERMARK, type WatermarkSettings } from './ui/watermark';
import type { PlaylistPrefs } from './audio/playlist';
import type { LfResolution } from './dsp/decimate';
import type { Smoothing } from './dsp/freq';
import type { Averaging } from './dsp/transfer';
import type { Weighting } from './dsp/weighting';
import type { GeneratorConfig } from './audio/protocol';
import type { MicCalibration } from './dsp/calibration';
import { GEN_CHANNEL } from './audio/engine';
import type { DockLayout } from './ui/dock';

import { PALETTE } from './ui/theme';
export { PALETTE };

/** Colours used by earlier versions; stored measurements using them are moved to the current palette. */
const LEGACY_PALETTE = ['#2dd4bf', '#f59e0b', '#a78bfa', '#f472b6', '#60a5fa', '#a3e635', '#fb7185', '#fbbf24', '#22d3ee', '#e879f9'];

export type ViewId = 'spectrum' | 'transfer' | 'spectrogram' | 'impulse' | 'room' | 'eq' | 'align' | 'spl' | 'tools';

export type Theme = 'night' | 'day';

export interface RemoteServerSettings {
  /** Start the server automatically when the desktop app launches. */
  enabled: boolean;
  port: number;
  /** Access PIN remote browsers must enter. Empty = no PIN (not recommended). */
  pin: string;
  /** Whether remote clients may drive the generator, sweeps and audio start. */
  allowControl: boolean;
}

/** A measurement microphone: the input it is plugged into, its correction file and its SPL calibration. */
/**
 * A measurement mic in the inventory: set up once (correction file, SPL calibration) and chosen for a
 * measurement. It follows the input of the measurement that uses it.
 */
export interface MicProfile {
  id: string;
  name: string;
  /** Model and serial number, for the inventory and reports (optional). */
  model?: string;
  serial?: string;
  /** Input channel the mic is plugged into now (−1 = not connected); set by the measurement that uses it. */
  channel: number;
  /** Frequency-response correction file supplied with the mic. */
  micCal: MicCalibration | null;
  /** dB to add to dBFS to get dB SPL on this input (0 → uncalibrated). */
  splOffset: number;
  splCalibrated: boolean;
  /** When and with which reference level it was SPL-calibrated. */
  calibratedAt?: number;
  calLevel?: number;
}

export interface MeasurementConfig {
  id: string;
  name: string;
  color: string;
  /** Input channel index for the measurement microphone. */
  mic: number;
  /** The microphone from the inventory used for this measurement (its calibration applies). */
  micId?: string;
  /** Input channel index for the reference, or GEN_CHANNEL for the internal generator reference. */
  ref: number;
  /** Delay applied to the reference, in samples. */
  delay: number;
  enabled: boolean;
  invert: boolean;
}

/** A note the user put on a graph at a frequency (Spectrum, Transfer or the sweep's frequency response). */
export interface GraphNote {
  id: string;
  graph: 'spectrum' | 'transfer' | 'room';
  f: number;
  text: string;
  created: number;
}

export interface CompareSettings {
  before: string;
  after: string;
  /** A built-in target id ('flat', 'house'…). */
  target: string;
  fMin: number;
  fMax: number;
  /** Move "before" to the level of "after", so only the change in shape shows. */
  matchLevels: boolean;
  report: boolean;
}

export interface Settings {
  view: ViewId;
  /** Night = OLED black; Day = high-contrast light scheme for use in direct sunlight. */
  theme: Theme;
  simulate: boolean;
  deviceId: string;
  generator: GeneratorConfig;
  tfSmoothing: Smoothing;
  rtaSmoothing: Smoothing;
  tfAveraging: Averaging;
  rtaAveraging: Averaging;
  rtaFft: number;
  /** Bass resolution: extra long analysis windows below ~160 Hz (see dsp/decimate.ts). */
  lfResolution: LfResolution;
  /** RTA drawn as a line or as fractional-octave bars. */
  rtaStyle: 'line' | 'bars';
  /** Remote devices: analysis computed by the measurement host (fast, identical everywhere) or on this device. */
  remoteProcessing: 'host' | 'device';
  /** Graph resolution: auto lowers it when drawing can't keep up (slow devices). */
  graphQuality: 'auto' | 'high' | 'fast';
  /** Music generator playlist order and playback options (the song files live in IndexedDB). */
  playlist: PlaylistPrefs;
  coherenceThreshold: number;
  showCoherence: boolean;
  /** Panel arrangements (order, sizes, floating, hidden) of the Spectrum and Transfer views. */
  spectrumLayout: DockLayout | null;
  transferLayout: DockLayout | null;
  /** Panel arrangement of the SPL tab (sound level, history, noise log). */
  splLayout: DockLayout | null;
  remoteServer: RemoteServerSettings;
  peakHold: boolean;
  splWeighting: Weighting;
  splTime: 'fast' | 'slow';
  /**
   * SPL calibration and mic correction of the SPL meter's input. Derived from `mics` (App.syncCal); kept so the
   * meters, logger and older sessions have one value to use.
   */
  splOffset: number;
  splCalibrated: boolean;
  micCal: MicCalibration | null;
  /** Measurement microphones: per-input correction files and SPL calibrations. */
  mics: MicProfile[];
  tempC: number;
  measurements: MeasurementConfig[];
  wizardDone: boolean;
  magRange: [number, number];
  rtaRange: [number, number];
  splChannel: number;
  spectrogramRange: [number, number];
  /** Spectrogram layout: frequency horizontal (waterfall) or vertical. */
  spectrogramLayout: 'horizontal' | 'vertical';
  /** Spectrum average curve: averaging time in seconds (0 = off, -1 = everything since reset). */
  rtaAverageCurve: number;
  /** Smoothing of the average curve: 1/n octave with a bell-shaped window (0 = none). */
  rtaAverageSmoothing: number;
  /**
   * Spectrum colours: the trace (line or bar tops) and its fill (area under the line, bar bodies). 'auto' uses each
   * measurement's own colour; the fill can also be 'none'. Fill opacity in percent (0 = theme default).
   */
  rtaTraceColor: string;
  rtaFillColor: string;
  rtaFillOpacity: number;
  /** How the spectrum's fill is painted: one colour, fading downwards, by level or by frequency. */
  rtaFillGradient: FillGradient;
  /** Highlight the highest peak in the low, mid and high ranges of the spectrum. */
  rtaPeakMarks: boolean;
  /** Spectrum motion: 'smooth' glides the curve from one spectrum to the next, 'stepped' jumps. */
  rtaMotion: 'smooth' | 'stepped';
  /** New spectra per second (more = smoother and quicker, about twice the processing at 50). */
  rtaUpdates: 25 | 50;
  /** Colour theme: '' = the built-in Night or Day (see `theme`), else a preset (`preset:…`) or a custom theme. */
  themeId: string;
  /** The guided tour was taken or skipped (the Assistant stops offering it). */
  tourDone: boolean;
  /** The version that last ran (What's new is shown after an update to a new major version). */
  lastSeenVersion: string;
  /** Desktop app: look for new versions by itself (off: only when asked). Never downloads or installs on its own. */
  autoUpdateCheck: boolean;
  /** The Room waterfall's 3-D angle and zoom. */
  waterfallView: WaterfallView;
  /** EQ tab: the console (or processor) the EQ is for: its bands and ranges limit the suggested filters. */
  eqConsole: string;
  /** Align: the virtual crossover applied to subs and mains to preview their sum. */
  crossover: CrossoverDesign;
  /** An image (logo) drawn faintly on the graphs. */
  watermark: WatermarkSettings;
  customThemes: CustomTheme[];
  /** Where the live analysis runs: a background thread (smoother drawing) or the main thread. */
  analysisThread: 'worker' | 'main';
  /** Saved sweep traces on the Spectrum too, levelled to the live curve (a sweep measures shape, not level). */
  rtaShowSweeps: boolean;
  /** Feedback finder on the Spectrum: narrow, growing or ringing peaks with a suggested notch. */
  feedbackFinder: boolean;
  /** How the average curve is drawn: shown or hidden (still measured), colour ('auto' = white / black by theme), line width (px). */
  avgCurveShow: boolean;
  avgCurveColor: string;
  avgCurveWidth: number;
  /** Battery saver: fewer updates and lighter drawing. 'auto' turns it on while the device runs on battery. */
  powerMode: 'auto' | 'normal' | 'saver';
  /** The Assistant tips in the sidebar (hidden: the traces get the space). */
  showAssistant: boolean;
  /** Several mics: show their live power average (and the spread between them) on Spectrum and Transfer. */
  micAverage: 'off' | 'avg' | 'spread' | 'only';
  /** Workspaces saved by the user (built-in ones live in workspaces.ts), and the last one chosen. */
  workspaces: Workspace[];
  workspace: string;
  /** Desktop app, native audio (ASIO): stream settings. The device is chosen as the input source. */
  nativeAudio: { sampleRate: number; bufferFrames: number; safetyMs: number };
  /** Target curve on the Spectrum and Transfer views: 'off', a built-in target id or `trace:<id>`. */
  targetCurve: string;
  /** ± tolerance band around the target (dB, 0 = none). */
  targetTolerance: number;
  /** Target curve on the Sweep & Room frequency response ('off', a built-in id or `trace:<id>`). */
  roomTargetCurve: string;
  /** The last before/after comparison (trace ids, target, scoring range) and whether the report shows it. */
  compare: CompareSettings | null;
  /** Notes on graphs: saved with the session, shared with remote devices and listed in the report. */
  graphNotes: GraphNote[];
  /** Room for the room-mode calculator (m, s). `known`: the user entered it (the diagnosis then names its modes). */
  room: { L: number; W: number; H: number; rt: number; known: boolean };
  /** Input last used as a loopback reference (for switching back from the internal reference). */
  loopbackInput?: number;
  /** Section shown on the Tools tab. */
  toolsSection: string;
  /** Session details used for saving and for reports. */
  session: { name: string; venue: string; notes: string };
}

export function defaultSettings(): Settings {
  return {
    view: 'transfer',
    theme: 'night',
    simulate: true,
    deviceId: '',
    generator: { type: 'off', level: -18, freq: 1000, outputs: [0, 1], polarity: 1 },
    tfSmoothing: 12,
    rtaSmoothing: 6,
    tfAveraging: 8,
    rtaAveraging: 4,
    rtaFft: 16384,
    lfResolution: 'high',
    rtaStyle: 'line',
    remoteProcessing: 'host',
    graphQuality: 'auto',
    playlist: { order: [], current: null, repeat: 'all', shuffle: false },
    coherenceThreshold: 0.5,
    showCoherence: true,
    spectrumLayout: null,
    transferLayout: null,
    splLayout: null,
    remoteServer: { enabled: false, port: 8520, pin: randomPin(), allowControl: true },
    peakHold: false,
    splWeighting: 'A',
    splTime: 'fast',
    splOffset: 0,
    splCalibrated: false,
    micCal: null,
    mics: [],
    tempC: 20,
    measurements: [{ id: 'm1', name: 'Mic 1', color: PALETTE[0], mic: 0, ref: 1, delay: 0, enabled: true, invert: false }],
    wizardDone: false,
    magRange: [-30, 30],
    rtaRange: [-100, 0],
    splChannel: 0,
    spectrogramRange: [-110, -20],
    spectrogramLayout: 'vertical',
    rtaAverageCurve: 10,
    rtaAverageSmoothing: 6,
    rtaTraceColor: 'auto',
    rtaFillColor: 'auto',
    rtaFillOpacity: 0,
    rtaFillGradient: 'fade',
    rtaPeakMarks: true,
    rtaMotion: 'smooth',
    rtaUpdates: 25,
    themeId: '',
    tourDone: false,
    lastSeenVersion: '',
    autoUpdateCheck: false,
    waterfallView: { yaw: 32, pitch: 24, zoom: 1 },
    watermark: { ...DEFAULT_WATERMARK },
    crossover: JSON.parse(JSON.stringify(DEFAULT_CROSSOVER)),
    eqConsole: 'generic',
    customThemes: [],
    analysisThread: 'worker',
    rtaShowSweeps: true,
    feedbackFinder: false,
    avgCurveShow: true,
    avgCurveColor: 'auto',
    avgCurveWidth: 2,
    powerMode: 'auto',
    showAssistant: true,
    micAverage: 'off',
    workspaces: [],
    workspace: '',
    nativeAudio: { sampleRate: 48000, bufferFrames: 0, safetyMs: 80 },
    targetCurve: 'off',
    targetTolerance: 3,
    roomTargetCurve: 'off',
    compare: null,
    graphNotes: [],
    session: { name: '', venue: '', notes: '' },
    room: { L: 6.5, W: 4.2, H: 2.7, rt: 0.5, known: false },
    toolsSection: 'setup',
  };
}

const KEY = 'cal-analyzer-settings-v1';

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Omit<Partial<Settings>, 'view'> & { view?: string; liveLayout?: unknown };
    // Before v1.1 the Spectrum and Transfer views were a single "Live" view
    if (s.view === 'live' || !s.view) s.view = 'transfer';
    delete s.liveLayout;
    // 1.6.0 put an average curve on the spectrogram (and turned its layout for it); it lives on the spectrum now
    const legacy = s as { spectrogramAverage?: number; spectrogramLayout?: string };
    if (legacy.spectrogramAverage !== undefined) {
      delete legacy.spectrogramAverage;
      legacy.spectrogramLayout = 'vertical';
    }
    for (const m of s.measurements ?? []) {
      const i = LEGACY_PALETTE.indexOf(m.color);
      if (i >= 0) m.color = PALETTE[i];
    }
    // Before 1.9 there was one calibration for everything: it becomes the first mic, on the SPL meter's input
    if (!Array.isArray(s.mics)) {
      s.mics = s.splCalibrated || s.micCal ? [{ id: 'mic1', name: 'Mic 1', channel: s.splChannel ?? 0, micCal: s.micCal ?? null, splOffset: s.splOffset ?? 0, splCalibrated: !!s.splCalibrated }] : [];
    }
    // Before 2.0.2 a measurement used whichever mic was set to its input: it now names that mic
    for (const m of s.measurements ?? []) {
      if (m.micId) continue;
      const mic = s.mics.find((x) => x.channel === m.mic);
      if (mic) m.micId = mic.id;
    }
    return { ...d, ...s, generator: { ...d.generator, ...(s.generator ?? {}) }, remoteServer: { ...d.remoteServer, ...(s.remoteServer ?? {}) }, playlist: { ...d.playlist, ...(s.playlist ?? {}) }, session: { ...d.session, ...(s.session ?? {}) }, room: { ...d.room, ...(s.room ?? {}) }, nativeAudio: { ...d.nativeAudio, ...(s.nativeAudio ?? {}) }, watermark: { ...d.watermark, ...(s.watermark ?? {}) }, waterfallView: { ...d.waterfallView, ...(s.waterfallView ?? {}) }, crossover: { ...d.crossover, ...(s.crossover ?? {}) } } as Settings;
  } catch {
    return d;
  }
}

let saveTimer = 0;
let pending: Settings | null = null;

function writeSettings(): void {
  clearTimeout(saveTimer);
  if (!pending) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    /* storage full or unavailable */
  }
  pending = null;
}

/** Set by replaceSettings: the page is about to reload with new settings, later saves must not overwrite them. */
let replaced = false;

export function saveSettings(s: Settings): void {
  if (replaced) return;
  pending = s;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(writeSettings, 300);
}

/**
 * Store `next` (or nothing: defaults) at once and ignore every later save from this page, which is about to
 * reload (closing detached windows on the way out would otherwise save the old settings again).
 */
export function replaceSettings(next: Settings | null): void {
  clearTimeout(saveTimer);
  pending = null;
  replaced = true;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

// Don't lose the last change when the window closes or reloads within the debounce time
if (typeof window !== 'undefined') window.addEventListener('pagehide', writeSettings);

export function refLabel(ref: number): string {
  return ref === GEN_CHANNEL ? 'Generator (internal)' : `In ${ref + 1}`;
}

/** Six-digit access PIN for remote clients. */
export function randomPin(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, '0');
}
