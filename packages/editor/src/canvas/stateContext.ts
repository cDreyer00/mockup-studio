/**
 * Contexto dos estados (variantes do Tailwind) na renderização: o frame raiz fornece a largura
 * (breakpoints), o tema `dark` e o pseudo-estado em prévia; nós com `data-theme` redefinem o `dark`
 * para a própria subárvore.
 */
import { createContext } from 'react';
import { BREAKPOINT_PX, fixedWidthPx } from '@mockup/core';
import type { PreviewState, StateContext as CoreStateContext } from '@mockup/core';

export interface StateCtx {
  /** Prévia de estado do editor/render (`null` = nenhuma). */
  preview: PreviewState | null;
  /**
   * Largura "quantizada" do frame raiz: o maior breakpoint já atingido (0 = nenhum). Assim o
   * contexto só muda ao cruzar um breakpoint, e não a cada pixel de um redimensionamento.
   */
  bpWidth: number;
  /** O nó está dentro de um tema `dark` (ou na prévia "dark"). */
  dark: boolean;
}

export const BASE_STATE_CTX: StateCtx = { preview: null, bpWidth: 0, dark: false };

/** No topo (canvas ou página de render) só `preview` importa; o frame raiz completa o resto. */
export const StateCtxContext = createContext<StateCtx>(BASE_STATE_CTX);

/** Maior breakpoint do Tailwind atingido pela largura (0 se nenhum ou largura desconhecida). */
export function quantizeWidth(width: number | undefined): number {
  if (width === undefined) return 0;
  let out = 0;
  for (const px of Object.values(BREAKPOINT_PX)) if (width >= px && px > out) out = px;
  return out;
}

/** Contexto do frame raiz a partir da largura dele (`style.width` ou a da prévia de resize). */
export function rootStateCtx(base: StateCtx, width: string | undefined): StateCtx {
  return {
    preview: base.preview,
    bpWidth: quantizeWidth(fixedWidthPx(width)),
    dark: base.preview === 'dark',
  };
}

/** Contexto para a subárvore de um nó com `data-theme` (`dark` só se o tema for `dark`). */
export function themedStateCtx(ctx: StateCtx, theme: string): StateCtx {
  const dark = ctx.preview === 'dark' || theme === 'dark';
  return dark === ctx.dark ? ctx : { ...ctx, dark };
}

/** Contexto no formato de `resolveStateStyle`. */
export function toCoreContext(ctx: StateCtx): CoreStateContext {
  return {
    frameWidth: ctx.bpWidth,
    dark: ctx.dark,
    pseudo: ctx.preview && ctx.preview !== 'dark' ? ctx.preview : null,
  };
}
