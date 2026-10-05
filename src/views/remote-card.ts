import type { App } from '../app';
import { h, icon, clear } from '../ui/dom';
import { randomPin } from '../state';
import type { RemoteEngine } from '../remote/client';

/**
 * Tools → Remote access: turns the built-in server on/off, shows the addresses, PIN and QR codes remote
 * devices need, lists connected clients and explains how to connect and troubleshoot.
 */
export class RemoteCard {
  readonly el = h('section', { class: 'tool-card wide remote-card' });
  private qrCache = new Map<string, string>();

  constructor(private app: App) {}

  render(): void {
    clear(this.el);
    this.el.append(h('h4', {}, icon('wifi', 15), ' Remote access · control and view from phones, tablets and other computers'));
    if (this.app.remote) return this.renderClient();
    const mode = this.app.serverMode;
    if (!mode) return this.renderUnavailable();
    const link = this.app.hostLink;
    if (!link?.connected || !link.info) return mode === 'desktop' ? this.renderOff() : this.renderCliWaiting();
    this.renderOn(mode);
  }

  // ---------------------------------------------------------------------------------------------------------

  private renderUnavailable(): void {
    this.el.append(
      h('p', { class: 'small' }, 'Remote access lets any browser on your network (phone, tablet, laptop) see every measurement and meter live and control the generator and sweeps, while the audio interface stays connected to this computer.'),
      h(
        'p',
        { class: 'dim small' },
        'It needs the built-in server of the ',
        h('b', {}, 'CAL Audio Analyzer desktop app'),
        ' (Tools → Remote access → Turn on). When running from source in a browser, start the server with ',
        h('code', {}, 'npm run serve'),
        ' and open ',
        h('code', {}, 'http://localhost:8520/host'),
        ' on this computer instead.',
      ),
    );
  }

  private renderCliWaiting(): void {
    this.el.append(h('p', { class: 'small' }, 'Connecting to the remote-access server started with npm run serve…'));
  }

  /** `live` = the running server's actual values (they can differ from saved settings for the CLI server). */
  private settingsRow(running: boolean, live?: { port: number; pin: string; allowControl: boolean; showPort: boolean }): HTMLElement {
    const rs = this.app.settings.remoteServer;
    const port = h('input', { type: 'number', class: 'num', value: String(live?.port ?? rs.port), min: '1024', max: '65535', disabled: running });
    port.addEventListener('change', () => {
      const v = Math.round(+port.value);
      if (v >= 1024 && v <= 65535) {
        rs.port = v;
        this.app.save();
      } else port.value = String(rs.port);
    });
    const pin = h('input', { class: 'num pin-field', value: live?.pin ?? rs.pin, maxlength: '12', placeholder: 'none', title: 'Access PIN remote devices must enter. Leave empty for open access (not recommended).' });
    pin.addEventListener('change', () => {
      rs.pin = pin.value.replace(/\s+/g, '');
      this.app.save();
      this.app.hostLink?.configure({ pin: rs.pin });
      this.render();
    });
    const control = h('input', { type: 'checkbox', checked: live?.allowControl ?? rs.allowControl });
    control.addEventListener('change', () => {
      rs.allowControl = control.checked;
      this.app.save();
      this.app.hostLink?.configure({ allowControl: rs.allowControl });
    });
    return h(
      'div',
      { class: 'row gap8 wrap' },
      live && !live.showPort ? null : h('label', { class: 'inline' }, 'Port', port),
      h('label', { class: 'inline' }, 'PIN', pin),
      h(
        'button',
        {
          class: 'btn small ghost',
          title: 'Generate a new random PIN',
          onclick: () => {
            rs.pin = randomPin();
            this.app.save();
            this.app.hostLink?.configure({ pin: rs.pin });
            this.render();
          },
        },
        icon('reset', 13),
        'New PIN',
      ),
      h('label', { class: 'check', title: 'Remote devices may switch the generator, run sweeps and start audio. Turn off for view-only access.' }, control, 'Allow remote control of generator & sweeps'),
    );
  }

