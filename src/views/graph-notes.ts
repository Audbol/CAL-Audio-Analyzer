import type { App } from '../app';
import type { GraphNote } from '../state';
import type { Plot } from '../ui/plot';
import { h, icon } from '../ui/dom';

export const NOTE_COLOR = '#f0abfc';

/** "Add note" mode is shared: only one graph waits for a click at a time. */
let adding: GraphNotes | null = null;

/** How a note's frequency is written on its flag and in the report. */
export function noteFreq(f: number): string {
  return f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`;
}

/**
 * Notes on one graph: a toolbar button to add one (then click the graph where it belongs), flags on the plot,
 * and a small editor to change or delete a note (click its flag). Notes live in the settings, so they are saved
 * with the session, shared with remote devices and listed in the report.
 */
export class GraphNotes {
  private btn: HTMLButtonElement;
  private editor: HTMLElement | null = null;
  private key = '';

  constructor(
    private readonly app: App,
    private readonly graph: GraphNote['graph'],
    private readonly plot: Plot,
  ) {
    this.btn = h('button', { class: 'chip', title: 'Add a note: press, then click the graph where it belongs (click a note to change or delete it)', dataset: { notes: graph } }, icon('note', 14), 'Note');
    this.btn.addEventListener('click', () => this.setAdding(adding !== this));
    plot.onClick = (f) => {
      if (adding !== this) return;
      this.setAdding(false);
      this.edit(null, f);
    };
    plot.onNoteClick = (i) => {
      const n = this.mine()[i];
      if (n) this.edit(n, n.f);
    };
  }

  button(): HTMLButtonElement {
    return this.btn;
  }

  private mine(): GraphNote[] {
    return this.app.settings.graphNotes.filter((n) => n.graph === this.graph);
  }

  private setAdding(on: boolean): void {
    if (adding && adding !== this) adding.setAdding(false);
    adding = on ? this : null;
    this.btn.classList.toggle('on', on);
    this.plot.el.classList.toggle('adding-note', on);
    if (on) this.app.toast('Click the graph where the note belongs', 'info');
  }

  /** Put the notes on the plot; returns true when they changed (the caller redraws). */
  apply(): boolean {
    const notes = this.mine();
    const key = JSON.stringify(notes.map((n) => [n.f, n.text]));
    if (key === this.key) return false;
    this.key = key;
    this.plot.notes = notes.map((n) => ({ x: n.f, label: n.text, color: NOTE_COLOR }));
    return true;
  }

  private save(notes: GraphNote[]): void {
    this.app.settings.graphNotes = notes;
    this.app.save();
    if (this.apply()) this.plot.draw();
  }

  /** The note editor, over the plot near the note's frequency. */
  private edit(note: GraphNote | null, f: number): void {
    this.editor?.remove();
    const input = h('input', { type: 'text', value: note?.text ?? '', placeholder: 'e.g. desk reflection, sub moved 20 cm', maxlength: '80', 'aria-label': `Note at ${noteFreq(f)}` });
    const close = () => {
      box.remove();
      this.editor = null;
    };
    const commit = () => {
      const text = input.value.trim();
      const all = this.app.settings.graphNotes.filter((n) => n.id !== note?.id);
      if (text) all.push({ id: note?.id ?? `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, graph: this.graph, f, text, created: note?.created ?? Date.now() });
      this.save(all);
      close();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') close();
    });
    const box = h(
      'div',
      { class: 'note-editor', role: 'dialog', 'aria-label': note ? 'Edit note' : 'Add note' },
      h('span', { class: 'note-f' }, noteFreq(f)),
      input,
      h('button', { class: 'btn small accent', onclick: commit }, 'Save'),
      note ? h('button', { class: 'btn small ghost', title: 'Delete this note', onclick: () => { this.save(this.app.settings.graphNotes.filter((n) => n.id !== note.id)); close(); } }, icon('trash', 14)) : null,
      h('button', { class: 'btn small ghost', title: 'Cancel', onclick: close }, icon('x', 14)),
    );
    // Near the note's line, kept inside the plot
    const x = this.plot.xToPx(f);
    const w = this.plot.el.clientWidth;
    box.style.left = `${Math.max(8, Math.min(x - 40, w - 380))}px`;
    this.plot.el.append(box);
    this.editor = box;
    input.focus();
    input.select();
  }
}
