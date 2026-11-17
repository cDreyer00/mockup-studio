/** Parse/format of numeric CSS values with units (properties panel inputs). */

export interface CssNumber {
  value: number;
  /** '' when unitless (e.g. opacity, line-height). */
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

/** Rounds to at most `digits` decimal places, without trailing zeros. */
export function round(n: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

export function formatCssNumber(n: CssNumber): string {
  return `${round(n.value)}${n.unit}`;
}

/**
 * Interprets the text typed by the user: a plain number gets `defaultUnit`; keywords
 * (`auto`, `fit-content`...) and expressions (`calc()`, `var()`) pass through as they are. Empty = remove.
 */
export function normalizeInput(text: string, defaultUnit = 'px'): string {
  const t = text.trim();
  if (t === '') return '';
  const n = parseCssNumber(t);
  if (n) return formatCssNumber({ value: n.value, unit: n.unit || defaultUnit });
  return t;
}
