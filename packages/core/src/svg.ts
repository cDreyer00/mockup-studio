import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import type { AnyNode, Element } from 'domhandler';

/**
 * Elementos SVG permitidos (lista de permissão). Tudo o que não estiver aqui é removido,
 * inclusive `script`, `style`, `foreignObject`, `animate`/`set` (podem trocar `href` em runtime)
 * e tags HTML (`p`, `iframe`, `embed`...) que fariam o parser HTML sair do contexto SVG no export.
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

/** Nome local do elemento, sem prefixo de namespace (`svg:script` → `script`). */
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

/** `href`, `xlink:href` ou qualquer `prefixo:href` (namespace xlink com outro prefixo). */
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
    // `use` só pode apontar para um fragmento do próprio SVG (sem URLs externas ou data:)
    for (const key of Object.keys(node.attribs)) {
      if (HREF_RE.test(key) && !node.attribs[key]!.trim().startsWith('#')) delete node.attribs[key];
    }
  }
  for (const child of [...node.children] as AnyNode[]) {
    if (DomUtils.isTag(child)) {
      if (!isAllowedElement(child.name)) DomUtils.removeElement(child);
      else clean(child);
    } else if (!DomUtils.isText(child)) {
      // comentários, CDATA e diretivas: o parser HTML fecha comentário também em `--!>`,
      // o que permitiria sair do contexto SVG no HTML exportado
      DomUtils.removeElement(child);
    }
  }
}

/**
 * Sanitiza markup SVG: devolve só o primeiro `<svg>`, mantendo apenas elementos da lista de
 * permissão (formas, texto, gradientes, máscaras, filtros, `use`, `image`...), sem atributos
 * `on*` e sem `href` (com qualquer prefixo) apontando para `javascript:` ou `data:` não-imagem.
 * Comentários, CDATA e diretivas são removidos; `use` só aceita `href="#fragmento"`.
 * Devolve string vazia se não houver `<svg>`.
 */
export function sanitizeSvg(svg: string): string {
  const dom = parseXml(svg, { xmlMode: true });
  const root = DomUtils.findOne((e) => localName(e.name) === 'svg', dom.children, true);
  if (!root) return '';
  clean(root);
  return DomUtils.getOuterHTML(root, { xmlMode: true });
}

/** Atributos do `<svg>` raiz de um markup (vazio se não houver `<svg>`). */
export function svgRootAttrs(svg: string): Record<string, string> {
  const dom = parseXml(svg, { xmlMode: true });
  const root = DomUtils.findOne((e) => localName(e.name) === 'svg', dom.children, true);
  return root ? { ...root.attribs } : {};
}

/**
 * Adiciona/substitui (`set`) e remove (`unset`) atributos do `<svg>` raiz e devolve o markup
 * sanitizado de novo; os valores são escapados na serialização. Markup sem `<svg>` volta igual.
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
 * Prefixa todo `id="x"` do markup com `${prefix}-` e reescreve as referências internas
 * (`url(#x)`, com ou sem aspas, `href="#x"` e `xlink:href="#x"`). Usado na exportação inline,
 * onde vários svgs dividem o mesmo documento e ids iguais (ex. `g-p1-fill`) colidiriam.
 * Referências a ids que não existem no markup ficam intactas.
 */
export function scopeSvgIds(markup: string, prefix: string): string {
  const ids = new Set<string>();
  for (const m of markup.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) ids.add(m[1] ?? m[2] ?? '');
  ids.delete('');
  if (ids.size === 0) return markup;
  const pre = prefix.replace(/[^A-Za-z0-9_-]/g, '_');
  const alt = [...ids].sort((a, b) => b.length - a.length).map(escRe).join('|');
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
