/**
 * Estados de um nó (`node.states`): estilos que só valem numa condição, como as variantes do
 * Tailwind. A chave é a cadeia de variantes em ordem canônica, separada por `:`:
 *
 *   [breakpoint] [dark] [pseudo]      ex.: `hover`, `dark`, `md`, `md:hover`, `dark:hover`, `lg:dark:focus`
 *
 * - breakpoint (`sm`, `md`, `lg`, `xl`, `2xl`): vale quando a largura do frame raiz é maior ou
 *   igual ao breakpoint (mobile first, como no Tailwind; o frame é o viewport do design);
 * - `dark`: vale dentro de um frame/nó com `data-theme="dark"` ou na prévia "dark" do editor;
 * - pseudo (`hover`, `focus`, `focus-visible`, `focus-within`, `active`, `disabled`): vale na
 *   prévia do estado (editor, `get_screenshot(state)`) e no código exportado.
 */
import type { Node } from './types.js';

/** Variante `dark:` do Tailwind no Mockup Studio: o tema `dark` do documento (atributo `data-theme`). */
export const DARK_VARIANT_CSS =
  '@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));';

export const BREAKPOINTS = ['sm', 'md', 'lg', 'xl', '2xl'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Larguras mínimas padrão do Tailwind v4 (`--breakpoint-*`, em px). */
export const BREAKPOINT_PX: Record<Breakpoint, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
};

export const PSEUDO_STATES = [
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'disabled',
] as const;
export type PseudoState = (typeof PSEUDO_STATES)[number];

/** Estados que a prévia do editor e o `get_screenshot(state)` aceitam. */
export const PREVIEW_STATES = [...PSEUDO_STATES, 'dark'] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];

export interface StateKeyParts {
  breakpoint?: Breakpoint;
  dark?: boolean;
  pseudo?: PseudoState;
}

const isBreakpoint = (s: string): s is Breakpoint => (BREAKPOINTS as readonly string[]).includes(s);
const isPseudo = (s: string): s is PseudoState => (PSEUDO_STATES as readonly string[]).includes(s);

/**
 * Lê uma cadeia de variantes (`hover`, `md:hover`, `hover:dark`...) em qualquer ordem. `null` se
 * alguma parte não é suportada, se repete uma categoria ou se está vazia.
 */
export function parseStateKey(key: string): StateKeyParts | null {
  const parts = key.split(':').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === '')) return null;
  const out: StateKeyParts = {};
  for (const p of parts) {
    if (isBreakpoint(p)) {
      if (out.breakpoint) return null;
      out.breakpoint = p;
    } else if (p === 'dark') {
      if (out.dark) return null;
      out.dark = true;
    } else if (isPseudo(p)) {
      if (out.pseudo) return null;
      out.pseudo = p;
    } else return null;
  }
  return out;
}

/** Chave canônica (`breakpoint:dark:pseudo`). */
export function formatStateKey(parts: StateKeyParts): string {
  const out: string[] = [];
  if (parts.breakpoint) out.push(parts.breakpoint);
  if (parts.dark) out.push('dark');
  if (parts.pseudo) out.push(parts.pseudo);
  return out.join(':');
}

/** Normaliza a chave para a forma canônica; `null` se inválida. */
export function normalizeStateKey(key: string): string | null {
  const p = parseStateKey(key);
  if (!p) return null;
  const k = formatStateKey(p);
  return k === '' ? null : k;
}

/**
 * Ordem de aplicação (como a cascata do CSS gerado pelo Tailwind): estados com pseudo-classe
 * (mais específicos) por último; entre iguais, breakpoints menores antes e `dark` depois.
 */
export function stateOrder(key: string): number {
  const p = parseStateKey(key);
  if (!p) return Number.MAX_SAFE_INTEGER;
  const bp = p.breakpoint ? BREAKPOINTS.indexOf(p.breakpoint) + 1 : 0;
  return (p.pseudo ? 100 : 0) + bp * 10 + (p.dark ? 5 : 0);
}

/** Chaves ordenadas pela ordem de aplicação. */
export function sortStateKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => stateOrder(a) - stateOrder(b) || a.localeCompare(b));
}

export interface StateContext {
  /** Largura do frame raiz em px (ativa os breakpoints). Ausente: nenhum breakpoint. */
  frameWidth?: number;
  /** Nó dentro de um tema `dark` (ou prévia "dark"). */
  dark?: boolean;
  /** Pseudo-estado em prévia (hover, focus...). */
  pseudo?: PseudoState | null;
  /** Larguras dos breakpoints (padrão: `BREAKPOINT_PX`). */
  breakpoints?: Partial<Record<Breakpoint, number>>;
}

/** O estado `key` está ativo no contexto? */
export function stateMatches(key: string, ctx: StateContext): boolean {
  const p = parseStateKey(key);
  if (!p) return false;
  if (p.breakpoint) {
    const min = ctx.breakpoints?.[p.breakpoint] ?? BREAKPOINT_PX[p.breakpoint];
    if (ctx.frameWidth === undefined || ctx.frameWidth < min) return false;
  }
  if (p.dark && !ctx.dark) return false;
  if (p.pseudo && ctx.pseudo !== p.pseudo) return false;
  return true;
}

/** `true` se o nó tem algum estado com estilos. */
export function hasStates(node: Node): boolean {
  return !!node.states && Object.values(node.states).some((s) => Object.keys(s).length > 0);
}

/**
 * Estilo efetivo do nó no contexto: `node.style` com os estados ativos aplicados por cima, na
 * ordem de `stateOrder`. Sem estados devolve o próprio `node.style`.
 */
export function resolveStateStyle(node: Node, ctx: StateContext): Record<string, string> {
  if (!node.states) return node.style;
  const active = sortStateKeys(Object.keys(node.states)).filter((k) => stateMatches(k, ctx));
  if (active.length === 0) return node.style;
  const out = { ...node.style };
  for (const k of active) Object.assign(out, node.states[k]);
  return out;
}

/** Largura em px de um valor CSS simples (`1280px`, `80rem`); `undefined` se não for fixo. */
export function fixedWidthPx(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)(px|rem)?\s*$/.exec(value);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return m[2] === 'rem' ? n * 16 : n;
}
