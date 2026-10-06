/**
 * The native audio APIs of the desktop app (see native/src/cal_audio.cpp) and how the app names them: ASIO on
 * Windows, Core Audio on macOS, JACK (also PipeWire's JACK layer) and ALSA on Linux, and the virtual test device.
 */
export interface NativeApiInfo {
  /** Before a device name in the source menu and the status, e.g. "ASIO: Fireface UCX". */
  prefix: string;
  /** The source menu's group for its devices. */
  group: string;
  /** Shown when it has no devices. */
  none: string;
  /** The driver has its own settings window (ASIO). */
  controlPanel: boolean;
  /** The sample rate and buffer size are the audio server's (JACK / PipeWire), not the app's. */
  serverFormat: boolean;
}

const APIS: Record<string, NativeApiInfo> = {
  asio: { prefix: 'ASIO', group: 'ASIO (low latency, all channels)', none: 'No ASIO driver installed', controlPanel: true, serverFormat: false },
  core: { prefix: 'Core Audio', group: 'Core Audio (all channels)', none: 'No audio devices found', controlPanel: false, serverFormat: false },
  jack: { prefix: 'JACK', group: 'JACK / PipeWire (low latency, all channels)', none: 'No JACK or PipeWire server running', controlPanel: false, serverFormat: true },
  alsa: { prefix: 'ALSA', group: 'ALSA (direct to the interface)', none: 'No ALSA devices free', controlPanel: false, serverFormat: false },
  test: { prefix: '', group: 'Virtual test interface', none: 'No devices', controlPanel: false, serverFormat: false },
};

export function nativeApi(api: string): NativeApiInfo {
  return APIS[api] ?? { prefix: api.toUpperCase(), group: api.toUpperCase(), none: 'No devices', controlPanel: false, serverFormat: false };
}

/** A native device as the source menu and the status name it: "Core Audio: Scarlett 4i4". */
export function nativeDeviceLabel(api: string, name: string): string {
  const p = nativeApi(api).prefix;
  return p ? `${p}: ${name}` : name;
}
