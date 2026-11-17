/** Read/write of box properties (padding, margin, border-radius) without shorthand/longhand conflicts. */
import { parseBox, serializeBox } from './css';
import type { Box } from './css';

export interface BoxSpec {
  /** Shorthand (`padding`). */
  prop: string;
  /** Longhands in the order top, right, bottom, left (for radius: TL, TR, BR, BL). */
  sides: [string, string, string, string];
}

export const PADDING: BoxSpec = {
  prop: 'padding',
  sides: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
};
export const MARGIN: BoxSpec = {
  prop: 'margin',
  sides: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
};
export const RADIUS: BoxSpec = {
  prop: 'border-radius',
  sides: [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],
};

const KEYS = ['top', 'right', 'bottom', 'left'] as const;

/** Effective values of the 4 sides: shorthand as the base, longhands on top; '' = absent. */
export function readBox(style: Record<string, string>, spec: BoxSpec): Box {
  const base = parseBox(style[spec.prop]) ?? { top: '', right: '', bottom: '', left: '' };
  const out = { ...base };
  KEYS.forEach((k, i) => {
    const v = style[spec.sides[i]!];
    if (v !== undefined && v !== '') out[k] = v;
  });
  return out;
}

/**
 * Styles to write the box: always the shorthand (empty sides become `0`), removing the longhands
 * so they never coexist. A fully empty box removes everything.
 */
export function writeBox(
  style: Record<string, string>,
  spec: BoxSpec,
  box: Box,
): { set: Record<string, string>; unset: string[] } {
  const present = spec.sides.filter((s) => s in style);
  const empty = KEYS.every((k) => box[k] === '');
  if (empty) {
    return { set: {}, unset: [...(spec.prop in style ? [spec.prop] : []), ...present] };
  }
  const full = Object.fromEntries(
    KEYS.map((k) => [k, box[k] === '' ? '0' : box[k]]),
  ) as unknown as Box;
  return { set: { [spec.prop]: serializeBox(full) }, unset: present };
}

/** Sets all sides to the same value ('' removes). */
export function uniformBox(value: string): Box {
  return { top: value, right: value, bottom: value, left: value };
}
