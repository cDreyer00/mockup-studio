/**
 * Geometria pura do recorte visual de imagens. O recorte é um `ImageCrop` (% de cada lado da
 * imagem inteira); durante o modo de recorte a imagem inteira ocupa a caixa do nó e o retângulo
 * de recorte é desenhado sobre ela. Nada aqui toca DOM, store ou rede.
 */
import { clampCrop, cropToCss, parseCrop } from '@mockup/core';
import type { ImageCrop, Op } from '@mockup/core';
import type { HandleName, Rect } from './geometry';

/** Menor largura/altura (em %) do retângulo de recorte. */
export const MIN_CROP_SIZE = 1;

export const NO_CROP: ImageCrop = { top: 0, right: 0, bottom: 0, left: 0 };

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isEmptyCrop(c: ImageCrop): boolean {
  return c.top === 0 && c.right === 0 && c.bottom === 0 && c.left === 0;
}

export function sameCrop(a: ImageCrop, b: ImageCrop): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Recorte atual do nó a partir do `object-view-box` (`null` quando o valor não é um `inset()` em %). */
export function cropOfStyle(style: Record<string, string>): ImageCrop | null {
  return parseCrop(style['object-view-box']);
}

/** Retângulo do recorte (px) dentro de uma caixa `w`×`h` que mostra a imagem inteira. */
export function cropToRect(c: ImageCrop, w: number, h: number): Rect {
  return {
    x: (c.left / 100) * w,
    y: (c.top / 100) * h,
    w: ((100 - c.left - c.right) / 100) * w,
    h: ((100 - c.top - c.bottom) / 100) * h,
  };
}

/** Converte um deslocamento em px (na caixa `w`×`h`) para % da imagem. */
export function pxToPct(dx: number, dy: number, w: number, h: number): { dx: number; dy: number } {
  return { dx: w > 0 ? (dx / w) * 100 : 0, dy: h > 0 ? (dy / h) * 100 : 0 };
}

/** Arrasta a alça `handle` por (dx, dy) em %; cada lado fica em 0..100 com ao menos `MIN_CROP_SIZE` visível. */
export function dragCropHandle(
  crop: ImageCrop,
  handle: HandleName,
  dx: number,
  dy: number,
): ImageCrop {
  let { top, right, bottom, left } = crop;
  if (handle.includes('w')) left = Math.min(100 - right - MIN_CROP_SIZE, Math.max(0, left + dx));
  if (handle.includes('e')) right = Math.min(100 - left - MIN_CROP_SIZE, Math.max(0, right - dx));
  if (handle.includes('n')) top = Math.min(100 - bottom - MIN_CROP_SIZE, Math.max(0, top + dy));
  if (handle.includes('s')) bottom = Math.min(100 - top - MIN_CROP_SIZE, Math.max(0, bottom - dy));
  return clampCrop({ top, right, bottom, left });
}

/** Move o retângulo de recorte inteiro por (dx, dy) em %, sem sair da imagem e sem mudar o tamanho. */
export function moveCrop(crop: ImageCrop, dx: number, dy: number): ImageCrop {
  const width = 100 - crop.left - crop.right;
  const height = 100 - crop.top - crop.bottom;
  const left = Math.min(100 - width, Math.max(0, crop.left + dx));
  const top = Math.min(100 - height, Math.max(0, crop.top + dy));
  return clampCrop({
    left,
    top,
    right: round2(100 - width - left),
    bottom: round2(100 - height - top),
  });
}

/** Op que grava o recorte (`object-view-box`) ou o remove (`unset`) quando zerado. `null` se nada muda. */
export function buildCropOp(
  nodeId: string,
  style: Record<string, string>,
  crop: ImageCrop,
): Op | null {
  const css = cropToCss(crop);
  const current = style['object-view-box'];
  if (css === '') {
    return current === undefined
      ? null
      : { type: 'updateStyles', changes: [{ nodeId, unset: ['object-view-box'] }] };
  }
  if (current === css) return null;
  return { type: 'updateStyles', changes: [{ nodeId, set: { 'object-view-box': css } }] };
}

/**
 * Estilos transitórios do modo de recorte: a imagem inteira preenche a caixa (`fill`, sem
 * `object-view-box`), de modo que os % do recorte correspondam à caixa do nó.
 */
export const CROP_MODE_PREVIEW_STYLE: Record<string, string> = {
  'object-fit': 'fill',
  'object-view-box': 'none',
};

/** O `object-fit` do nó diverge do que o modo de recorte usa para calcular (cover/fill)? */
export function cropFitWarning(style: Record<string, string>): boolean {
  const fit = style['object-fit'];
  return fit !== undefined && fit !== 'cover' && fit !== 'fill';
}
