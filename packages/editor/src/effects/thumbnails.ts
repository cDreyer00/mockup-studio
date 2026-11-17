/** Miniaturas dos presets: o quadro t=1 desenhado pelo runtime do core num canvas fora da tela. */
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
 * Data URL da miniatura (cache por kind+preset), `null` se o efeito não pôde ser desenhado.
 * As renderizações entram numa fila, uma por vez, devolvendo o controle ao navegador entre elas
 * (cada uma cria e destrói um contexto WebGL).
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
