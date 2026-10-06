import type { App } from './app';
import type { Settings, MeasurementConfig } from './state';
import { CUSTOM_PREFIX, type CustomTarget } from './dsp/eq';
import type { CrossoverDesign } from './dsp/crossover';
import type { EqView } from './views/eq';

export const PRESET_FORMAT = 'cal-preset';
export const PRESET_VERSION = 1;

/** Analysis and tuning settings a preset carries, besides the measurements, the EQ console and the crossover. */
const PRESET_SETTINGS = ['tfSmoothing', 'rtaSmoothing', 'tfAveraging', 'rtaAveraging', 'rtaFft', 'lfResolution', 'coherenceThreshold', 'rtaAverageCurve', 'rtaAverageSmoothing', 'micAverage', 'targetCurve', 'roomTargetCurve', 'targetTolerance', 'tempC'] as const;
type PresetSettingKey = (typeof PRESET_SETTINGS)[number];

/**
 * A system preset: the measurement setup for a rig or venue (named measurements with their inputs, references,
 * mics, delays and weights), the analysis and target settings, the EQ console and the crossover. Traces,
 * calibration, devices and the generator stay as they are.
 */
export interface SystemPreset {
  id: string;
  name: string;
  saved: string;
  measurements: MeasurementConfig[];
  settings: Partial<Pick<Settings, PresetSettingKey>>;
  eqConsole: string;
  crossover: CrossoverDesign;
  /** The custom targets it uses, so it works on another computer too. */
  targets: CustomTarget[];
  /** Names of the inventory mics it uses (for information on another computer, where the ids differ). */
  micNames?: Record<string, string>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function buildPreset(app: App, name: string, id = `p${Date.now().toString(36)}`): SystemPreset {
  const s = app.settings;
  const settings: Record<string, unknown> = {};
  for (const k of PRESET_SETTINGS) settings[k] = clone(s[k]);
  const usedTargets = [s.targetCurve, s.roomTargetCurve].filter((t) => t.startsWith(CUSTOM_PREFIX)).map((t) => t.slice(CUSTOM_PREFIX.length));
  const micNames: Record<string, string> = {};
  for (const m of s.measurements) {
    const mic = m.micId ? s.mics.find((x) => x.id === m.micId) : null;
    if (mic) micNames[mic.id] = mic.name;
  }
  return {
    id,
    name: name.trim() || 'Preset',
    saved: new Date().toISOString(),
    measurements: clone(s.measurements),
    settings: settings as SystemPreset['settings'],
    eqConsole: s.eqConsole,
    crossover: clone(s.crossover),
    targets: clone(s.customTargets.filter((t) => usedTargets.includes(t.id))),
    micNames,
  };
}

/** What a preset contains, in a few words (for the list and the confirmation). */
export function presetSummary(p: SystemPreset): string {
  const n = p.measurements.length;
  const names = p.measurements.map((m) => m.name).slice(0, 4).join(', ');
  return `${n} measurement${n === 1 ? '' : 's'} (${names}${n > 4 ? ', …' : ''})`;
}

/** Use a preset: its measurements, analysis, targets, EQ console and crossover. */
export function applyPreset(app: App, p: SystemPreset): void {
  const s = app.settings;
  // Its custom targets join yours (one of the same id is replaced by the preset's)
  if (p.targets.length) {
    s.customTargets = [...s.customTargets.filter((t) => !p.targets.some((x) => x.id === t.id)), ...clone(p.targets)];
    app.targetsChanged();
  }
  const rec = s as unknown as Record<string, unknown>;
  for (const k of PRESET_SETTINGS) if (p.settings[k] !== undefined) rec[k] = clone(p.settings[k]);
  // Mics it names that this computer's inventory doesn't have are left unset (calibration stays with the mics here)
  s.measurements = clone(p.measurements).map((m) => {
    if (m.micId && !s.mics.some((x) => x.id === m.micId)) delete m.micId;
    return m;
  });
  if (p.crossover) s.crossover = { ...s.crossover, ...clone(p.crossover) };
  if (app.engine.running) app.rebuildMeasurements();
  app.syncCal();
  app.applyAnalysisSettings();
  (app.views.find((v) => v.id === 'eq') as unknown as EqView | undefined)?.setProfile(p.eqConsole);
  app.save();
  app.renderMeasurements();
  app.syncSettingControls();
  for (const v of app.views) v.invalidate?.();
}

/** A preset file (one preset), checked; throws with a readable reason. */
export function parsePreset(text: string): SystemPreset {
  let f: Partial<SystemPreset> & { format?: string; version?: number };
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error('not a preset file (not valid JSON)');
  }
  if (!f || f.format !== PRESET_FORMAT) throw new Error('not a CAL Audio Analyzer preset');
  if ((f.version ?? 0) > PRESET_VERSION) throw new Error('saved by a newer version of the app');
  if (!Array.isArray(f.measurements) || !f.measurements.length || f.measurements.some((m) => !m || typeof m.id !== 'string' || typeof m.mic !== 'number')) throw new Error('the preset is damaged (no measurements)');
  return {
    id: `p${Date.now().toString(36)}`,
    name: String(f.name ?? 'Imported preset').slice(0, 60),
    saved: f.saved ?? new Date().toISOString(),
    measurements: f.measurements,
    settings: f.settings ?? {},
    eqConsole: f.eqConsole ?? 'generic',
    crossover: f.crossover as CrossoverDesign,
    targets: Array.isArray(f.targets) ? f.targets : [],
    micNames: f.micNames ?? {},
  };
}

export function presetFile(p: SystemPreset): string {
  return JSON.stringify({ format: PRESET_FORMAT, version: PRESET_VERSION, app: `CAL Audio Analyzer ${__APP_VERSION__}`, ...p }, null, 1);
}
