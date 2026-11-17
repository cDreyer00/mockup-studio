import type { CSSProperties } from 'react';
import { ATTR_NAME_RE, isValidTag } from '@mockup/core';
import type { Node } from '@mockup/core';

/** `background-color` → `backgroundColor`; custom properties (`--x`) stay intact. */
export function kebabToCamel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  const p = prop.startsWith('-ms-') ? prop.slice(1) : prop;
  return p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function convertStyle(style: Record<string, string>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(style)) out[kebabToCamel(k)] = v;
  return out as CSSProperties;
}

/** Resolves the `src` of images: data:/http(s) pass through; relative becomes `/assets/<docId>/<src>`. */
export function resolveSrc(docId: string, src: string): string {
  if (/^(data:|https?:)/i.test(src)) return src;
  return `/assets/${docId}/${src.replace(/^\/+/, '')}`;
}

/**
 * SVG as a data URI (rendered via `<img>`, which disables scripts and external resources). As an
 * image the SVG is read as XML: without `xmlns` on the root it does not load (comes out 0x0), so it is added.
 */
export function svgToDataUri(svg: string): string {
  const s = svg.replace(
    /^(\s*<svg)(?![^>]*\sxmlns\s*=)(?=[\s/>])/i,
    '$1 xmlns="http://www.w3.org/2000/svg"',
  );
  return `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
}

/**
 * Valid tag (lowercase) or `div` when invalid/blocked. `svg` also becomes `div`: the SVG node is
 * rendered in an `<img>` and never comes through here with its own tag.
 */
export function resolveTag(tag: string): string {
  const t = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  return isValidTag(t) && t !== 'svg' ? t : 'div';
}

const FORBIDDEN_ATTRS = new Set([
  'dangerouslysetinnerhtml',
  'ref',
  'key',
  'children',
  'style',
  'srcdoc',
  'formaction',
]);

/** Attribute name that can be safely passed on to React. */
export function isSafeAttrName(name: string): boolean {
  if (!ATTR_NAME_RE.test(name)) return false;
  const n = name.toLowerCase();
  return !FORBIDDEN_ATTRS.has(n) && !n.startsWith('on');
}

/** Passes on safe attributes (`href` becomes `data-href`; `src` only on img). */
export function safeAttrs(node: Node, docId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs ?? {})) {
    if (!isSafeAttrName(k)) continue;
    const key = k.toLowerCase();
    if (key === 'href') out['data-href'] = v;
    else if (key === 'src') {
      if (node.tag === 'img') out.src = resolveSrc(docId, v);
    } else if (key === 'class') out.className = v;
    else if (key === 'for') out.htmlFor = v;
    else out[k] = v;
  }
  return out;
}
