import type { App } from './app';
import type { Settings } from './state';
import type { Trace } from './traces';
import type { SharedSettings, SweepMeta } from './remote/protocol';
import type { EqView, EqSnapshot } from './views/eq';
import type { AlignView, AlignSnapshot } from './views/align';
import type { RoomView } from './views/room';
import type { LogFile } from './logger';

export const SESSION_FORMAT = 'cal-session';
export const SESSION_VERSION = 1;

/** Analysis and display settings a session carries (device, layout and remote-access settings stay per computer). */
const SESSION_SETTINGS = ['tfSmoothing', 'rtaSmoothing', 'tfAveraging', 'rtaAveraging', 'rtaFft', 'lfResolution', 'coherenceThreshold', 'rtaAverageCurve', 'rtaAverageSmoothing', 'micAverage', 'targetCurve', 'roomTargetCurve', 'targetTolerance'] as const;
type SessionSettingKey = (typeof SESSION_SETTINGS)[number];

/** A saved session: everything measured and set up for one job, as one JSON file. */
export interface SessionFile {
  format: typeof SESSION_FORMAT;
  version: number;
  app: string;
  saved: string;
  session: Settings['session'];
  shared: SharedSettings;
  settings: Partial<Pick<Settings, SessionSettingKey>>;
  traces: Trace[];
  /** Sweep: its metadata and impulse response (little-endian float32, base64). */
  sweep: { meta: SweepMeta; ir: string } | null;
  eq: EqSnapshot | null;
  align: AlignSnapshot | null;
  /** Noise log (SPL view), if anything was logged. */
  log?: LogFile | null;
}

function view<T>(app: App, id: string): T {
  return app.views.find((v) => v.id === id) as unknown as T;
}

export function buildSession(app: App): SessionFile {
  const s = app.settings;
  const sweep = view<RoomView>(app, 'room').sweepState();
  const settings: Record<string, unknown> = {};
  for (const k of SESSION_SETTINGS) settings[k] = s[k];
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    app: `CAL Audio Analyzer ${__APP_VERSION__}`,
    saved: new Date().toISOString(),
    session: { ...s.session },
    shared: JSON.parse(JSON.stringify({ splOffset: s.splOffset, splCalibrated: s.splCalibrated, micCal: s.micCal, tempC: s.tempC, measurements: s.measurements, mics: s.mics })),
    settings: settings as SessionFile['settings'],
    traces: JSON.parse(JSON.stringify(app.traces.traces)),
    sweep: sweep ? { meta: sweep.meta, ir: encodeFloat32(sweep.ir) } : null,
    eq: view<EqView>(app, 'eq').snapshot(),
    align: view<AlignView>(app, 'align').snapshot(),
    log: app.logger.rows.length ? app.logger.snapshot() : null,
  };
}

/** Check a parsed file and return it as a session, or throw with a readable reason. */
export function parseSession(text: string): SessionFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not a session (it is not valid JSON).');
  }
  const f = data as Partial<SessionFile>;
  if (!f || f.format !== SESSION_FORMAT) throw new Error('This file is not a CAL Audio Analyzer session.');
  if ((f.version ?? 0) > SESSION_VERSION) throw new Error('This session was saved by a newer version of the app. Update the app to open it.');
  if (!Array.isArray(f.traces)) throw new Error('The session file is damaged (no trace list).');
  for (const t of f.traces) if (!t || typeof t.id !== 'string' || !Array.isArray(t.freqs) || !Array.isArray(t.mag)) throw new Error('The session file is damaged (a trace is incomplete).');
  return {
    format: SESSION_FORMAT,
    version: f.version ?? SESSION_VERSION,
    app: f.app ?? '',
    saved: f.saved ?? '',
    session: { name: f.session?.name ?? '', venue: f.session?.venue ?? '', notes: f.session?.notes ?? '' },
    shared: f.shared as SharedSettings,
    settings: f.settings ?? {},
    traces: f.traces,
    sweep: f.sweep ?? null,
    eq: f.eq ?? null,
    align: f.align ?? null,
    log: f.log && Array.isArray(f.log.rows) ? f.log : null,
  };
}

/** Replace the current session with a saved one. */
export function applySession(app: App, f: SessionFile): void {
  const s = app.settings;
  s.session = { ...f.session };
  const rec = s as unknown as Record<string, unknown>;
  for (const k of SESSION_SETTINGS) if (f.settings[k] !== undefined) rec[k] = f.settings[k];
  if (f.shared && Array.isArray(f.shared.measurements) && f.shared.measurements.length) app.applyShared(f.shared);
  app.applyAnalysisSettings();
  app.traces.replaceAll(f.traces);
  view<RoomView>(app, 'room').restoreSweep(f.sweep ? { meta: f.sweep.meta, ir: Float64Array.from(decodeFloat32(f.sweep.ir)) } : null);
  view<EqView>(app, 'eq').restore(f.eq);
  view<AlignView>(app, 'align').restore(f.align);
  if (app.logger.running) app.logger.stop();
  app.logger.load(f.log ?? null);
  app.logger.save();
  app.save();
  app.syncSettingControls();
  for (const v of app.views) v.invalidate?.();
}

export function sessionFileName(s: Settings['session'], ext = 'calsession.json'): string {
  const base = [s.name, s.venue].filter(Boolean).join(' - ') || 'session';
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)} ${stamp}.${ext}`;
}

export function encodeFloat32(a: ArrayLike<number>): string {
  const f = Float32Array.from(a);
  const bytes = new Uint8Array(f.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.length >> 2);
}

/** Offer text as a file download. */
export function downloadText(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
