/** Utilitários de propriedades CSS (kebab-case canônico). */

const NAME_RE = /^(--[a-zA-Z0-9_-]+|-?[a-zA-Z_][a-zA-Z0-9_-]*)$/;

export function isValidCssPropertyName(name: string): boolean {
  return NAME_RE.test(name);
}

/** `backgroundColor` → `background-color`; custom properties (`--x`) são preservadas. */
export function toKebabCase(name: string): string {
  if (name.startsWith('--')) return name;
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** `background-color` → `backgroundColor`. */
export function toCamelCase(name: string): string {
  if (name.startsWith('--')) return name;
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Normaliza um mapa de estilos: kebab-case, trim, remove vazios, valida nomes. */
export function normalizeStyles(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(styles ?? {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue).trim();
    if (value === '') continue;
    const key = toKebabCase(rawKey.trim());
    if (!isValidCssPropertyName(key)) {
      throw new Error(`Nome de propriedade CSS inválido: "${rawKey}"`);
    }
    const problem = cssValueProblem(value);
    if (problem) throw new Error(`Valor CSS inválido em "${key}": ${problem}`);
    out[key] = value;
  }
  return out;
}

/**
 * Mensagem de erro se o valor CSS puder escapar da declaração ou do `<style>` que o contém
 * (`{`, `}`, `;` fora de aspas/parênteses, `</style`, comentários, aspas ou parênteses
 * desbalanceados); `null` se o valor é seguro. `;` dentro de parênteses é aceito (`url(data:...;base64,...)`).
 */
export function cssValueProblem(value: string): string | null {
  if (/<\/style/i.test(value)) return 'não pode conter "</style"';
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
      if (--depth < 0) return 'tem ")" sem "(" correspondente';
    } else if (ch === '{' || ch === '}') return 'não pode conter "{" nem "}" fora de aspas';
    else if (ch === ';' && depth === 0) return 'não pode conter ";" fora de aspas e parênteses';
    else if (ch === '/' && value[i + 1] === '*') return 'não pode conter comentários CSS';
  }
  if (quote) return 'tem aspas não fechadas';
  if (depth > 0) return 'tem "(" sem ")" correspondente';
  return null;
}

/** Descarta (sem lançar) declarações com nome ou valor inválido; não altera as demais. */
export function dropUnsafeStyles(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles ?? {})) {
    if (typeof v !== 'string') continue;
    if (isValidCssPropertyName(k) && cssValueProblem(v) === null) out[k] = v;
  }
  return out;
}
