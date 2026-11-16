/** Parse/format de valores CSS numéricos com unidade (inputs do painel de propriedades). */

export interface CssNumber {
  value: number;
  /** '' quando sem unidade (ex.: opacity, line-height). */
  unit: string;
}

const NUM_RE = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*([a-z%]*)\s*$/i;

/** `'120px'` → `{ value: 120, unit: 'px' }`; `'auto'`, `'var(--x)'` → `null`. */
export function parseCssNumber(v: string | undefined | null): CssNumber | null {
  if (v === undefined || v === null) return null;
  const m = NUM_RE.exec(v);
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2]!.toLowerCase() };
}

/** Arredonda para no máximo `digits` casas, sem zeros à direita. */
export function round(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

export function formatCssNumber(n: CssNumber): string {
  return `${round(n.value)}${n.unit}`;
}

/**
 * Interpreta o texto digitado pelo usuário: número puro recebe `defaultUnit`; palavras-chave
 * (`auto`, `fit-content`...) e expressões (`calc()`, `var()`) passam como estão. Vazio = remover.
 */
export function normalizeInput(text: string, defaultUnit = 'px'): string {
  const t = text.trim();
  if (t === '') return '';
  const n = parseCssNumber(t);
  if (n) return formatCssNumber({ value: n.value, unit: n.unit || defaultUnit });
  return t;
}
