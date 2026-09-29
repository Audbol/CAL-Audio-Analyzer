import type { App } from '../app';
import { h, icon } from './dom';
import { modal } from './dialogs';

/** Longest side of stored photos (px): enough to recognise a position, small enough for sessions and sync. */
const PHOTO_SIZE = 960;

/** Scale an image file down and return it as a JPEG data URL. */
export async function photoDataUrl(file: Blob, size = PHOTO_SIZE): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.78);
}

/** Note and photo of the measurement position for a trace (kept in sessions and shown in reports). */
export function showTraceNotes(app: App, id: string): void {
  const t = app.traces.traces.find((x) => x.id === id);
  if (!t) return;
  let photo = t.photo ?? '';
  const text = h('textarea', { class: 'text', rows: '4', placeholder: 'Position, height, what was changed… e.g. “Row 12 seat 8, 1.2 m, after EQ v2”', dataset: { traceNoteText: '' } }) as HTMLTextAreaElement;
  text.value = t.note ?? '';
  const preview = h('div', { class: 'note-photo' });
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none', dataset: { traceNoteFile: '' } });
  const removeBtn = h('button', { class: 'btn small ghost', onclick: () => { photo = ''; render(); } }, icon('trash', 14), 'Remove photo');
  const render = () => {
    preview.replaceChildren(photo ? h('img', { src: photo, alt: 'Measurement position' }) : h('div', { class: 'empty' }, 'No photo'));
    removeBtn.style.display = photo ? '' : 'none';
  };
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      photo = await photoDataUrl(f);
      render();
    } catch {
      app.toast('Could not read that image.', 'warn');
    }
  });
  render();
  const save = h('button', { class: 'btn accent' }, 'Save');
  const cancel = h('button', { class: 'btn' }, 'Cancel');
  const { close } = modal(
    `Notes · ${t.name}`,
    h(
      'div',
      { class: 'trace-notes' },
      h('label', { class: 'field' }, h('span', {}, 'Note'), text),
      preview,
      h('div', { class: 'row gap8' }, h('button', { class: 'btn small', onclick: () => file.click() }, icon('camera', 14), 'Add photo…'), removeBtn),
      file,
    ),
    [cancel, save],
  );
  cancel.addEventListener('click', close);
  save.addEventListener('click', () => {
    // Empty strings (not undefined) so a removal also reaches the measurement host
    app.traces.update(id, { note: text.value.trim(), photo });
    close();
  });
  setTimeout(() => text.focus(), 50);
}
