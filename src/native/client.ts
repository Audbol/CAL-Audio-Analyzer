/**
 * The app page's connection to the desktop app's native audio host (ASIO): device list, opening a stream,
 * and the stream of captured blocks, which arrive as the same events the browser audio worklet sends.
 */
import { desktopBridge } from '../remote/host';
import type { ProcessorEvent, ProcessorMessage } from '../audio/protocol';
import type { NativeDevice, NativeOpenOptions, NativeReply, NativeRequest, NativeStatus, NativeStreamInfo } from './protocol';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;

export class NativeAudio {
  private port: MessagePort | null = null;
  private connecting: Promise<MessagePort> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  apis: string[] = [];
  version = '';
  loadError = '';
  status: NativeStatus | null = null;
  onEvent?: (ev: ProcessorEvent) => void;
  onStatus?: (s: NativeStatus) => void;
  /** The host process went away (crash): the stream is gone. */
  onLost?: (reason: string) => void;
  private static availability: Promise<boolean> | null = null;

  /** Whether this is the desktop app with native audio on this computer. */
  static available(): Promise<boolean> {
    const bridge = desktopBridge()?.nativeAudio;
    if (!bridge) return Promise.resolve(false);
    NativeAudio.availability ??= bridge.available().catch(() => false);
    return NativeAudio.availability;
  }

  constructor() {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      if (e.data === 'cal-native-audio-exit') {
        this.drop('The audio host stopped unexpectedly.');
      }
    });
  }

  private connect(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    if (this.connecting) return this.connecting;
    const bridge = desktopBridge()?.nativeAudio;
    if (!bridge) return Promise.reject(new Error('Native audio is only available in the desktop app'));
    this.connecting = new Promise<MessagePort>((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        this.connecting = null;
        reject(new Error('The audio host did not respond'));
      }, 8000);
      const onMsg = (e: MessageEvent) => {
        if (e.source !== window || e.data !== 'cal-native-audio-port' || !e.ports[0]) return;
        window.removeEventListener('message', onMsg);
        const port = e.ports[0];
        port.onmessage = (m: MessageEvent<NativeReply>) => {
          if (m.data.t === 'hello') {
            clearTimeout(timeout);
            this.apis = m.data.apis;
            this.version = m.data.version;
            this.loadError = m.data.error ?? '';
            this.port = port;
            this.connecting = null;
            port.onmessage = (ev: MessageEvent<NativeReply>) => this.onReply(ev.data);
            resolve(port);
          }
        };
        port.start();
      };
      window.addEventListener('message', onMsg);
      bridge.connect();
    });
    return this.connecting;
  }

  private drop(reason: string): void {
    this.port?.close();
    this.port = null;
    this.connecting = null;
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
    this.onLost?.(reason);
  }

  private onReply(m: NativeReply): void {
    switch (m.t) {
      case 'reply': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error || 'Native audio error'));
        return;
      }
      case 'ev':
        this.onEvent?.(m.ev);
        return;
      case 'status':
        this.status = m.status;
        this.onStatus?.(m.status);
        return;
      case 'error':
        console.warn('[native audio]', m.message);
        return;
    }
  }

  private async request<T>(msg: Distribute<NativeRequest & { id: number }>): Promise<T> {
    const port = await this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ ...msg, id });
    });
  }

  async listApis(): Promise<string[]> {
    await this.connect();
    return this.apis;
  }

  devices(api: string): Promise<NativeDevice[]> {
    return this.request<NativeDevice[]>({ t: 'devices', api });
  }

  open(opts: NativeOpenOptions): Promise<NativeStreamInfo> {
    this.status = null;
    return this.request<NativeStreamInfo>({ t: 'open', opts });
  }

  async close(): Promise<void> {
    if (!this.port) return;
    await this.request<void>({ t: 'close' }).catch(() => undefined);
  }

  controlPanel(): Promise<boolean> {
    return this.request<boolean>({ t: 'panel' });
  }

  setSafety(ms: number): void {
    this.port?.postMessage({ t: 'safety', ms } satisfies NativeRequest);
  }

  send(m: ProcessorMessage): void {
    // Music data is copied (not transferred) across the process boundary
    this.port?.postMessage({ t: 'msg', m } satisfies NativeRequest);
  }
}