  private renderOff(): void {
    const btn = h('button', { class: 'btn accent' }, icon('wifi', 15), 'Turn on remote access');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await this.app.startServer().catch(() => undefined);
      this.render();
    });
    this.el.append(
      h('p', { class: 'small' }, 'Start the built-in server to use this analyzer from any browser on the same network: walk the room with a tablet while the audio interface stays on this computer. Remote devices see every tab and meter live and, if allowed, can control the generator and run sweeps.'),
      this.settingsRow(false),
      h('div', { class: 'row gap8' }, btn, h('span', { class: 'dim small' }, 'Remote access turns on automatically next time the app starts.')),
    );
  }

  private renderOn(mode: 'desktop' | 'cli'): void {
    const link = this.app.hostLink!;
    const info = link.info!;
    const rs = this.app.settings.remoteServer;
    const pin = info.pin;
    const urls = info.urls;
    const primary = urls[0]?.url;
    const withPin = (u: string) => (pin ? `${u}?pin=${encodeURIComponent(pin)}` : u);

    const copy = (text: string) =>
      h(
        'button',
        {
          class: 'btn tiny ghost',
          title: 'Copy',
          onclick: () => navigator.clipboard?.writeText(text).then(() => this.app.toast('Copied', 'ok'), () => this.app.toast('Copy not available', 'warn')),
        },
        icon('download', 12),
        'Copy',
      );
    const status = h(
      'div',
      { class: 'remote-status' },
      h('span', { class: 'dot on' }),
      h('b', {}, 'Remote access is on'),
      h('span', { class: 'dim' }, ` · port ${info.port} · ${info.clients.length} device${info.clients.length === 1 ? '' : 's'} connected`),
      h('div', { class: 'spacer' }),
      mode === 'desktop' ? h('button', { class: 'btn small', onclick: async () => { await this.app.stopServer(); this.render(); } }, icon('stop', 13), 'Turn off') : h('span', { class: 'dim small' }, 'Stop the server with Ctrl+C in its terminal'),
    );

    const addr = h(
      'div',
      { class: 'remote-addrs' },
      h('div', { class: 'remote-label' }, 'Open this address on the remote device'),
      ...(urls.length
        ? urls.map((u, i) => h('div', { class: `remote-url${i === 0 ? ' primary' : ''}` }, h('code', {}, u.url), h('span', { class: 'dim small' }, u.iface), copy(u.url)))
        : [h('p', { class: 'warn-text small' }, 'This computer is not connected to a network. Connect it to Wi-Fi or Ethernet (or create a hotspot) and the addresses will appear here.')]),
      h('div', { class: 'remote-url' }, h('code', {}, `http://${info.hostname}.local:${info.port}/`), h('span', { class: 'dim small' }, 'by name (works on most Apple and recent Windows devices)')),
      h('div', { class: 'remote-label' }, 'Access PIN'),
      h('div', { class: 'remote-pin' }, pin ? pin.replace(/(\d{3})(?=\d)/g, '$1 ') : 'none — anyone on the network can connect'),
    );

    const qrBox = h('div', { class: 'remote-qr' });
    if (primary) {
      const img = h('img', { alt: 'QR code for connecting a phone or tablet', width: '188', height: '188' });
      this.qr(withPin(primary)).then((src) => (img.src = src));
      qrBox.append(img, h('div', { class: 'dim small' }, 'Scan with the phone / tablet camera — the PIN is included'));
    }

    const clients = h(
      'div',
      { class: 'remote-clients' },
      h('div', { class: 'remote-label' }, 'Connected devices'),
      ...(info.clients.length
        ? info.clients.map((c) => h('div', { class: 'remote-client' }, icon('wifi', 12), h('b', {}, c.name), h('span', { class: 'dim small' }, `${c.address} · since ${new Date(c.since).toLocaleTimeString()}`)))
        : [h('div', { class: 'dim small' }, 'None yet.')]),
    );

    const steps = h(
      'div',
      { class: 'remote-help' },
      h('div', { class: 'remote-label' }, 'How to connect'),
      h(
        'ol',
        { class: 'steps small' },
        h('li', {}, 'Connect the phone, tablet or computer to the ', h('b', {}, 'same network'), ' as this computer (same Wi-Fi, or a hotspot from this computer).'),
        h('li', {}, 'Scan the QR code, or open the address above in Chrome, Safari, Edge or Firefox.'),
        h('li', {}, 'Enter the PIN if asked. The full analyzer opens with live data from this computer.'),
        h('li', {}, 'Keep this app running — audio is captured and played here; remote devices receive the live measurement stream (about 0.2 MB/s per input channel).'),
      ),
      h('div', { class: 'remote-label' }, 'If it does not connect'),
      h(
        'ul',
        { class: 'steps small dim' },
        h('li', {}, h('b', {}, 'Windows firewall: '), 'when Windows asks, allow CAL Audio Analyzer on ', h('i', {}, 'Private networks'), '. If you missed it: Windows Security → Firewall & network protection → Allow an app through firewall.'),
        h('li', {}, h('b', {}, 'macOS: '), 'allow incoming connections when prompted (System Settings → Network → Firewall).'),
        h('li', {}, h('b', {}, 'Guest / venue Wi-Fi '), 'often blocks devices from seeing each other ("client isolation"). Use a private network, a travel router, or this computer’s mobile hotspot.'),
        h('li', {}, 'Make sure the Windows network profile is ', h('b', {}, 'Private'), ', not Public, and that no VPN is active on either device.'),
        h('li', {}, `If port ${info.port} is blocked or busy, turn remote access off, choose another port (e.g. 8080) and turn it on again.`),
      ),
    );

    this.el.append(
      status,
      h('div', { class: 'remote-grid' }, h('div', { class: 'remote-main' }, addr, clients), qrBox, steps),
      h('div', { class: 'remote-settings' }, h('div', { class: 'remote-label' }, 'Settings'), this.settingsRow(true, { port: info.port, pin: info.pin, allowControl: info.allowControl, showPort: mode === 'desktop' }), mode === 'desktop' ? h('div', { class: 'dim small' }, `Port changes apply the next time remote access is turned on. PIN and control changes apply immediately.${rs.pin ? '' : ' Without a PIN anyone on the network can control the generator.'}`) : null),
    );
  }

  private renderClient(): void {
    const eng = this.app.engine as RemoteEngine;
    const st = eng.status;
    const connected = eng.state === 'connected';
    this.el.append(
      h('div', { class: 'remote-status' }, h('span', { class: `dot ${connected ? 'on' : ''}` }), h('b', {}, connected ? 'Connected to the measurement host' : 'Not connected'), h('span', { class: 'dim' }, ` · ${location.host}`)),
      h(
        'p',
        { class: 'small' },
        connected && st
          ? `Receiving live audio from ${st.deviceLabel} (${(st.sampleRate / 1000).toFixed(1)} kHz, ${st.channels} input${st.channels === 1 ? '' : 's'}). ${this.app.hostProcessing ? 'Spectrum and transfer function are computed by the host (Display & performance below); meters and the other views run on this device.' : 'All views and meters are computed on this device.'} ${eng.allowControl ? 'You can control the generator and run sweeps; they play on the host.' : 'The host allows viewing only.'}`
          : eng.lastError || 'Press Connect in the top bar.',
      ),
      h('p', { class: 'dim small' }, 'Sweeps, traces, calibration, microphone correction and the measurement channel setup are shared through the host with every device. View settings (tabs, smoothing, zoom, colour scheme) are stored on this device.'),
      h('div', { class: 'row gap8' }, connected ? h('button', { class: 'btn small', onclick: () => this.app.toggleEngine().then(() => this.render()) }, icon('stop', 13), 'Disconnect') : h('button', { class: 'btn small accent', onclick: () => this.app.start() }, icon('wifi', 13), 'Connect')),
    );
  }

  private async qr(text: string): Promise<string> {
    const hit = this.qrCache.get(text);
    if (hit) return hit;
    // Always black on white: phone cameras scan dark-on-light codes most reliably
    // Loaded on first use: most sessions never show a QR code
    const { default: QRCode } = await import('qrcode');
    const url = await QRCode.toDataURL(text, { margin: 1, width: 376, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    this.qrCache.set(text, url);
    return url;
  }
}
