/** Preset thumbnails: the t=1 frame drawn by the core runtime on an offscreen canvas. */
import { effectMountSpec, mockupEffectsRuntime, presetParams } from '@mockup/core';

export const THUMB_W = 160;
export const THUMB_H = 100;

const cache = new Map<string, string | null>();
let queue: Promise<unknown> = Promise.resolve();

function render(kind: string, preset: string): string | null {
  const params = presetParams(kind, preset);
  if (!params) return null;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const handle = mockupEffectsRuntime().mount(canvas, effectMountSpec({ kind, params }));
  try {
    if (!handle.ok) return null;
    handle.resize(THUMB_W, THUMB_H, 1);
    handle.draw(1);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    handle.destroy();
  }
}

/**
 * Thumbnail data URL (cached per kind+preset), `null` if the effect could not be drawn.
 * Renders go through a queue, one at a time, yielding control back to the browser between them
 * (each one creates and destroys a WebGL context).
 */
export function effectThumbnail(kind: string, preset: string): Promise<string | null> {
  const key = `${kind}:${preset}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const job = queue.then(
    () =>
      new Promise<string | null>((resolve) =>
        setTimeout(() => {
          if (!cache.has(key)) cache.set(key, render(kind, preset));
          resolve(cache.get(key) ?? null);
        }, 0),
      ),
  );
  queue = job;
  return job;
}
