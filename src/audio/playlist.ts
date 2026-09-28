import type { AudioEngine } from './engine';

/** One song in the music-generator playlist (the file itself is kept in IndexedDB). */
export interface TrackInfo {
  id: string;
  name: string;
  /** Seconds (0 until decoded once). */
  duration: number;
}

export type RepeatMode = 'all' | 'one' | 'off';

/** Playlist state as shown by the UI (and sent to remote devices). */
export interface PlaylistState {
  tracks: TrackInfo[];
  current: string | null;
  /** Position in the current track, seconds. */
  pos: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** A track is being decoded. */
  loading: boolean;
  error: string;
}

export type PlaylistAction =
  | { action: 'select'; id: string }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'remove'; id: string }
  | { action: 'move'; id: string; to: number }
  | { action: 'repeat'; mode: RepeatMode }
  | { action: 'shuffle'; on: boolean }
  | { action: 'seek'; pos: number }
  | { action: 'clear' };

/** Common interface of the local playlist (measurement host) and the remote proxy. */
export interface PlaylistApi {
  state(): PlaylistState;
  act(a: PlaylistAction): void;
  addFiles(files: File[]): Promise<void>;
  /** Listen for changes; returns a function that removes the listener. */
  onChange(fn: () => void): () => void;
}

export const AUDIO_ACCEPT = 'audio/*,.mp3,.wav,.flac,.ogg,.oga,.m4a,.aac,.opus,.webm,.aif,.aiff';

// --- IndexedDB storage ------------------------------------------------------------------------------------

const DB = 'cal-playlist';
const STORE = 'tracks';

interface StoredTrack extends TrackInfo {
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** One shared connection (opening a new one per request would leave connections open). */
function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading or deleting the database: let it, and reconnect next time
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = run(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// --- Decoding ---------------------------------------------------------------------------------------------

/** RMS of a pink-noise generator signal at 0 dBFS setting (sine-peak referenced: −3 dB). */
const TARGET_RMS = Math.SQRT1_2;
/** Keep the peaks of very dynamic tracks from being driven far into the limiter. */
const MAX_GAIN_DB = 24;

/**
 * Decode a file to mono at the engine's sample rate and normalise it so that its RMS level matches the other
 * generator signals at the same level setting (the level slider then means the same for music and noise).
 */
export async function decodeTrack(blob: Blob, sampleRate: number): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const buf = await ctx.decodeAudioData(bytes);
  const n = buf.length;
  const out = new Float32Array(n);
  const chans = buf.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / chans;
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += out[i] * out[i];
  const rms = Math.sqrt(ss / Math.max(1, n));
  const gain = Math.min(TARGET_RMS / Math.max(rms, 1e-6), Math.pow(10, MAX_GAIN_DB / 20));
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}

// --- Local playlist (runs where the audio interface is) -------------------------------------------------

export interface PlaylistPrefs {
  order: string[];
  current: string | null;
  repeat: RepeatMode;
  shuffle: boolean;
}

/**
 * The music generator's playlist on the measurement computer: stores the files, decodes the current track into
 * the audio engine and advances at the end of each song (repeat / shuffle).
 */
export class Playlist implements PlaylistApi {
  tracks: TrackInfo[] = [];
  loading = false;
  error = '';
  private listeners = new Set<() => void>();
  /** Numeric id of the track loaded in the engine (the worklet reports positions by it). */
  private loadedKey = 0;
  private loadedId: string | null = null;
  private loadedFs = 0;
  private nextKey = 1;
  private history: string[] = [];

  constructor(
    private engine: () => AudioEngine,
    readonly prefs: PlaylistPrefs,
    private save: () => void,
  ) {}

