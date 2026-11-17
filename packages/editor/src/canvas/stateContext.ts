/**
 * States context (Tailwind variants) during rendering: the root frame provides the width
 * (breakpoints), the `dark` theme and the pseudo-state in preview; nodes with `data-theme` redefine `dark`
 * for their own subtree.
 */
import { createContext } from 'react';
import { BREAKPOINT_PX, fixedWidthPx } from '@mockup/core';
import type { Breakpoint, PreviewState, StateContext as CoreStateContext } from '@mockup/core';

export interface StateCtx {
  /** State preview from the editor/render (`null` = none). */
  preview: PreviewState | null;
  /**
   * "Quantized" width of the root frame: the largest breakpoint reached so far (0 = none). This way the
   * context only changes when crossing a breakpoint, not on every pixel of a resize.
   */
  bpWidth: number;
  /** The node is inside a `dark` theme (or in the "dark" preview). */
  dark: boolean;
  /** Widths of the document's breakpoints (`--breakpoint-*`); only the top context defines them. */
  breakpoints: Record<Breakpoint, number>;
  /** The document has a `dark` theme: the "dark" preview sets `data-theme="dark"` on the root frame. */
  darkTheme: boolean;
}

export const BASE_STATE_CTX: StateCtx = {
  preview: null,
  bpWidth: 0,
  dark: false,
  breakpoints: BREAKPOINT_PX,
  darkTheme: false,
};

/** At the top (canvas or render page) only `preview` matters; the root frame fills in the rest. */
export const StateCtxContext = createContext<StateCtx>(BASE_STATE_CTX);

/** Largest Tailwind breakpoint reached by the width (0 if none or the width is unknown). */
export function quantizeWidth(
  width: number | undefined,
  breakpoints: Record<Breakpoint, number> = BREAKPOINT_PX,
): number {
  if (width === undefined) return 0;
  let out = 0;
  for (const px of Object.values(breakpoints)) if (width >= px && px > out) out = px;
  return out;
}

/** Root frame context from its width (`style.width` or the resize preview's). */
export function rootStateCtx(base: StateCtx, width: string | undefined): StateCtx {
  return {
    ...base,
    bpWidth: quantizeWidth(fixedWidthPx(width), base.breakpoints),
    dark: base.preview === 'dark',
  };
}

/**
 * Context for the subtree of a node with `data-theme`: `dark` turns on with the `dark` theme and, as in the
 * exported CSS (`[data-theme=dark] *`), stays on inside a nested light theme.
 */
export function themedStateCtx(ctx: StateCtx, theme: string): StateCtx {
  const dark = ctx.dark || ctx.preview === 'dark' || theme === 'dark';
  return dark === ctx.dark ? ctx : { ...ctx, dark };
}

/** Context in the `resolveStateStyle` format. */
export function toCoreContext(ctx: StateCtx): CoreStateContext {
  return {
    frameWidth: ctx.bpWidth,
    breakpoints: ctx.breakpoints,
    dark: ctx.dark,
    pseudo: ctx.preview && ctx.preview !== 'dark' ? ctx.preview : null,
  };
}
