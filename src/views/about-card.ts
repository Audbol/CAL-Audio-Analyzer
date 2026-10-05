import type { App } from '../app';
import { h, icon } from '../ui/dom';
import { desktopBridge } from '../remote/host';
import { showWhatsNew } from '../ui/whats-new';

export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';
  version: string | null;
  error: string | null;
  percent: number;
  /** Automatic checks are on (they only notify). */
  auto?: boolean;
}

/**
 * Tools → About & data: the version, updates (desktop app) and what's new. Updates never happen on their own:
 * the user checks (or turns on automatic checks, which only notify), downloads and restarts.
 */
export class AboutCard {
  readonly el = h('section', { class: 'tool-card about-card' });
  private status = h('p', { class: 'small', role: 'status' });
  private installBtn: HTMLButtonElement;
  private checkBtn: HTMLButtonElement;
  private downloadBtn: HTMLButtonElement;

  constructor(private readonly app: App) {
    const bridge = desktopBridge()?.updates;
    const s = app.settings;
    this.checkBtn = h('button', { class: 'btn small', dataset: { update: 'check' }, onclick: () => void bridge?.check().then((st) => this.show(st)) }, icon('reset', 14), 'Check for updates');
    this.downloadBtn = h('button', { class: 'btn small accent', dataset: { update: 'download' }, onclick: () => void bridge?.download().then((st) => this.show(st)) }, icon('download', 14), 'Download');
    this.installBtn = h('button', { class: 'btn small accent', dataset: { update: 'install' }, onclick: () => void bridge?.install() }, 'Restart to update');
    const auto = h('input', { type: 'checkbox', checked: s.autoUpdateCheck, dataset: { update: 'auto' } }) as HTMLInputElement;
    auto.addEventListener('change', () => {
      s.autoUpdateCheck = auto.checked;
      app.save();
      void bridge?.setAuto(auto.checked).then((st) => this.show(st));
    });
    const whatsNew = h('button', { class: 'btn small ghost', onclick: () => showWhatsNew(app) }, 'What’s new');
    this.el.append(h('h4', {}, icon('info', 15), ' About'), h('p', {}, h('b', {}, `CAL Audio Analyzer ${__APP_VERSION__}`)), this.status);
    if (bridge) {
      this.el.append(
        h('label', { class: 'cmp-check', title: 'Off: the app only looks for a new version when you press Check for updates' }, auto, 'Check for updates automatically (only tells you; nothing is downloaded or installed without you)'),
        h('div', { class: 'row gap8 wrap' }, this.checkBtn, this.downloadBtn, this.installBtn, whatsNew),
      );
      // The main process starts with automatic checks off; it learns the setting from here
      void bridge.setAuto(s.autoUpdateCheck).then((st) => this.show(st));
      bridge.onChange((st) => this.show(st));
    } else {
      this.el.append(h('div', { class: 'row gap8 wrap' }, whatsNew));
      this.status.textContent = 'This is the browser version: it is always the latest one the server provides.';
    }
  }

  show(st: UpdateState): void {
    this.app.setUpdateState(st);
    const text: Record<UpdateState['status'], string> = {
      unsupported: 'Updates are not available in this copy (the portable version, or a development build): download new versions from the releases page.',
      idle: this.app.settings.autoUpdateCheck ? 'New versions are looked for shortly after start and every six hours. You decide whether to download and install them.' : 'Updates are only looked for when you press Check for updates. Nothing changes without you.',
      checking: 'Checking for updates…',
      current: 'You have the latest version.',
      available: `Version ${st.version} is available. Download it when convenient (not during a show); it installs only when you restart.`,
      downloading: `Downloading version ${st.version ?? ''}… ${st.percent ? `${st.percent} %` : ''}`,
      ready: `Version ${st.version} is downloaded. It installs when you press Restart to update.`,
      error: `Could not check for updates${st.error ? ` (${st.error})` : ''}. On macOS, updates need a signed build.`,
    };
    this.status.textContent = text[st.status];
    this.downloadBtn.style.display = st.status === 'available' ? '' : 'none';
    this.installBtn.style.display = st.status === 'ready' ? '' : 'none';
    this.checkBtn.disabled = st.status === 'checking' || st.status === 'downloading' || st.status === 'unsupported';
  }
}
