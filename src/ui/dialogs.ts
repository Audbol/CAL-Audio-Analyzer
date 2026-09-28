import type { App } from '../app';
import { GEN_CHANNEL } from '../audio/engine';
import { h, icon, clear } from './dom';

function modal(title: string, body: HTMLElement, footer: HTMLElement[] = []): { close: () => void; el: HTMLElement } {
  const overlay = h('div', { class: 'modal-overlay' });
  const close = () => {
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), 150);
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  window.addEventListener('keydown', onKey);
  const box = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'btn icon-btn ghost', onclick: close, title: 'Close' }, icon('x', 18))),
    h('div', { class: 'modal-body' }, body),
    footer.length ? h('div', { class: 'modal-foot' }, ...footer) : null,
  );
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  document.body.append(overlay);
  return { close, el: box };
}

/** First-run setup assistant: pick demo vs. hardware and explain the measurement chain. */
export function showWizard(app: App): void {
  const body = h('div', { class: 'wizard' });
  let step = 0;
  let mode: 'demo' | 'hw' = app.settings.simulate ? 'demo' : 'hw';
  let refMode: 'loopback' | 'internal' = 'internal';
  const next = h('button', { class: 'btn accent' });
  const back = h('button', { class: 'btn ghost' }, 'Back');
  const { close } = modal('Welcome to CAL Audio Analyzer', body, [back, h('div', { class: 'spacer' }), next]);

  const choice = (active: boolean, title: string, desc: string, ic: Parameters<typeof icon>[0], on: () => void) =>
    h('button', { class: `choice${active ? ' on' : ''}`, onclick: () => { on(); render(); } }, h('div', { class: 'choice-icon' }, icon(ic, 22)), h('div', {}, h('b', {}, title), h('p', {}, desc)));

  const render = () => {
    clear(body);
    back.style.visibility = step === 0 ? 'hidden' : 'visible';
    if (step === 0) {
      body.append(
        h('p', { class: 'lead' }, 'Measure and tune sound systems and rooms: real-time transfer function with coherence, RTA, spectrogram, impulse response, sweep-based RT60 and clarity, an EQ assistant and a calibrated SPL meter.'),
        h('h4', {}, 'How do you want to start?'),
        h(
          'div',
          { class: 'choices' },
          choice(mode === 'demo', 'Explore with the demo room', 'A virtual loudspeaker in a reverberant room. No hardware needed, and nothing is played through your speakers.', 'sparkle', () => (mode = 'demo')),
          choice(mode === 'hw', 'Measure a real system', 'Use your audio interface and a measurement microphone.', 'mic', () => (mode = 'hw')),
        ),
      );
      next.textContent = mode === 'demo' ? 'Start demo' : 'Next';
    } else {
      body.append(
        h('h4', {}, 'Connect your measurement chain'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('b', {}, 'Output → system. '), 'Send the interface output (Out 1/2) to the mixer or processor that feeds the loudspeakers. Start with the amplifier turned down.'),
          h('li', {}, h('b', {}, 'Mic → In 1. '), 'Connect an omnidirectional measurement mic (48 V phantom if required) and point it at the source, at ear height.'),
          h('li', {}, h('b', {}, 'Reference. '), 'Dual-channel measurements compare the mic with the signal sent to the system:'),
        ),
        h(
          'div',
          { class: 'choices' },
          choice(refMode === 'internal', 'Internal reference (simplest)', "Uses the generator's own signal. Works with any interface; latency is removed with Find delay.", 'wave', () => (refMode = 'internal')),
          choice(refMode === 'loopback', 'Hardware loopback on In 2', 'Patch the output back into In 2 (or take the mixer output). Needed to measure with program material or a console in the chain.', 'layers', () => (refMode = 'loopback')),
        ),
        h('p', { class: 'dim small' }, 'Next, the browser will ask for microphone permission. Voice processing (echo cancellation, noise suppression, AGC) is disabled automatically. For best results select your audio interface as the input.'),
      );
      next.textContent = 'Start measuring';
    }
  };

  next.addEventListener('click', async () => {
    if (step === 0 && mode === 'hw') {
      step = 1;
      render();
      return;
    }
    const s = app.settings;
    s.simulate = mode === 'demo';
    s.wizardDone = true;
    const m = s.measurements[0];
    if (mode === 'demo') {
      m.mic = 0;
      m.ref = 1;
    } else {
      m.mic = 0;
      m.ref = refMode === 'internal' ? GEN_CHANNEL : 1;
    }
    if (mode === 'demo') {
      s.generator.type = 'pink';
      s.generator.level = -18;
    }
    app.save();
    close();
    await app.start();
    app.renderGenControls();
    app.renderTopState();
    app.setView('live');
    if (mode === 'demo') setTimeout(() => app.measurements[0] && app.findDelay(app.measurements[0]), 1600);
    else app.toast('Turn on the generator (Space), raise the level carefully, then press Find delay.', 'info');
  });
  back.addEventListener('click', () => {
    step = 0;
    render();
  });
  render();
  const s = app.settings;
  if (!s.wizardDone) {
    s.wizardDone = true;
    app.save();
  }
}

