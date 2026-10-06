import type { App } from '../app';
import { h, icon, select } from '../ui/dom';
import { imageFileToDataUrl, setWatermark, type WatermarkPosition } from '../ui/watermark';

/**
 * Tools → Display → Watermark: a logo or other image drawn faintly on every graph (and so on screenshots,
 * copied graph images and reports), with its opacity, size and position.
 */
export class WatermarkCard {
  readonly el = h('section', { class: 'tool-card watermark-card' });

  constructor(private readonly app: App) {
    this.render();
  }

  private apply(): void {
    setWatermark(this.app.settings.watermark);
    this.app.save();
  }

  render(): void {
    const w = this.app.settings.watermark;
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif', hidden: true, dataset: { watermark: 'file' } }) as HTMLInputElement;
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        w.image = await imageFileToDataUrl(f);
        w.on = true;
        this.apply();
        this.render();
        this.app.toast('Watermark added to the graphs', 'ok');
      } catch (e) {
        this.app.toast(`${f.name}: ${(e as Error).message}`, 'warn');
      }
    });
    const on = h('input', { type: 'checkbox', checked: w.on, disabled: !w.image, dataset: { watermark: 'on' } }) as HTMLInputElement;
    on.addEventListener('change', () => {
      w.on = on.checked;
      this.apply();
    });
    const range = (value: number, min: number, max: number, step: number, label: string, set: (v: number) => void, fmt: (v: number) => string) => {
      const out = h('span', { class: 'dim small wm-val' }, fmt(value));
      const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, disabled: !w.image }) as HTMLInputElement;
      r.addEventListener('input', () => {
        set(+r.value);
        out.textContent = fmt(+r.value);
        setWatermark(w);
      });
      r.addEventListener('change', () => this.app.save());
      return h('label', { class: 'wm-row' }, h('span', {}, label), r, out);
    };
    const positions: { value: WatermarkPosition; label: string }[] = [
      { value: 'center', label: 'Centre' },
      { value: 'top-center', label: 'Top centre' },
      { value: 'bottom-center', label: 'Bottom centre' },
      { value: 'top-left', label: 'Top left' },
      { value: 'top-right', label: 'Top right' },
      { value: 'bottom-left', label: 'Bottom left' },
      { value: 'bottom-right', label: 'Bottom right' },
    ];
    this.el.replaceChildren(
      h('h4', {}, icon('image', 15), ' Watermark'),
      h('p', { class: 'dim small' }, 'A logo or show name drawn faintly on every graph, so screenshots, copied graphs and reports carry it.'),
      ...(w.image ? [h('div', { class: 'wm-preview' }, h('img', { src: w.image, alt: 'Watermark image' }))] : []),
      h('label', { class: 'cmp-check' }, on, 'Show on graphs'),
      range(Math.round(w.opacity * 100), 3, 100, 1, 'Opacity', (v) => (w.opacity = v / 100), (v) => `${v} %`),
      range(w.size, 5, 80, 1, 'Size', (v) => (w.size = v), (v) => `${v} % of the width`),
      h(
        'label',
        { class: 'wm-row' },
        h('span', {}, 'Position'),
        select(positions, w.position, (v) => {
          w.position = v;
          this.apply();
        }, { dataset: { watermark: 'position' }, disabled: !w.image }),
      ),
      h(
        'div',
        { class: 'row gap8 wrap' },
        h('button', { class: 'btn small', dataset: { watermark: 'choose' }, onclick: () => file.click() }, icon('upload', 14), w.image ? 'Change image…' : 'Choose image…'),
        w.image
          ? h('button', { class: 'btn small ghost', dataset: { watermark: 'remove' }, onclick: () => {
              w.image = '';
              w.on = false;
              this.apply();
              this.render();
            } }, icon('trash', 14), 'Remove')
          : null,
        file,
      ),
    );
  }
}
