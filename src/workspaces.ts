import type { App } from './app';
import type { Settings, ViewId } from './state';
import type { DockLayout } from './ui/dock';
import type { SpectrumView } from './views/spectrum';
import type { DockedView } from './views/docked';

/** Settings a workspace sets (display and analysis; not devices, calibration or remote access). */
export const WORKSPACE_KEYS = [
  'rtaStyle',
  'rtaSmoothing',
  'rtaFft',
  'rtaAveraging',
  'tfSmoothing',
  'tfAveraging',
  'lfResolution',
  'rtaAverageCurve',
  'rtaAverageSmoothing',
  'micAverage',
  'targetCurve',
  'targetTolerance',
  'showCoherence',
  'peakHold',
  'splWeighting',
  'splTime',
] as const;
export type WorkspaceKey = (typeof WORKSPACE_KEYS)[number];

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  /** Tab to open. */
  view: ViewId;
  settings: Partial<Pick<Settings, WorkspaceKey>>;
  /** Panel arrangements of the Spectrum and Transfer tabs (saved workspaces). */
  layouts?: { spectrumLayout?: DockLayout | null; transferLayout?: DockLayout | null };
}

/** Ready-made workspaces for common jobs. */
export const BUILTIN_WORKSPACES: Workspace[] = [
  {
    id: 'live-mix',
    name: 'Live mix / tonal balance',
    description: 'Spectrum with a smooth 10 s average against the house curve',
    view: 'spectrum',
    settings: { rtaStyle: 'line', rtaSmoothing: 6, rtaFft: 16384, rtaAveraging: 4, rtaAverageCurve: 10, rtaAverageSmoothing: 6, targetCurve: 'house', targetTolerance: 3, peakHold: false, micAverage: 'off' },
  },
  {
    id: 'system-tuning',
    name: 'System tuning',
    description: 'Transfer function with coherence, several mics averaged, house target',
    view: 'transfer',
    settings: { tfSmoothing: 12, tfAveraging: 16, showCoherence: true, lfResolution: 'high', micAverage: 'spread', targetCurve: 'house', targetTolerance: 3 },
  },
  {
    id: 'sub-align',
    name: 'Sub alignment',
    description: 'Best bass resolution, the Align tab',
    view: 'align',
    settings: { tfSmoothing: 12, tfAveraging: 16, lfResolution: 'max', showCoherence: true, micAverage: 'off' },
  },
  {
    id: 'voice',
    name: 'Voice system',
    description: 'Transfer function against a gently falling target, third-octave spectrum',
    view: 'transfer',
    settings: { tfSmoothing: 6, tfAveraging: 16, rtaSmoothing: 3, rtaStyle: 'bars', targetCurve: 'tilt3', targetTolerance: 3, showCoherence: true, splWeighting: 'A' },
  },
  {
    id: 'room-survey',
    name: 'Room survey',
    description: 'Sweeps, reverberation and room modes',
    view: 'room',
    settings: { lfResolution: 'max', rtaSmoothing: 3, rtaStyle: 'bars' },
  },
  {
    id: 'noise',
    name: 'Noise monitoring',
    description: 'SPL meter and noise log, A-weighted',
    view: 'spl',
    settings: { splWeighting: 'A', splTime: 'fast', rtaSmoothing: 3, rtaStyle: 'bars' },
  },
];

export function allWorkspaces(s: Settings): Workspace[] {
  return [...BUILTIN_WORKSPACES, ...s.workspaces];
}

/** The current setup as a workspace. */
export function captureWorkspace(app: App, name: string): Workspace {
  const s = app.settings;
  const settings: Record<string, unknown> = {};
  for (const k of WORKSPACE_KEYS) settings[k] = s[k];
  return {
    id: `ws${Date.now().toString(36)}`,
    name,
    view: s.view,
    settings: JSON.parse(JSON.stringify(settings)),
    layouts: JSON.parse(JSON.stringify({ spectrumLayout: s.spectrumLayout, transferLayout: s.transferLayout })),
  };
}

export function applyWorkspace(app: App, ws: Workspace): void {
  const s = app.settings;
  const rec = s as unknown as Record<string, unknown>;
  for (const k of WORKSPACE_KEYS) if (ws.settings[k] !== undefined) rec[k] = JSON.parse(JSON.stringify(ws.settings[k]));
  // A target trace that no longer exists falls back to none
  if (s.targetCurve.startsWith('trace:') && !app.traces.traces.some((t) => `trace:${t.id}` === s.targetCurve)) s.targetCurve = 'off';
  s.workspace = ws.id;
  app.spl.setWeighting(s.splWeighting);
  for (const m of app.measurements) m.resetAverage();
  app.applyAnalysisSettings();
  for (const key of ['spectrumLayout', 'transferLayout'] as const) {
    const l = ws.layouts?.[key];
    if (!l) continue;
    s[key] = JSON.parse(JSON.stringify(l));
    (app.views.find((v) => v.id === (key === 'spectrumLayout' ? 'spectrum' : 'transfer')) as unknown as DockedView).applyLayout(l);
  }
  (app.views.find((v) => v.id === 'spectrum') as unknown as SpectrumView).setStyle(s.rtaStyle);
  for (const id of ['spectrum', 'transfer'] as const) (app.views.find((v) => v.id === id) as unknown as DockedView).syncSettingChips();
  app.syncSettingControls();
  for (const v of app.views) v.invalidate?.();
  app.save();
  app.setView(ws.view);
}
