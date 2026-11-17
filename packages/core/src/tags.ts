/** Validation of tags, attributes and tokens at the model boundary (anti-XSS and anti-injection). */

export const TAG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Tags that can never exist on a node: they execute code, load another document, change the
 * parsing namespace (`math`, SVG children) or hold inert content that becomes HTML when
 * cloned (`template`, `noscript`). `svg` is not listed here because it is the tag of the
 * `type: 'svg'` node (rendered isolated in an `<img>`); on nodes of another type it is rejected by `nodeTagProblem`.
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

/** Tags reserved for a node type: `img` only on an `image` node, `svg` only on an `svg` node (and vice versa). */
export const TYPED_TAGS: ReadonlyMap<string, string> = new Map([
  ['img', 'image'],
  ['svg', 'svg'],
  ['video', 'video'],
]);

/** Node types with a fixed tag that is not exclusive to them (effects and embeds are always `div`). */
export const FIXED_TAG_TYPES: ReadonlyMap<string, string> = new Map([
  ['effect', 'div'],
  ['embed', 'div'],
]);

/** Leaf node types (do not accept children). */
export const LEAF_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'svg',
  'effect',
  'video',
  'embed',
]);

/** HTML void tags: they have no children and no closing tag. */
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

/** Theme name: goes into `data-theme="..."` and the `[data-theme="..."]` selector. */
export const THEME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** HTML attribute that applies a theme to a node (frame) and its descendants. */
export const THEME_ATTR = 'data-theme';

export function isValidTag(tag: string): boolean {
  if (typeof tag !== 'string') return false;
  const t = tag.trim().toLowerCase();
  return TAG_RE.test(t) && !BLOCKED_TAGS.has(t);
}

/** trim + lowercase; throws if the tag is invalid or blocked (in any case). */
export function normalizeTag(tag: string): string {
  const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!TAG_RE.test(t)) {
    throw new Error(
      `Invalid tag: "${String(tag)}" (use lowercase letters, digits and hyphens, starting with a letter)`,
    );
  }
  if (BLOCKED_TAGS.has(t)) {
    throw new Error(`Invalid tag: "${String(tag)}" is blocked for security`);
  }
  return t;
}

/**
 * Error message if the (already normalized) tag does not suit the node: `img`/`svg` outside the
 * matching type, an `image`/`svg` node with another tag, or a void tag on a text node or with children.
 */
export function nodeTagProblem(
  node: { id: string; type: string; children: readonly unknown[] },
  tag: string,
): string | null {
  for (const [typedTag, type] of TYPED_TAGS) {
    if (node.type === type && tag !== typedTag) {
      return `Node "${node.id}" (${type}) only accepts the tag "${typedTag}"`;
    }
    if (tag === typedTag && node.type !== type) {
      return `The tag "${tag}" is exclusive to nodes of type ${type}; node "${node.id}" is ${node.type}`;
    }
  }
  const fixed = FIXED_TAG_TYPES.get(node.type);
  if (fixed && tag !== fixed) {
    return `Node "${node.id}" (${node.type}) only accepts the tag "${fixed}"`;
  }
  if (VOID_TAGS.has(tag) && node.type === 'text') {
    return `The tag "${tag}" has no content and does not suit the text node "${node.id}"`;
  }
  if (VOID_TAGS.has(tag) && node.children.length > 0) {
    return `The tag "${tag}" cannot have children, but node "${node.id}" has ${node.children.length}`;
  }
  return null;
}

/** Error message if the name cannot be used in `attrs` (invalid syntax or `on*` handler). */
export function attrNameProblem(name: string): string | null {
  if (!ATTR_NAME_RE.test(name)) {
    return `Invalid attribute name: "${name}" (use letters, digits, "-", "_", ":" or ".")`;
  }
  if (/^on/i.test(name)) {
    return `Attribute "${name}" is not allowed: event handlers (on*) are blocked for security`;
  }
  return null;
}
