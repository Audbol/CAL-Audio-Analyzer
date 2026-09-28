import type { Smoothing } from './dsp/freq';
import type { Averaging } from './dsp/transfer';
import type { Weighting } from './dsp/weighting';
import type { GeneratorConfig } from './audio/protocol';
import type { MicCalibration } from './dsp/calibration';
import { GEN_CHANNEL } from './audio/engine';

import { PALETTE } from './ui/theme';
export { PALETTE };

/** Colours used by earlier versions; stored measurements using them are moved to the current palette. */
const LEGACY_PALETTE = ['#2dd4bf', '#f59e0b', '#a78bfa', '#f472b6', '#60a5fa', '#a3e635', '#fb7185', '#fbbf24', '#22d3ee', '#e879f9'];

export type ViewId = 'live' | 'spectrogram' | 'impulse' | 'room' | 'eq' | 'spl' | 'tools';

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
  simulate: boolean;
  deviceId: string;
  generator: GeneratorConfig;
  tfSmoothing: Smoothing;
  rtaSmoothing: Smoothing;
  tfAveraging: Averaging;
  rtaAveraging: Averaging;
  rtaFft: number;
  coherenceThreshold: number;
  showCoherence: boolean;
  showRta: boolean;
  showMag: boolean;
  showPhase: boolean;
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
}

export function defaultSettings(): Settings {
  return {
    view: 'live',
    simulate: true,
    deviceId: '',
    generator: { type: 'off', level: -18, freq: 1000, outputs: [0, 1], polarity: 1 },
    tfSmoothing: 24,
    rtaSmoothing: 3,
    tfAveraging: 8,
    rtaAveraging: 4,
    rtaFft: 16384,
    coherenceThreshold: 0.5,
    showCoherence: true,
    showRta: true,
    showMag: true,
    showPhase: true,
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
  };
}

const KEY = 'cal-analyzer-settings-v1';

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    for (const m of s.measurements ?? []) {
      const i = LEGACY_PALETTE.indexOf(m.color);
      if (i >= 0) m.color = PALETTE[i];
    }
    return { ...d, ...s, generator: { ...d.generator, ...(s.generator ?? {}) } };
  } catch {
    return d;
  }
}

let saveTimer = 0;
export function saveSettings(s: Settings): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage full or unavailable */
    }
  }, 300);
}

export function refLabel(ref: number): string {
  return ref === GEN_CHANNEL ? 'Generator (internal)' : `In ${ref + 1}`;
}
