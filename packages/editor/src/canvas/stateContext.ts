/**
 * Contexto dos estados (variantes do Tailwind) na renderização: o frame raiz fornece a largura
 * (breakpoints), o tema `dark` e o pseudo-estado em prévia; nós com `data-theme` redefinem o `dark`
 * para a própria subárvore.
 */
import { createContext } from 'react';
import { BREAKPOINT_PX, fixedWidthPx } from '@mockup/core';
import type { Breakpoint, PreviewState, StateContext as CoreStateContext } from '@mockup/core';

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
  /** Larguras dos breakpoints do documento (`--breakpoint-*`); só o contexto do topo as define. */
  breakpoints: Record<Breakpoint, number>;
  /** O documento tem um tema `dark`: a prévia "dark" põe `data-theme="dark"` no frame raiz. */
  darkTheme: boolean;
}

export const BASE_STATE_CTX: StateCtx = {
  preview: null,
  bpWidth: 0,
  dark: false,
  breakpoints: BREAKPOINT_PX,
  darkTheme: false,
};

/** No topo (canvas ou página de render) só `preview` importa; o frame raiz completa o resto. */
export const StateCtxContext = createContext<StateCtx>(BASE_STATE_CTX);

/** Maior breakpoint do Tailwind atingido pela largura (0 se nenhum ou largura desconhecida). */
export function quantizeWidth(
  width: number | undefined,
  breakpoints: Record<Breakpoint, number> = BREAKPOINT_PX,
): number {
  if (width === undefined) return 0;
  let out = 0;
  for (const px of Object.values(breakpoints)) if (width >= px && px > out) out = px;
  return out;
}

/** Contexto do frame raiz a partir da largura dele (`style.width` ou a da prévia de resize). */
export function rootStateCtx(base: StateCtx, width: string | undefined): StateCtx {
  return {
    ...base,
    bpWidth: quantizeWidth(fixedWidthPx(width), base.breakpoints),
    dark: base.preview === 'dark',
  };
}

/**
 * Contexto para a subárvore de um nó com `data-theme`: `dark` liga com o tema `dark` e, como no CSS
 * exportado (`[data-theme=dark] *`), continua ligado dentro de um tema claro aninhado.
 */
export function themedStateCtx(ctx: StateCtx, theme: string): StateCtx {
  const dark = ctx.dark || ctx.preview === 'dark' || theme === 'dark';
  return dark === ctx.dark ? ctx : { ...ctx, dark };
}

/** Contexto no formato de `resolveStateStyle`. */
export function toCoreContext(ctx: StateCtx): CoreStateContext {
  return {
    frameWidth: ctx.bpWidth,
    breakpoints: ctx.breakpoints,
    dark: ctx.dark,
    pseudo: ctx.preview && ctx.preview !== 'dark' ? ctx.preview : null,
  };
}
