import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import type { AnyNode, Element } from 'domhandler';

/**
 * Allowed SVG elements (allowlist). Everything not listed here is removed,
 * including `script`, `style`, `foreignObject`, `animate`/`set` (they can swap `href` at runtime)
 * and HTML tags (`p`, `iframe`, `embed`...) that would make the HTML parser leave the SVG context on export.
 */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'a',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'use',
  'symbol',
  'title',
  'desc',
  'filter',
  'marker',
  'image',
  'switch',
]);

/** Local element name, without a namespace prefix (`svg:script` → `script`). */
function localName(name: string): string {
  const i = name.indexOf(':');
  return (i >= 0 ? name.slice(i + 1) : name).toLowerCase();
}

function isAllowedElement(name: string): boolean {
  const local = localName(name);
  return ALLOWED_ELEMENTS.has(local) || local.startsWith('fe');
}

function unsafeHref(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  return v.startsWith('javascript:') || (v.startsWith('data:') && !v.startsWith('data:image/'));
}

/** `href`, `xlink:href` or any `prefix:href` (xlink namespace with another prefix). */
const HREF_RE = /(^|:)href$/i;

function clean(node: Element): void {
  for (const key of Object.keys(node.attribs)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('on')) delete node.attribs[key];
    else if (HREF_RE.test(lower) && unsafeHref(node.attribs[key] ?? '')) {
      delete node.attribs[key];
    }
  }
  if (localName(node.name) === 'use') {
    // `use` may only point to a fragment of the SVG itself (no external URLs or data:)
    for (const key of Object.keys(node.attribs)) {
      if (HREF_RE.test(key) && !node.attribs[key]!.trim().startsWith('#')) delete node.attribs[key];
    }
  }
  for (const child of [...node.children] as AnyNode[]) {
    if (DomUtils.isTag(child)) {
      if (!isAllowedElement(child.name)) DomUtils.removeElement(child);
      else clean(child);
    } else if (!DomUtils.isText(child)) {
      // comments, CDATA and directives: the HTML parser also closes a comment on `--!>`,
      // which would allow leaving the SVG context in the exported HTML
      DomUtils.removeElement(child);
    }
  }
}

/**
 * Sanitizes SVG markup: returns only the first `<svg>`, keeping only elements from the
 * allowlist (shapes, text, gradients, masks, filters, `use`, `image`...), without `on*` attributes
 * and without `href` (with any prefix) pointing to `javascript:` or non-image `data:`.
 * Comments, CDATA and directives are removed; `use` only accepts `href="#fragment"`.
 * Returns an empty string if there is no `<svg>`.
 */
export function sanitizeSvg(svg: string): string {
  const dom = parseXml(svg, { xmlMode: true });
  const root = DomUtils.findOne((e) => localName(e.name) === 'svg', dom.children, true);
  if (!root) return '';
  clean(root);
  return DomUtils.getOuterHTML(root, { xmlMode: true });
}

/** Attributes of the root `<svg>` of a markup (empty if there is no `<svg>`). */
export function svgRootAttrs(svg: string): Record<string, string> {
  const dom = parseXml(svg, { xmlMode: true });
  const root = DomUtils.findOne((e) => localName(e.name) === 'svg', dom.children, true);
  return root ? { ...root.attribs } : {};
}

/**
 * Adds/replaces (`set`) and removes (`unset`) attributes of the root `<svg>` and returns the markup
 * sanitized again; values are escaped on serialization. Markup without `<svg>` is returned unchanged.
 */
export function setSvgRootAttrs(svg: string, set: Record<string, string>, unset: string[]): string {
  const dom = parseXml(svg, { xmlMode: true });
  const root = DomUtils.findOne((e) => localName(e.name) === 'svg', dom.children, true);
  if (!root) return svg;
  for (const k of unset) delete root.attribs[k];
  Object.assign(root.attribs, set);
  return sanitizeSvg(DomUtils.getOuterHTML(root, { xmlMode: true }));
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Prefixes every `id="x"` of the markup with `${prefix}-` and rewrites internal references
 * (`url(#x)`, with or without quotes, `href="#x"` and `xlink:href="#x"`). Used in inline export,
 * where several svgs share the same document and equal ids (e.g. `g-p1-fill`) would collide.
 * References to ids that do not exist in the markup are left intact.
 */
export function scopeSvgIds(markup: string, prefix: string): string {
  const ids = new Set<string>();
  for (const m of markup.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    ids.add(m[1] ?? m[2] ?? '');
  ids.delete('');
  if (ids.size === 0) return markup;
  const pre = prefix.replace(/[^A-Za-z0-9_-]/g, '_');
  const alt = [...ids]
    .sort((a, b) => b.length - a.length)
    .map(escRe)
    .join('|');
  let out = markup.replace(
    /(\sid\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (_m, head: string, a?: string, b?: string) => `${head}"${pre}-${a ?? b ?? ''}"`,
  );
  out = out.replace(
    new RegExp(String.raw`url\(\s*(?:&quot;|&apos;|"|')?#(${alt})(?:&quot;|&apos;|"|')?\s*\)`, 'g'),
    (_m, id: string) => `url(#${pre}-${id})`,
  );
  out = out.replace(
    new RegExp(String.raw`(\shref\s*=\s*|:href\s*=\s*)(?:"#(${alt})"|'#(${alt})')`, 'gi'),
    (_m, head: string, a?: string, b?: string) => `${head}"#${pre}-${a ?? b}"`,
  );
  return out;
}
