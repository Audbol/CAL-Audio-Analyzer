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

export type ViewId = 'spectrum' | 'transfer' | 'spectrogram' | 'impulse' | 'room' | 'eq' | 'spl' | 'tools';

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

export interface MeasurementConfig {
  id: string;
  name: string;
  color: string;
  /** Input channel index for the measurement microphone. */
  mic: number;
  /** Input channel index for the reference, or GEN_CHANNEL for the internal generator reference. */
  ref: number;
  /** Delay applied to the reference, in samples. */
  delay: number;
  enabled: boolean;
  invert: boolean;
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
  remoteServer: RemoteServerSettings;
  peakHold: boolean;
  splWeighting: Weighting;
  splTime: 'fast' | 'slow';
  /** dB to add to dBFS readings to get dB SPL (from calibration). 0 → uncalibrated dBFS. */
  splOffset: number;
  splCalibrated: boolean;
  micCal: MicCalibration | null;
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
}

export function defaultSettings(): Settings {
  return {
    view: 'transfer',
    theme: 'night',
    simulate: true,
    deviceId: '',
    generator: { type: 'off', level: -18, freq: 1000, outputs: [0, 1], polarity: 1 },
    tfSmoothing: 24,
    rtaSmoothing: 3,
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
    remoteServer: { enabled: false, port: 8520, pin: randomPin(), allowControl: true },
    peakHold: false,
    splWeighting: 'A',
    splTime: 'fast',
    splOffset: 0,
    splCalibrated: false,
    micCal: null,
    tempC: 20,
    measurements: [{ id: 'm1', name: 'Mic 1', color: PALETTE[0], mic: 0, ref: 1, delay: 0, enabled: true, invert: false }],
    wizardDone: false,
    magRange: [-30, 18],
    rtaRange: [-110, 0],
    splChannel: 0,
    spectrogramRange: [-110, -20],
    spectrogramLayout: 'vertical',
    rtaAverageCurve: 10,
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
    return { ...d, ...s, generator: { ...d.generator, ...(s.generator ?? {}) }, remoteServer: { ...d.remoteServer, ...(s.remoteServer ?? {}) }, playlist: { ...d.playlist, ...(s.playlist ?? {}) } } as Settings;
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

export function saveSettings(s: Settings): void {
  pending = s;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(writeSettings, 300);
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
