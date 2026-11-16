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
    out[key] = value;
  }
  return out;
}
