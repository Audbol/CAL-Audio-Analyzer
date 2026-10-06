import type { App } from '../app';
import { h, icon } from '../ui/dom';
import { modal } from '../ui/dialogs';
import { downloadText } from '../session';
import { applyPreset, buildPreset, parsePreset, presetFile, presetSummary, type SystemPreset } from '../presets';

/**
 * Tools → Session & presets → System presets: save the measurement setup of a rig or venue (measurements with
 * their inputs, references, mics, delays and weights; analysis, targets, EQ console, crossover) and load it in
 * one step. Presets stay on this computer; export one to use it on another.
 */
export class PresetsCard {
  readonly el = h('section', { class: 'tool-card presets-card' });

  constructor(private readonly app: App) {
    this.render();
  }

  private save(list: SystemPreset[]): void {
    this.app.settings.presets = list;
    this.app.save();
    this.render();
  }

  render(): void {
    const app = this.app;
    const s = app.settings;
    if (app.remote) {
      this.el.replaceChildren(h('h4', {}, icon('layers', 15), ' System presets'), h('p', { class: 'dim small' }, 'Presets are saved and loaded on the measurement host.'));
      return;
    }
    const name = h('input', { type: 'text', class: 'text', placeholder: 'e.g. Arena rig, Church install', maxlength: '60', 'aria-label': 'Preset name', dataset: { preset: 'name' } }) as HTMLInputElement;
    const saveNew = () => {
      const p = buildPreset(app, name.value || `Preset ${s.presets.length + 1}`);
      this.save([...s.presets, p]);
      app.toast(`Preset “${p.name}” saved`, 'ok');
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && saveNew());
    const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, dataset: { preset: 'file' } }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        const p = parsePreset(await f.text());
        this.save([...s.presets, p]);
        app.toast(`Imported preset “${p.name}”`, 'ok');
      } catch (e) {
        app.toast(`${f.name}: ${(e as Error).message}`, 'warn');
      }
    });
    const row = (p: SystemPreset) =>
      h(
        'div',
        { class: 'preset-row', dataset: { presetRow: p.id } },
        h('div', { class: 'preset-info' }, h('b', {}, p.name), h('span', { class: 'dim small' }, `${presetSummary(p)} · saved ${new Date(p.saved).toLocaleDateString()}`)),
        h('div', { class: 'row gap4 wrap' },
          h('button', { class: 'btn small accent', dataset: { preset: 'load' }, onclick: () => this.confirmLoad(p) }, 'Load'),
          h('button', { class: 'btn small ghost', title: 'Replace it with the current setup', dataset: { preset: 'update' }, onclick: () => {
            if (!confirm(`Replace “${p.name}” with the current setup?`)) return;
            this.save(s.presets.map((x) => (x.id === p.id ? buildPreset(app, p.name, p.id) : x)));
            app.toast(`Preset “${p.name}” updated`, 'ok');
          } }, 'Update'),
          h('button', { class: 'btn small ghost', title: 'Rename', dataset: { preset: 'rename' }, onclick: (e: Event) => {
            // The name becomes editable in place (Enter or leaving the field keeps it, Escape cancels)
            const title = (e.currentTarget as HTMLElement).closest('.preset-row')?.querySelector('b');
            if (!title) return;
            const input = h('input', { type: 'text', class: 'text', value: p.name, maxlength: '60', 'aria-label': 'Preset name', dataset: { preset: 'rename-input' } }) as HTMLInputElement;
            let done = false;
            const finish = (keep: boolean) => {
              if (done) return;
              done = true;
              const n = input.value.trim();
              if (keep && n && n !== p.name) this.save(s.presets.map((x) => (x.id === p.id ? { ...x, name: n } : x)));
              else this.render();
            };
            input.addEventListener('keydown', (k) => {
              if (k.key === 'Enter') finish(true);
              if (k.key === 'Escape') finish(false);
            });
            input.addEventListener('blur', () => finish(true));
            title.replaceWith(input);
            input.select();
          } }, 'Rename'),
          h('button', { class: 'btn small ghost', title: 'Save it as a file, to use it on another computer', dataset: { preset: 'export' }, onclick: () => downloadText(`${p.name.replace(/[\\/:*?"<>|]+/g, '_')}.calpreset.json`, presetFile(p)) }, icon('download', 13)),
          h('button', { class: 'btn small ghost', title: 'Delete', 'aria-label': `Delete ${p.name}`, dataset: { preset: 'delete' }, onclick: () => {
            if (confirm(`Delete the preset “${p.name}”?`)) this.save(s.presets.filter((x) => x.id !== p.id));
          } }, icon('trash', 13)),
        ),
      );
    this.el.replaceChildren(
      h('h4', {}, icon('layers', 15), ' System presets'),
      h('p', { class: 'dim small' }, 'The setup of a rig or venue in one step: named measurements with their inputs, references, mics, delays and weights; analysis and target settings; the EQ console and the crossover. Traces, calibration and the generator are not changed.'),
      h('div', { class: 'row gap8 wrap' }, name, h('button', { class: 'btn small', dataset: { preset: 'save' }, onclick: saveNew }, icon('plus', 13), 'Save current setup'), h('button', { class: 'btn small ghost', onclick: () => file.click() }, icon('upload', 13), 'Import…'), file),
      s.presets.length ? h('div', { class: 'preset-list' }, ...s.presets.map(row)) : h('p', { class: 'dim small' }, 'No presets yet.'),
    );
  }

  private confirmLoad(p: SystemPreset): void {
    const app = this.app;
    const missing = p.measurements.filter((m) => m.micId && !app.settings.mics.some((x) => x.id === m.micId)).map((m) => `${m.name}: ${p.micNames?.[m.micId!] ?? 'a mic'}`);
    const go = h('button', { class: 'btn accent', dataset: { preset: 'confirm' } }, 'Load preset');
    const { close } = modal(
      `Load “${p.name}”`,
      h(
        'div',
        {},
        h('p', {}, `${presetSummary(p)}, with its analysis and target settings, EQ console and crossover.`),
        h('p', { class: 'warn-text small' }, 'This replaces the current measurements and those settings. Traces, calibration and the generator stay as they are.'),
        missing.length ? h('p', { class: 'dim small' }, `Not in this computer’s mic inventory (choose a mic for them after loading): ${missing.join('; ')}.`) : null,
      ),
      [h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), go],
    );
    go.addEventListener('click', () => {
      close();
      applyPreset(app, p);
      app.toast(`Loaded preset “${p.name}”`, 'ok');
    });
  }
}
