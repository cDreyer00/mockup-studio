/** CSS property utilities (canonical kebab-case). */

const NAME_RE = /^(--[a-zA-Z0-9_-]+|-?[a-zA-Z_][a-zA-Z0-9_-]*)$/;

export function isValidCssPropertyName(name: string): boolean {
  return NAME_RE.test(name);
}

/** `backgroundColor` → `background-color`; custom properties (`--x`) are preserved. */
export function toKebabCase(name: string): string {
  if (name.startsWith('--')) return name;
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** `background-color` → `backgroundColor`. */
export function toCamelCase(name: string): string {
  if (name.startsWith('--')) return name;
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Normalizes a style map: kebab-case, trim, drops empty values, validates names. */
export function normalizeStyles(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(styles ?? {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue).trim();
    if (value === '') continue;
    const key = toKebabCase(rawKey.trim());
    if (!isValidCssPropertyName(key)) {
      throw new Error(`Invalid CSS property name: "${rawKey}"`);
    }
    const problem = cssValueProblem(value);
    if (problem) throw new Error(`Invalid CSS value in "${key}": ${problem}`);
    out[key] = value;
  }
  return out;
}

const PLACEHOLDER_IN_CSS_RE = /\{\{\s*[A-Za-z_][\w-]*\s*\}\}/g;

/**
 * Error message if the CSS value could escape its declaration or the `<style>` containing it
 * (`{`, `}`, `;` outside quotes/parentheses, `</style`, comments, unbalanced quotes or
 * parentheses); `null` if the value is safe. `;` inside parentheses is accepted (`url(data:...;base64,...)`).
 */
export function cssValueProblem(value: string): string | null {
  if (/<\/style/i.test(value)) return 'must not contain "</style"';
  // Component prop placeholders (`{{color}}`, see docs/COMPONENTS.md): a balanced pair of braces
  // with an identifier inside does not escape the declaration; expansion substitutes and
  // validates the final value again.
  value = value.replace(PLACEHOLDER_IN_CSS_RE, 'x');
  let quote = '';
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      if (--depth < 0) return 'has ")" without a matching "("';
    } else if (ch === '{' || ch === '}') return 'must not contain "{" or "}" outside quotes';
    else if (ch === ';' && depth === 0)
      return 'must not contain ";" outside quotes and parentheses';
    else if (ch === '/' && value[i + 1] === '*') return 'must not contain CSS comments';
  }
  if (quote) return 'has unclosed quotes';
  if (depth > 0) return 'has "(" without a matching ")"';
  return null;
}

/** Drops (without throwing) declarations with an invalid name or value; leaves the others untouched. */
export function dropUnsafeStyles(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles ?? {})) {
    if (typeof v !== 'string') continue;
    if (isValidCssPropertyName(k) && cssValueProblem(v) === null) out[k] = v;
  }
  return out;
}
