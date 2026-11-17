/**
 * Pure geometry of the visual image crop. The crop is an `ImageCrop` (% of each side of the
 * whole image); during crop mode the whole image fills the node box and the crop
 * rectangle is drawn over it. Nothing here touches the DOM, store or network.
 */
import { clampCrop, cropToCss, parseCrop } from '@mockup/core';
import type { ImageCrop, Op } from '@mockup/core';
import type { HandleName, Rect } from './geometry';

/** Minimum width/height (in %) of the crop rectangle. */
export const MIN_CROP_SIZE = 1;

export const NO_CROP: ImageCrop = { top: 0, right: 0, bottom: 0, left: 0 };

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function isEmptyCrop(c: ImageCrop): boolean {
  return c.top === 0 && c.right === 0 && c.bottom === 0 && c.left === 0;
}

export function sameCrop(a: ImageCrop, b: ImageCrop): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Current crop of the node from `object-view-box` (`null` when the value is not an `inset()` in %). */
export function cropOfStyle(style: Record<string, string>): ImageCrop | null {
  return parseCrop(style['object-view-box']);
}

/** Crop rectangle (px) inside a `w`×`h` box that shows the whole image. */
export function cropToRect(c: ImageCrop, w: number, h: number): Rect {
  return {
    x: (c.left / 100) * w,
    y: (c.top / 100) * h,
    w: ((100 - c.left - c.right) / 100) * w,
    h: ((100 - c.top - c.bottom) / 100) * h,
  };
}

/** Converts a displacement in px (in the `w`×`h` box) to % of the image. */
export function pxToPct(dx: number, dy: number, w: number, h: number): { dx: number; dy: number } {
  return { dx: w > 0 ? (dx / w) * 100 : 0, dy: h > 0 ? (dy / h) * 100 : 0 };
}

/** Drags the `handle` by (dx, dy) in %; each side stays within 0..100 with at least `MIN_CROP_SIZE` visible. */
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

/** Moves the whole crop rectangle by (dx, dy) in %, without leaving the image and without changing the size. */
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

/** Op that writes the crop (`object-view-box`) or removes it (`unset`) when reset. `null` if nothing changes. */
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
 * Transient styles of crop mode: the whole image fills the box (`fill`, without
 * `object-view-box`), so the crop % match the node box.
 */
export const CROP_MODE_PREVIEW_STYLE: Record<string, string> = {
  'object-fit': 'fill',
  'object-view-box': 'none',
};

/** Does the node's `object-fit` differ from what crop mode uses to compute (cover/fill)? */
export function cropFitWarning(style: Record<string, string>): boolean {
  const fit = style['object-fit'];
  return fit !== undefined && fit !== 'cover' && fit !== 'fill';
}
