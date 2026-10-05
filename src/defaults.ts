import { defaultSettings, type Settings } from './state';

/**
 * Resetting the analysis and display settings. The setup stays: inputs and measurements, microphones and their
 * calibrations, devices, remote access, saved workspaces, the session and per-device preferences.
 */
const KEEP = [
  'view',
  'theme',
  'simulate',
  'deviceId',
  'generator',
  'playlist',
  'remoteProcessing',
  'graphQuality',
  'powerMode',
  'showAssistant',
  'compare',
  'graphNotes',
  'analysisThread',
  'themeId',
  'tourDone',
  'customThemes',
  'remoteServer',
  'splOffset',
  'splCalibrated',
  'micCal',
  'mics',
  'tempC',
  'measurements',
  'wizardDone',
  'splChannel',
  'workspaces',
  'nativeAudio',
  'session',
] as const satisfies readonly (keyof Settings)[];

export interface DefaultsProfile {
  id: string;
  label: string;
  description: string;
  settings: Partial<Settings>;
}

export const DEFAULT_PROFILES: DefaultsProfile[] = [
  { id: 'app', label: 'App defaults', description: 'The settings the app starts with', settings: {} },
  {
    id: 'dual-fft',
    label: 'Classic dual-FFT',
    description: 'The conventional live-sound setup: 1/12-octave transfer function with 16 averages and coherence, high-resolution spectrum, ±18 dB magnitude scale, no average or target curve',
    settings: {
      tfSmoothing: 12,
      tfAveraging: 16,
      showCoherence: true,
      coherenceThreshold: 0.4,
      lfResolution: 'high',
      magRange: [-18, 18],
      rtaStyle: 'line',
      rtaSmoothing: 24,
      rtaFft: 16384,
      rtaAveraging: 4,
      rtaAverageCurve: 0,
      targetCurve: 'off',
      roomTargetCurve: 'off',
      micAverage: 'off',
      peakHold: false,
      splWeighting: 'A',
      splTime: 'fast',
    },
  },
];

/** `current` with its analysis and display settings reset to a profile. */
export function resetToProfile(current: Settings, profileId: string): Settings {
  const d = defaultSettings();
  const out = { ...d, ...(DEFAULT_PROFILES.find((p) => p.id === profileId)?.settings ?? {}) } as Settings;
  const rec = out as unknown as Record<string, unknown>;
  for (const k of KEEP) rec[k] = JSON.parse(JSON.stringify(current[k]));
  out.workspace = '';
  return out;
}
