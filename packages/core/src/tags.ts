/** Validação de tags, atributos e tokens na fronteira do modelo (anti-XSS e anti-injeção). */

export const TAG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Tags que nunca podem existir em um nó: executam código, carregam outro documento, mudam o
 * namespace de parsing (`math`, filhos de SVG) ou guardam conteúdo inerte que vira HTML ao ser
 * clonado (`template`, `noscript`). `svg` não entra aqui porque é a tag do nó `type: 'svg'`
 * (renderizado isolado num `<img>`); em nós de outro tipo ela é recusada por `nodeTagProblem`.
 */
export const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'math',
  'animate',
  'set',
  'foreignobject',
  'template',
  'noscript',
  'frame',
  'frameset',
  'applet',
  'portal',
]);

/** Tags reservadas a um tipo de nó: `img` só em nó `image`, `svg` só em nó `svg` (e vice-versa). */
export const TYPED_TAGS: ReadonlyMap<string, string> = new Map([
  ['img', 'image'],
  ['svg', 'svg'],
  ['video', 'video'],
]);

/** Tipos de nó com tag fixa que não é exclusiva deles (efeitos e embeds são sempre `div`). */
export const FIXED_TAG_TYPES: ReadonlyMap<string, string> = new Map([
  ['effect', 'div'],
  ['embed', 'div'],
]);

/** Tipos de nó folha (não aceitam filhos). */
export const LEAF_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'svg',
  'effect',
  'video',
  'embed',
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

/**
 * Mensagem de erro se a tag (já normalizada) não servir para o nó: `img`/`svg` fora do tipo
 * correspondente, nó `image`/`svg` com outra tag, ou tag void em nó de texto ou com filhos.
 */
export function nodeTagProblem(
  node: { id: string; type: string; children: readonly unknown[] },
  tag: string,
): string | null {
  for (const [typedTag, type] of TYPED_TAGS) {
    if (node.type === type && tag !== typedTag) {
      return `O nó "${node.id}" (${type}) só aceita a tag "${typedTag}"`;
    }
    if (tag === typedTag && node.type !== type) {
      return `A tag "${tag}" é exclusiva de nós do tipo ${type}; o nó "${node.id}" é ${node.type}`;
    }
  }
  const fixed = FIXED_TAG_TYPES.get(node.type);
  if (fixed && tag !== fixed) {
    return `O nó "${node.id}" (${node.type}) só aceita a tag "${fixed}"`;
  }
  if (VOID_TAGS.has(tag) && node.type === 'text') {
    return `A tag "${tag}" não tem conteúdo e não serve para o nó de texto "${node.id}"`;
  }
  if (VOID_TAGS.has(tag) && node.children.length > 0) {
    return `A tag "${tag}" não pode ter filhos, mas o nó "${node.id}" tem ${node.children.length}`;
  }
  return null;
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
