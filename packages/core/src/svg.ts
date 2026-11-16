import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import type { AnyNode, Element } from 'domhandler';

const DROP_ELEMENTS = new Set(['script', 'foreignobject']);

function unsafeHref(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  return v.startsWith('javascript:') || (v.startsWith('data:') && !v.startsWith('data:image/'));
}

function clean(node: Element): void {
  for (const key of Object.keys(node.attribs)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('on')) delete node.attribs[key];
    else if ((lower === 'href' || lower === 'xlink:href') && unsafeHref(node.attribs[key] ?? '')) {
      delete node.attribs[key];
    }
  }
  for (const child of [...node.children] as AnyNode[]) {
    if (DomUtils.isTag(child)) {
      if (DROP_ELEMENTS.has(child.name.toLowerCase())) DomUtils.removeElement(child);
      else clean(child);
    }
  }
}

/**
 * Sanitiza markup SVG: devolve só o primeiro `<svg>`, sem `script`/`foreignObject`,
 * sem atributos `on*` e sem `href`/`xlink:href` com `javascript:` ou `data:` não-imagem.
 * Devolve string vazia se não houver `<svg>`.
 */
export function sanitizeSvg(svg: string): string {
  const dom = parseXml(svg, { xmlMode: true });
  const root = DomUtils.findOne((e) => e.name.toLowerCase() === 'svg', dom.children, true);
  if (!root) return '';
  clean(root);
  return DomUtils.getOuterHTML(root, { xmlMode: true });
}
