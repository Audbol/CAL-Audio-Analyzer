import type { App } from '../app';
import { h, icon } from '../ui/dom';
import { desktopBridge } from '../remote/host';
import { showWhatsNew } from '../ui/whats-new';

export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  version: string | null;
  error: string | null;
  percent: number;
}

/** Tools → About & data: the version, updates (desktop app) and what's new. */
export class AboutCard {
  readonly el = h('section', { class: 'tool-card about-card' });
  private status = h('p', { class: 'small', role: 'status' });

  constructor(private readonly app: App) {
    const bridge = desktopBridge()?.updates;
    const check = h('button', { class: 'btn small', onclick: () => void bridge?.check().then((st) => this.show(st)) }, icon('reset', 14), 'Check for updates');
    const install = h('button', { class: 'btn small accent', onclick: () => void bridge?.install() }, 'Restart to update');
    this.el.append(
      h('h4', {}, icon('info', 15), ' About'),
      h('p', {}, h('b', {}, `CAL Audio Analyzer ${__APP_VERSION__}`)),
      this.status,
      h('div', { class: 'row gap8 wrap' }, bridge ? check : null, bridge ? install : null, h('button', { class: 'btn small ghost', onclick: () => showWhatsNew(app) }, 'What’s new')),
    );
    this.installBtn = install;
    this.checkBtn = check;
    if (bridge) {
      void bridge.state().then((st) => this.show(st));
      bridge.onChange((st) => this.show(st));
    } else this.status.textContent = 'This is the browser version: it is always the latest one the server provides. The desktop app updates itself.';
  }

  private installBtn: HTMLButtonElement;
  private checkBtn: HTMLButtonElement;

  show(st: UpdateState): void {
    this.app.setUpdateState(st);
    const text: Record<UpdateState['status'], string> = {
      unsupported: 'Automatic updates are not available in this copy (the portable version, or a development build): download new versions from the releases page.',
      idle: 'Updates are checked shortly after start and every six hours.',
      checking: 'Checking for updates…',
      current: 'You have the latest version.',
      downloading: `Downloading version ${st.version ?? ''}… ${st.percent ? `${st.percent} %` : ''}`,
      ready: `Version ${st.version} is ready. It installs when you restart the app.`,
      error: `Could not check for updates${st.error ? ` (${st.error})` : ''}. On macOS, updates need a signed build.`,
    };
    this.status.textContent = text[st.status];
    this.installBtn.style.display = st.status === 'ready' ? '' : 'none';
    this.checkBtn.disabled = st.status === 'checking' || st.status === 'downloading' || st.status === 'unsupported';
  }
}
