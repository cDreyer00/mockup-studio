import type { CSSProperties } from 'react';
import { ATTR_NAME_RE, isValidTag } from '@mockup/core';
import type { Node } from '@mockup/core';

/** `background-color` → `backgroundColor`; custom properties (`--x`) ficam intactas. */
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

/** Resolve o `src` de imagens: data:/http(s) passam; relativo vira `/assets/<docId>/<src>`. */
export function resolveSrc(docId: string, src: string): string {
  if (/^(data:|https?:)/i.test(src)) return src;
  return `/assets/${docId}/${src.replace(/^\/+/, '')}`;
}

/**
 * SVG como data URI (renderizado via `<img>`, o que desativa scripts e recursos externos). Como
 * imagem o SVG é lido como XML: sem `xmlns` na raiz ele não carrega (sai 0x0), então é acrescentado.
 */
export function svgToDataUri(svg: string): string {
  const s = svg.replace(
    /^(\s*<svg)(?![^>]*\sxmlns\s*=)(?=[\s/>])/i,
    '$1 xmlns="http://www.w3.org/2000/svg"',
  );
  return `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
}

/**
 * Tag válida (minúscula) ou `div` quando inválida/bloqueada. `svg` também vira `div`: o nó SVG é
 * renderizado num `<img>` e nunca passa por aqui com a própria tag.
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

/** Nome de atributo que pode ser repassado ao React com segurança. */
export function isSafeAttrName(name: string): boolean {
  if (!ATTR_NAME_RE.test(name)) return false;
  const n = name.toLowerCase();
  return !FORBIDDEN_ATTRS.has(n) && !n.startsWith('on');
}

/** Repassa atributos seguros (`href` vira `data-href`; `src` só em img). */
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
