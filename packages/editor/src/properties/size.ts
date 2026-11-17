/** Sizing modes (width/height): Fixed, Auto, 100%, Fill. */
import type { Node } from '@mockup/core';
import { flexDirection, isFlex } from '../model/tree';

export type Axis = 'width' | 'height';
export type SizeModeKind = 'fixed' | 'auto' | 'full' | 'fill' | 'other';

export interface SizeMode {
  mode: SizeModeKind;
  /** Raw CSS value of the axis (`undefined` if absent). */
  value: string | undefined;
}

/** The axis is the main axis of the flex parent. */
export function isMainAxis(parent: Node | null | undefined, axis: Axis): boolean {
  if (!parent || !isFlex(parent)) return false;
  return (flexDirection(parent) === 'row') === (axis === 'width');
}

/** `flex` that represents "fill" (1 1 0 / 1 1 0% / 1 1 0px / 1). */
export function isFillFlex(flex: string | undefined): boolean {
  if (!flex) return false;
  return /^\s*1(\s+1)?(\s+0(%|px)?)?\s*$/.test(flex);
}

export function sizeMode(node: Node, parent: Node | null | undefined, axis: Axis): SizeMode {
  const value = node.style[axis];
  if (isMainAxis(parent, axis) && isFillFlex(node.style.flex) && (!value || value === 'auto')) {
    return { mode: 'fill', value };
  }
  if (value === undefined || value.trim() === '' || value.trim() === 'auto') {
    return { mode: 'auto', value };
  }
  if (value.trim() === '100%') return { mode: 'full', value };
  if (/^\s*-?\d*\.?\d+(px)?\s*$/.test(value)) return { mode: 'fixed', value };
  return { mode: 'other', value };
}

/** Styles to apply when switching mode; `px` is the size to use in Fixed mode. */
export function sizeModeChange(
  node: Node,
  axis: Axis,
  mode: SizeModeKind,
  px: number,
): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  if (isFillFlex(node.style.flex) && mode !== 'fill') unset.push('flex');
  if (mode === 'fixed') set[axis] = `${Math.round(px)}px`;
  else if (mode === 'full') set[axis] = '100%';
  else if (mode === 'auto') unset.push(axis);
  else if (mode === 'fill') {
    set.flex = '1 1 0';
    unset.push(axis);
  }
  return { set, unset };
}
