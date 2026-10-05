import type { App } from '../app';
import type { ViewId } from '../state';
import { h } from './dom';

interface TourStep {
  /** Tab to show first (none: stay). */
  view?: ViewId;
  /** What to point at: the first visible element matching the selector (and containing `text`, if given). */
  target: string;
  text?: string;
  title: string;
  body: string;
}

/** About a minute: the transfer-function workflow first, then the other tabs that matter most. */
const STEPS: TourStep[] = [
  {
    view: 'transfer',
    target: '.dpanel[data-panel="mag"]',
    title: 'The transfer function',
    body: 'What the system does to the signal: the mic compared with the reference. A flat line is a neutral system; peaks and dips are what you tune.',
  },
  {
    view: 'transfer',
    target: '.dpanel[data-panel="mag"]',
    title: 'Coherence',
    body: 'The thin line across the top: how trustworthy each frequency is (100 % is fully reliable). Where it drops, noise or reflections dominate and the data fades out.',
  },
  {
    target: '.meas-card .delay-row',
    title: 'Delay',
    body: 'The time the sound takes from the speaker to the mic. It was measured by itself; after moving the mic, press Find (or D).',
  },
  {
    view: 'transfer',
    target: '.dpanel[data-panel="phase"]',
    title: 'Phase',
    body: 'The timing of each frequency. It matters where two speakers play together, for example a sub and the mains. The Align tab uses it to time-align them.',
  },
  {
    target: '.meas-card button',
    text: 'TF',
    title: 'Capture',
    body: 'Save what you see as a trace (or press C) to compare positions, or before and after a change. Traces collect in the sidebar.',
  },
  {
    view: 'spectrum',
    target: '.dpanel[data-panel="rta"]',
    title: 'Spectrum',
    body: 'The level of every frequency at the mic, with a 10-second average curve (white) for the long-term balance, and the highest peak in the low, mid and high ranges labelled.',
  },
  {
    view: 'room',
    target: '.room .btn.accent.big',
    title: 'Sweep & Room',
    body: 'A sweep measures the room precisely: reverberation, clarity, the waterfall, and a diagnosis of room modes and reflections. Choose several positions for a spatial average.',
  },
  {
    view: 'eq',
    target: '.btn.accent',
    text: 'Calculate EQ',
    title: 'EQ assistant',
    body: 'Suggests parametric EQ against a target curve, preferring cuts. Compare before and after with Compare above the traces.',
  },
  {
    view: 'transfer',
    target: '.theme-btn',
    title: 'Make it yours',
    body: 'T switches between night and day; Tools → Display has more themes. Press ? for help and keyboard shortcuts. Enjoy measuring!',
  },
];

function find(step: TourStep): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(step.target)) {
    if (!el.getClientRects().length) continue;
    if (step.text && !el.textContent?.includes(step.text)) continue;
    return el;
  }
  return null;
}

let running: (() => void) | null = null;

/** The guided tour (first start in the demo, or Help → Take the tour). */
export function startTour(app: App): void {
  running?.();
  let i = 0;
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const title = h('h3', {});
  const body = h('p', {});
  const count = h('span', { class: 'dim small' });
  const back = h('button', { class: 'btn small ghost' }, 'Back');
  const next = h('button', { class: 'btn small accent' }, 'Next');
  const skip = h('button', { class: 'btn small ghost' }, 'Skip tour');
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Tour' }, title, body, h('div', { class: 'row gap8' }, count, h('div', { class: 'spacer' }), skip, back, next));
  const layer = h('div', { class: 'tour-layer' }, spot, card);
  document.body.append(layer);

  const place = () => {
    const step = STEPS[i];
    const el = find(step);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (el) {
      const r = el.getBoundingClientRect();
      const pad = 6;
      Object.assign(spot.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      // The card goes beside the target where there is room: below, above, then inside its top
      const cw = Math.min(360, vw - 24);
      const ch = card.offsetHeight || 170;
      let top = r.bottom + 12;
      if (top + ch > vh - 12) top = r.top - ch - 12;
      if (top < 12) top = Math.min(vh - ch - 12, Math.max(12, r.top + 16));
      const left = Math.min(vw - cw - 12, Math.max(12, r.left + Math.min(40, r.width / 4)));
      Object.assign(card.style, { left: `${left}px`, top: `${top}px`, width: `${cw}px` });
    } else {
      spot.style.display = 'none';
      Object.assign(card.style, { left: `${Math.max(12, vw / 2 - 180)}px`, top: `${vh / 2 - 90}px`, width: `${Math.min(360, vw - 24)}px` });
    }
  };
  const show = () => {
    const step = STEPS[i];
    if (step.view && app.settings.view !== step.view) app.setView(step.view);
    title.textContent = step.title;
    body.textContent = step.body;
    count.textContent = `${i + 1} / ${STEPS.length}`;
    back.disabled = i === 0;
    next.textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
    // Let the tab lay out before measuring where the target is
    requestAnimationFrame(() => requestAnimationFrame(place));
    next.focus();
  };
  const end = () => {
    window.removeEventListener('resize', place);
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
    running = null;
    if (!app.settings.tourDone) {
      app.settings.tourDone = true;
      app.save();
    }
  };
  const go = (d: number) => {
    if (i + d >= STEPS.length) return end();
    i = Math.max(0, i + d);
    show();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  next.addEventListener('click', () => go(1));
  back.addEventListener('click', () => go(-1));
  skip.addEventListener('click', end);
  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey, true);
  running = end;
  show();
}
