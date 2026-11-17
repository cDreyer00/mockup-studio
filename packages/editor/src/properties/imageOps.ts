/** Pure logic of the "Image" section: builds the style deltas (without touching the DOM, store or network). */
import {
  CLIP_PATH_PRESETS,
  IMAGE_FILTERS,
  OBJECT_POSITION_PRESETS,
  composeImageFilters,
  mergeImageFilters,
  normalizeObjectPosition,
  parseImageFilters,
  resolveClipPath,
} from '@mockup/core';
import type { ImageFilterName } from '@mockup/core';
import type { StyleDelta } from './shared';

/** Known filter values (what the panel shows); unknown functions are left out. */
export function filterValues(filter: string | undefined): Partial<Record<ImageFilterName, number>> {
  return parseImageFilters(filter).filters;
}

/** `filter` delta when changing a filter (`null` goes back to neutral); preserves unknown functions. */
export function filterDelta(
  current: string | undefined,
  name: ImageFilterName,
  value: number | null,
): StyleDelta | null {
  const next = mergeImageFilters(current, { [name]: value });
  if (next === (current ?? '')) return null;
  return next ? { set: { filter: next } } : { unset: ['filter'] };
}

/** `filter` value with the filter swapped, for the live preview (`''` = none). */
export function filterPreview(
  current: string | undefined,
  name: ImageFilterName,
  value: number,
): string {
  return mergeImageFilters(current, { [name]: value });
}

/** "Reset": zeroes all the panel filters and keeps the rest (`drop-shadow`, `url()`...). */
export function resetFiltersDelta(current: string | undefined): StyleDelta | null {
  if (!current) return null;
  const { rest } = parseImageFilters(current);
  const next = composeImageFilters({}, rest);
  if (next === current) return null;
  return next ? { set: { filter: next } } : { unset: ['filter'] };
}

/** Is any panel filter away from neutral? */
export function hasActiveFilters(filter: string | undefined): boolean {
  const f = filterValues(filter);
  return IMAGE_FILTERS.some((d) => f[d.name] !== undefined && f[d.name] !== d.neutral);
}

/** `clip-path` delta from a preset (`circle`), `none`/empty (removes) or free CSS. */
export function clipPathDelta(value: string): StyleDelta {
  const css = resolveClipPath(value);
  return css ? { set: { 'clip-path': css } } : { unset: ['clip-path'] };
}

/** Position shortcuts in a 3x3 grid (row by row) with the CSS value of each. */
export const POSITION_GRID: { key: string; value: string }[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
].map((key) => ({ key, value: OBJECT_POSITION_PRESETS[key]! }));

/** `object-position` delta (accepts a preset name or CSS). */
export function objectPositionDelta(value: string): StyleDelta {
  const v = normalizeObjectPosition(value);
  return v ? { set: { 'object-position': v } } : { unset: ['object-position'] };
}

/** Current position normalized to compare with the grid (`center` → `50% 50%`). */
export function positionKey(value: string | undefined | null): string | null {
  if (value === undefined) return 'center';
  if (value === null) return null;
  const v = normalizeObjectPosition(value).replace(/\s+/g, ' ');
  return POSITION_GRID.find((p) => p.value === v)?.key ?? null;
}

export const CLIP_PRESET_KEYS = Object.keys(CLIP_PATH_PRESETS);