  /** Read the stored tracks (call once at startup). */
  async init(): Promise<void> {
    try {
      const all = (await tx<StoredTrack[]>('readonly', (s) => s.getAll() as IDBRequest<StoredTrack[]>)) ?? [];
      const byId = new Map(all.map((t) => [t.id, { id: t.id, name: t.name, duration: t.duration }]));
      const order = this.prefs.order.filter((id) => byId.has(id));
      for (const id of byId.keys()) if (!order.includes(id)) order.push(id);
      this.tracks = order.map((id) => byId.get(id)!);
      this.syncOrder();
      if (this.prefs.current && !byId.has(this.prefs.current)) this.prefs.current = this.tracks[0]?.id ?? null;
    } catch {
      this.error = 'This browser cannot store songs (private mode?). Added songs last until the page is closed.';
    }
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private syncOrder(): void {
    this.prefs.order = this.tracks.map((t) => t.id);
    this.save();
  }

  state(): PlaylistState {
    const e = this.engine();
    const mp = e.musicPos;
    const pos = mp && mp.id === this.loadedKey && this.loadedFs ? mp.pos / this.loadedFs : 0;
    return { tracks: this.tracks, current: this.prefs.current, pos, repeat: this.prefs.repeat, shuffle: this.prefs.shuffle, loading: this.loading, error: this.error };
  }

  private memory = new Map<string, Blob>();

  async addFiles(files: File[]): Promise<void> {
    const added: TrackInfo[] = [];
    for (const f of files) {
      if (!/^audio\//.test(f.type) && !/\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm|aiff?)$/i.test(f.name)) continue;
      const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const t: TrackInfo = { id, name: f.name.replace(/\.[^.]+$/, ''), duration: 0 };
      try {
        await tx('readwrite', (s) => s.put({ ...t, blob: f } satisfies StoredTrack));
      } catch {
        this.memory.set(id, f);
      }
      this.tracks.push(t);
      added.push(t);
    }
    if (!added.length) {
      this.error = 'No audio files found. Use MP3, WAV, FLAC, OGG or M4A files.';
      this.emit();
      return;
    }
    this.error = '';
    if (!this.prefs.current) this.prefs.current = added[0].id;
    this.syncOrder();
    this.emit();
  }

  private async blobOf(id: string): Promise<Blob | null> {
    const mem = this.memory.get(id);
    if (mem) return mem;
    try {
      const t = await tx<StoredTrack | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredTrack | undefined>);
      return t?.blob ?? null;
    } catch {
      return null;
    }
  }

  /** Make sure the current track is loaded in the engine (after a start, a track change or a sample-rate change). */
  async ensureLoaded(startAt = 0): Promise<void> {
    const e = this.engine();
    const id = this.prefs.current;
    if (!e.running || !id || this.loading) return;
    if (this.loadedId === id && this.loadedFs === e.sampleRate && e.musicPos?.id === this.loadedKey) return;
    this.loading = true;
    this.emit();
    try {
      const blob = await this.blobOf(id);
      if (!blob) throw new Error('The song file is missing');
      const fs = e.sampleRate;
      const data = await decodeTrack(blob, fs);
      const t = this.tracks.find((x) => x.id === id);
      if (t && !t.duration) t.duration = data.length / fs;
      // The selection may have changed while decoding: that song is loaded right after (below)
      if (this.prefs.current !== id) return;
      const key = this.nextKey++;
      this.engine().loadMusic(key, data, Math.round(startAt * fs));
      this.loadedKey = key;
      this.loadedId = id;
      this.loadedFs = fs;
      this.error = '';
    } catch (err) {
      this.error = `Could not play this song: ${(err as Error).message || 'unsupported format'}`;
    } finally {
      this.loading = false;
      this.emit();
      if (this.prefs.current && this.prefs.current !== this.loadedId && !this.error) queueMicrotask(() => this.ensureLoaded());
    }
  }

  /** The engine reports the end of the loaded track. */
  ended(key: number): void {
    if (key !== this.loadedKey) return;
    if (this.prefs.repeat === 'one') {
      this.engine().seekMusic(0);
      return;
    }
    const next = this.pickNext();
    if (next === null) return; // end of the playlist without repeat: stays silent at the end
    if (next === this.prefs.current) {
      this.engine().seekMusic(0);
      return;
    }
    this.select(next);
  }

  private pickNext(): string | null {
    const ids = this.tracks.map((t) => t.id);
    if (!ids.length) return null;
    const cur = this.prefs.current ? ids.indexOf(this.prefs.current) : -1;
    if (this.prefs.shuffle && ids.length > 1) {
      const others = ids.filter((id) => id !== this.prefs.current);
      return others[Math.floor(Math.random() * others.length)];
    }
    if (cur + 1 < ids.length) return ids[cur + 1];
    return this.prefs.repeat === 'all' ? ids[0] : null;
  }

  private select(id: string): void {
    if (this.prefs.current && this.prefs.current !== id) this.history.push(this.prefs.current);
    if (this.history.length > 50) this.history.shift();
    this.prefs.current = id;
    this.save();
    this.loadedId = null;
    this.emit();
    this.ensureLoaded();
  }

  act(a: PlaylistAction): void {
    const ids = this.tracks.map((t) => t.id);
    switch (a.action) {
      case 'select':
        if (ids.includes(a.id)) this.select(a.id);
        break;
      case 'next': {
        const n = this.pickNext() ?? ids[0];
        if (n) this.select(n);
        break;
      }
      case 'prev': {
        // Like a music player: restart the song unless it only just started
        if (this.state().pos > 3) {
          this.engine().seekMusic(0);
          break;
        }
        const back = this.prefs.shuffle ? this.history.pop() : undefined;
        const cur = this.prefs.current ? ids.indexOf(this.prefs.current) : 0;
        const p = back ?? ids[(cur - 1 + ids.length) % ids.length];
        if (p) {
          this.prefs.current = null; // don't push the current song into the history when going back
          this.select(p);
        }
        break;
      }
      case 'remove': {
        this.tracks = this.tracks.filter((t) => t.id !== a.id);
        this.memory.delete(a.id);
        tx('readwrite', (s) => s.delete(a.id)).catch(() => undefined);
        if (this.prefs.current === a.id) {
          const next = this.tracks[Math.min(Math.max(0, ids.indexOf(a.id)), this.tracks.length - 1)]?.id ?? null;
          this.prefs.current = next;
          this.loadedId = null;
          if (next) this.ensureLoaded();
          else this.engine().loadMusic(0, null);
        }
        this.syncOrder();
        break;
      }
      case 'move': {
        const i = ids.indexOf(a.id);
        if (i < 0) break;
        const [t] = this.tracks.splice(i, 1);
        this.tracks.splice(Math.max(0, Math.min(a.to, this.tracks.length)), 0, t);
        this.syncOrder();
        break;
      }
      case 'repeat':
        this.prefs.repeat = a.mode;
        this.save();
        break;
      case 'shuffle':
        this.prefs.shuffle = a.on;
        this.save();
        break;
      case 'seek':
        if (this.loadedFs) this.engine().seekMusic(a.pos * this.loadedFs);
        break;
      case 'clear':
        for (const t of this.tracks) tx('readwrite', (s) => s.delete(t.id)).catch(() => undefined);
        this.tracks = [];
        this.memory.clear();
        this.prefs.current = null;
        this.loadedId = null;
        this.engine().loadMusic(0, null);
        this.syncOrder();
        break;
    }
    this.emit();
  }
}

/** Remote devices: shows the host's playlist and sends actions and uploads to it. */
export class RemotePlaylist implements PlaylistApi {
  private st: PlaylistState = { tracks: [], current: null, pos: 0, repeat: 'all', shuffle: false, loading: false, error: '' };
  private listeners = new Set<() => void>();
  private posAt = 0;
  uploading = 0;

  constructor(
    private send: (a: PlaylistAction) => boolean,
    private upload: (file: File) => Promise<boolean>,
    private playing: () => boolean,
  ) {}

  /** New state from the host's status. */
  update(st: PlaylistState): void {
    const changed = JSON.stringify({ ...st, pos: 0 }) !== JSON.stringify({ ...this.st, pos: 0 });
    this.st = st;
    this.posAt = performance.now();
    if (changed) for (const l of this.listeners) l();
  }

  state(): PlaylistState {
    // Interpolate the position between status updates while the song plays
    const extra = this.playing() ? (performance.now() - this.posAt) / 1000 : 0;
    const cur = this.st.tracks.find((t) => t.id === this.st.current);
    return { ...this.st, pos: Math.min(this.st.pos + extra, cur?.duration || Infinity) };
  }

  act(a: PlaylistAction): void {
    this.send(a);
  }

  async addFiles(files: File[]): Promise<void> {
    for (const f of files) {
      this.uploading++;
      for (const l of this.listeners) l();
      await this.upload(f);
      this.uploading--;
    }
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
