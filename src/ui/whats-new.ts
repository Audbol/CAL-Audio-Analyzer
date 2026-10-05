import type { App } from '../app';
import { h } from './dom';
import { modal } from './dialogs';

const RELEASES = 'https://github.com/Audbol/CAL-Audio-Analyzer/releases';

/** Highlights of each major version, shown once after updating to it (the full notes are on the releases page). */
const HIGHLIGHTS: { version: string; items: [string, string][] }[] = [
  {
    version: '2.0',
    items: [
      ['Ready for transfer-function work', 'Coherence in its own band, the delay found by itself, cleaner default layouts.'],
      ['Smoother and faster', 'Analysis in a background thread, meters at the screen’s rate, a gliding spectrum.'],
      ['Measure more', 'Group delay, guided multi-position sweeps, room diagnosis, a feedback finder.'],
      ['Tune and document', 'Before / after compare with a score, notes on graphs, both in the report.'],
      ['Make it yours', 'Themes (Tools → Display & performance), a guided tour (Help), automatic updates.'],
    ],
  },
];

const major = (v: string) => v.split('.')[0];

/** After an update (not on a first start): what's new in this version. */
export function maybeShowWhatsNew(app: App): void {
  const s = app.settings;
  const now = __APP_VERSION__;
  const seen = s.lastSeenVersion;
  if (seen !== now) {
    s.lastSeenVersion = now;
    app.save();
  }
  if (!seen || seen === now || major(seen) === major(now)) return;
  showWhatsNew(app);
}

export function showWhatsNew(app: App): void {
  const v = __APP_VERSION__;
  const hl = HIGHLIGHTS.find((x) => major(x.version) === major(v)) ?? HIGHLIGHTS[0];
  const body = h(
    'div',
    { class: 'whats-new' },
    h('ul', {}, ...hl.items.map(([t, d]) => h('li', {}, h('b', {}, t), h('span', {}, d)))),
    h('p', { class: 'dim small' }, 'All changes are in the release notes. A one-minute tour of the essentials is in Help.'),
  );
  const notes = h('a', { class: 'btn ghost', href: `${RELEASES}/tag/v${v}`, target: '_blank', rel: 'noopener' }, 'Release notes');
  const ok = h('button', { class: 'btn accent' }, 'Got it');
  const { close } = modal(`What’s new in ${v.replace(/-.*/, '')}`, body, [notes, h('div', { class: 'spacer' }), ok]);
  ok.addEventListener('click', close);
  void app;
}
