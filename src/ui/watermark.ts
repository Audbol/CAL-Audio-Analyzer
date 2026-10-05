/**
 * A watermark on the graphs: an image of the user's (a company logo, a show name) drawn faintly inside every
 * plot area, under the curves. It goes into screenshots, copied graph images and reports too.
 */

export type WatermarkPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface WatermarkSettings {
  on: boolean;
  /** The image as a data URL (downscaled when added), '' = none. */
  image: string;
  /** 0.03–1. */
  opacity: number;
  position: WatermarkPosition;
  /** Width as a share of the plot area's width (%), 5–80. */
  size: number;
}

export const DEFAULT_WATERMARK: WatermarkSettings = { on: false, image: '', opacity: 0.12, position: 'center', size: 30 };

let cfg: WatermarkSettings = DEFAULT_WATERMARK;
let img: HTMLImageElement | null = null;
let ready = false;
/** Changes whenever what is drawn changes (plots cache their background and compare this). */
export let watermarkEpoch = 0;
const listeners = new Set<() => void>();

/** Called when the watermark changes or its image finishes loading (plots redraw). */
export function onWatermarkChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(): void {
  watermarkEpoch++;
  for (const fn of listeners) fn();
}

export function setWatermark(next: WatermarkSettings): void {
  const prev = cfg;
  cfg = { ...next };
  if (cfg.image !== prev.image) {
    ready = false;
    img = null;
    if (cfg.image && typeof Image !== 'undefined') {
      const el = new Image();
      el.onload = () => {
        if (img !== el) return;
        ready = true;
        changed();
      };
      el.src = cfg.image;
      img = el;
    }
  }
  changed();
}

export function watermarkActive(): boolean {
  return cfg.on && !!img && ready && img.naturalWidth > 0;
}

/** Draw the watermark into the area (x, y, w, h) of a 2-D context (CSS pixels, transform already set). */
export function drawWatermark(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  if (!watermarkActive() || w < 40 || h < 30) return;
  const im = img!;
  const margin = Math.min(16, w * 0.04);
  let dw = (w * Math.max(5, Math.min(80, cfg.size))) / 100;
  let dh = (dw * im.naturalHeight) / im.naturalWidth;
  // Never taller than the area allows
  const maxH = h - 2 * margin;
  if (dh > maxH) {
    dw *= maxH / dh;
    dh = maxH;
  }
  const p = cfg.position;
  const dx = p === 'center' ? x + (w - dw) / 2 : p.endsWith('left') ? x + margin : x + w - dw - margin;
  const dy = p === 'center' ? y + (h - dh) / 2 : p.startsWith('top') ? y + margin : y + h - dh - margin;
  ctx.save();
  ctx.globalAlpha = Math.max(0.03, Math.min(1, cfg.opacity));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(im, dx, dy, dw, dh);
  ctx.restore();
}

/**
 * An image file as a data URL small enough to keep in the settings: at most 800 px wide or high, PNG (keeps
 * transparency). Rejects what isn't an image.
 */
export async function imageFileToDataUrl(file: File, maxSide = 800): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Not an image file');
  const url = URL.createObjectURL(file);
  try {
    const el = new Image();
    await new Promise<void>((resolve, reject) => {
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('The image could not be read'));
      el.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(el.naturalWidth, el.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(el.naturalWidth * k));
    c.height = Math.max(1, Math.round(el.naturalHeight * k));
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(el, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