export function showHelp(app: App): void {
  const keys: [string, string][] = [
    ['Enter', 'Start / stop audio'],
    ['Space', 'Generator on / off'],
    ['D', 'Find delay (first measurement)'],
    ['C', 'Capture transfer function as trace'],
    ['R', 'Reset averages'],
    ['P', 'Toggle RTA peak hold'],
    ['F', 'Freeze / unfreeze display'],
    ['1 – 7', 'Switch views'],
    ['?', 'This help'],
  ];
  const body = h(
    'div',
    { class: 'help' },
    h(
      'div',
      { class: 'help-cols' },
      h(
        'div',
        {},
        h('h4', {}, 'Quick guide'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('b', {}, 'Start'), ' audio and pick your interface (or the demo room).'),
          h('li', {}, 'Turn on ', h('b', {}, 'pink noise'), ' and bring the level up until the mic reads 10–20 dB above the background.'),
          h('li', {}, 'Press ', h('b', {}, 'Find'), ' on the measurement card so the reference is time-aligned with the mic. Coherence should rise toward 100 %.'),
          h('li', {}, 'Read the ', h('b', {}, 'magnitude'), ' (tonal balance), ', h('b', {}, 'phase'), ' (timing / crossover alignment) and ', h('b', {}, 'coherence'), ' (how trustworthy each frequency is). Data with low coherence is faded.'),
          h('li', {}, h('b', {}, 'Capture'), ' traces at several mic positions, select them and press ', h('b', {}, 'Avg'), ' for a spatial average — then use the ', h('b', {}, 'EQ Assistant'), '.'),
          h('li', {}, 'For room acoustics, run a ', h('b', {}, 'sweep'), ' in Sweep & Room to get RT60 / EDT / C50 / C80 per band.'),
        ),
        h('h4', {}, 'Mouse'),
        h('p', { class: 'dim small' }, 'Hover for cursor readout (value, note name, wavelength). Scroll to zoom the level axis, Shift/Ctrl+scroll to zoom frequency, drag to pan (Shift+drag pans frequency), double-click to reset.'),
        h('h4', {}, 'Panels (Live view)'),
        h('p', { class: 'dim small' }, 'Drag a panel title bar to rearrange; drop it outside the stack (or double-click the title) to float it. Drag splitters to resize docked panels and the corner to resize floating ones. The window button detaches a panel into its own window, e.g. for a second monitor; close that window to dock it again. Toolbar chips show/hide panels; Reset layout restores the default.'),
      ),
      h('div', {}, h('h4', {}, 'Keyboard'), h('table', { class: 'keys' }, ...keys.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))),
    ),
    h('p', { class: 'dim small' }, `CAL Audio Analyzer runs entirely in your browser. Audio never leaves this device. ${app.engine.running ? `Running at ${app.fs} Hz.` : ''}`),
  );
  modal('Help', body);
}
