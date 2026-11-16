/** Validação de tags, atributos e tokens na fronteira do modelo (anti-XSS e anti-injeção). */

export const TAG_RE = /^[a-z][a-z0-9-]*$/;

/** Tags que nunca podem existir em um nó (executam código ou alteram o documento hospedeiro). */
export const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
]);

/** Tags void do HTML: não têm filhos nem fechamento. */
export const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

export const ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
export const TOKEN_NAME_RE = /^--[a-zA-Z0-9_-]+$/;

export function isValidTag(tag: string): boolean {
  if (typeof tag !== 'string') return false;
  const t = tag.trim().toLowerCase();
  return TAG_RE.test(t) && !BLOCKED_TAGS.has(t);
}

/** trim + minúsculas; lança se a tag for inválida ou bloqueada (em qualquer caixa). */
export function normalizeTag(tag: string): string {
  const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!TAG_RE.test(t)) {
    throw new Error(
      `Tag inválida: "${String(tag)}" (use letras minúsculas, dígitos e hífen, começando por letra)`,
    );
  }
  if (BLOCKED_TAGS.has(t)) {
    throw new Error(`Tag inválida: "${String(tag)}" é bloqueada por segurança`);
  }
  return t;
}

/** Mensagem de erro se o nome não puder ser usado em `attrs` (sintaxe inválida ou handler `on*`). */
export function attrNameProblem(name: string): string | null {
  if (!ATTR_NAME_RE.test(name)) {
    return `Nome de atributo inválido: "${name}" (use letras, dígitos, "-", "_", ":" ou ".")`;
  }
  if (/^on/i.test(name)) {
    return `Atributo "${name}" não é permitido: handlers de evento (on*) são bloqueados por segurança`;
  }
  return null;
}
