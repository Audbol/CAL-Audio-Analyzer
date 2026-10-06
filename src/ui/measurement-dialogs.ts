import type { App } from '../app';
import type { MicProfile } from '../state';
import { h, icon, select } from './dom';
import { modal } from './dialogs';

/** A new microphone for the inventory: its name, model and serial (correction file and calibration in Tools). */
export function showNewMic(app: App, onCreated: (mic: MicProfile) => void, onCancel?: () => void): void {
  const name = h('input', { type: 'text', class: 'text', value: `Mic ${app.settings.mics.length + 1}`, maxlength: '40', 'aria-label': 'Microphone name', dataset: { newMic: 'name' } }) as HTMLInputElement;
  const model = h('input', { type: 'text', class: 'text', placeholder: 'e.g. M30', maxlength: '40', 'aria-label': 'Model', dataset: { newMic: 'model' } }) as HTMLInputElement;
  const serial = h('input', { type: 'text', class: 'text', placeholder: 'optional', maxlength: '40', 'aria-label': 'Serial number', dataset: { newMic: 'serial' } }) as HTMLInputElement;
  let done = false;
  const create = () => {
    const mic: MicProfile = { id: `mic${Date.now().toString(36)}`, name: name.value.trim() || `Mic ${app.settings.mics.length + 1}`, channel: -1, micCal: null, splOffset: 0, splCalibrated: false };
    if (model.value.trim()) mic.model = model.value.trim();
    if (serial.value.trim()) mic.serial = serial.value.trim();
    app.settings.mics.push(mic);
    app.save();
    done = true;
    close();
    onCreated(mic);
    app.toast(`${mic.name} added to the inventory. Load its correction file and calibrate it in Tools → Setup.`, 'ok');
  };
  const field = (label: string, el: HTMLElement) => h('label', { class: 'cmp-field' }, h('span', {}, label), el);
  const body = h(
    'div',
    { class: 'meas-dialog' },
    h('p', { class: 'dim small' }, 'A microphone in your inventory can be chosen for any measurement. Its correction file and SPL calibration go with it.'),
    field('Name', name),
    h('div', { class: 'row gap8 wrap' }, field('Model', model), field('Serial number', serial)),
  );
  const { el, close } = modal('New microphone', body, [h('div', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn accent', dataset: { newMic: 'create' }, onclick: create }, icon('plus', 14), 'Add microphone')]);
  el.classList.add('meas-modal');
  name.addEventListener('keydown', (e) => e.key === 'Enter' && create());
  setTimeout(() => name.select(), 50);
  new MutationObserver((_, obs) => {
    if (el.isConnected) return;
    obs.disconnect();
    if (!done) onCancel?.();
  }).observe(document.body, { childList: true });
}

/**
 * Add a measurement: name it after what it measures (a position, a part of the system), choose its input and
 * reference, and the microphone from the inventory.
 */
export function showAddMeasurement(app: App): void {
  const s = app.settings;
  const n = s.measurements.length;
  const inputs = app.channelOptions(false);
  // The first input no measurement uses yet
  const used = new Set(s.measurements.map((m) => m.mic));
  const firstFree = inputs.find((o) => !used.has(o.value) && o.value !== s.measurements[0]?.ref)?.value ?? inputs[0]?.value ?? 0;
  let input = firstFree;
  let ref = s.measurements[0]?.ref ?? -1;
  let micId = app.micOn(input)?.id ?? '';
  const name = h('input', { type: 'text', class: 'text', value: '', placeholder: `e.g. FOH left, Row 12, Sub (default: Mic ${n + 1})`, maxlength: '40', 'aria-label': 'Measurement name', dataset: { addMeas: 'name' } }) as HTMLInputElement;
  const micHost = h('span', { class: 'meas-mic-host' });
  const renderMic = () => {
    const opts = [
      { value: '', label: 'None (uncalibrated)' },
      ...s.mics.map((mic) => {
        const user = s.measurements.find((o) => o.micId === mic.id && o.mic !== input);
        return { value: mic.id, label: `${mic.name}${mic.model ? ` (${mic.model})` : ''}${mic.splCalibrated ? '' : ' · not calibrated'}${user ? ` · in use: ${user.name}` : ''}` };
      }),
      { value: '__new', label: 'New microphone…' },
    ];
    micHost.replaceChildren(
      select(opts, s.mics.some((x) => x.id === micId) ? micId : '', (v) => {
        if (v === '__new')
          return showNewMic(
            app,
            (mic) => {
              micId = mic.id;
              renderMic();
            },
            renderMic,
          );
        micId = v;
      }, { dataset: { addMeas: 'mic' }, 'aria-label': 'Microphone' }),
    );
  };
  renderMic();
  const inputSel = select(inputs, input, (v) => {
    input = v;
    // Suggest the mic already on that input
    micId = app.micOn(v)?.id ?? micId;
    renderMic();
  }, { dataset: { addMeas: 'input' }, 'aria-label': 'Input' });
  const refSel = select(app.channelOptions(true), ref, (v) => (ref = v), { dataset: { addMeas: 'ref' }, 'aria-label': 'Reference' });
  const field = (label: string, el: HTMLElement, hint = '') => h('label', { class: 'cmp-field', title: hint }, h('span', {}, label), el);
  const add = () => {
    const cfg = app.addMeasurement({ name: name.value, mic: input, ref, micId: micId || undefined });
    if (!micId) delete cfg.micId;
    app.syncCal();
    app.save();
    app.renderMeasurements();
    close();
    app.toast(`Measurement “${cfg.name}” added`, 'ok');
  };
  const body = h(
    'div',
    { class: 'meas-dialog' },
    field('Name', name, 'What it measures: a position or a part of the system. Traces captured from it carry this name.'),
    h('div', { class: 'row gap8 wrap' }, field('Input', inputSel, 'The input the mic is plugged into'), field('Reference', refSel, 'The signal sent to the system: the generator, or a loopback input')),
    field('Microphone', micHost, 'From your mic inventory (Tools → Setup): its correction file and SPL calibration apply'),
    h('p', { class: 'dim small' }, 'Manage the inventory (correction files, SPL calibration) in Tools → Setup → Microphones.'),
  );
  const { el, close } = modal('Add measurement', body, [h('div', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn accent', dataset: { addMeas: 'add' }, onclick: add }, icon('plus', 14), 'Add measurement')]);
  el.classList.add('meas-modal');
  name.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  setTimeout(() => name.focus(), 50);
}
