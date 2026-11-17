const SVG_NS = 'http://www.w3.org/2000/svg';

/** Propriedades de pintura de SVG que a CSS da página pode ter definido e que o `<img>` perderia. */
const PAINT_PROPS: Record<string, string> = {
  fill: 'rgb(0, 0, 0)',
  stroke: 'none',
  'stroke-width': '1px',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  opacity: '1',
};
const INHERITED_PAINT = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-opacity',
  'stroke-opacity',
]);

function hrefOf(use: Element): string {
  return use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
}

/** Copia para dentro do clone os elementos referenciados por `<use href="#id">` fora do svg. */
function resolveUses(clone: SVGSVGElement, original: SVGSVGElement, depth = 0): void {
  if (depth > 3) return;
  const doc = original.ownerDocument;
  const present = new Set(Array.from(clone.querySelectorAll('[id]')).map((e) => e.id));
  const added: Element[] = [];
  for (const use of Array.from(clone.querySelectorAll('use'))) {
    const href = hrefOf(use);
    if (!href.startsWith('#') || href.length < 2) continue;
    const id = decodeURIComponent(href.slice(1));
    if (present.has(id)) continue;
    const target = doc.getElementById(id);
    if (!target) continue;
    const copy = target.cloneNode(true) as Element;
    present.add(id);
    added.push(copy);
  }
  if (added.length === 0) return;
  const defs = doc.createElementNS(SVG_NS, 'defs');
  for (const a of added) defs.appendChild(a);
  clone.insertBefore(defs, clone.firstChild);
  // Símbolos podem referenciar outros símbolos.
  resolveUses(clone, original, depth + 1);
}

/** Estampa como atributos a pintura computada (CSS da página) nos elementos do clone. */
function stampPaint(orig: Element, clone: Element, parentCs: CSSStyleDeclaration | null): void {
  if (clone.localName === 'defs' || clone.localName === 'symbol') return;
  const cs = getComputedStyle(orig);
  for (const [prop, initial] of Object.entries(PAINT_PROPS)) {
    const v = cs.getPropertyValue(prop);
    if (!v || v.includes('url(')) continue;
    const base = parentCs && INHERITED_PAINT.has(prop) ? parentCs.getPropertyValue(prop) : initial;
    if (v !== base) clone.setAttribute(prop, v);
  }
  const oc = Array.from(orig.children);
  const cc = Array.from(clone.children);
  for (let i = 0; i < oc.length && i < cc.length; i++) {
    if (oc[i]!.localName === cc[i]!.localName) stampPaint(oc[i]!, cc[i]!, cs);
  }
}

/**
 * Markup do `<svg>` inline para o nó `svg`: sem `style`/`class`, com `width`/`height` do
 * retângulo, `currentColor` trocado pela cor computada e `<use>` resolvido.
 */
export function serializeSvg(
  svg: SVGSVGElement,
  color: string,
  width: number,
  height: number,
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const origW = parseFloat(svg.getAttribute('width') ?? '');
  const origH = parseFloat(svg.getAttribute('height') ?? '');
  if (!clone.hasAttribute('viewBox') && origW > 0 && origH > 0) {
    clone.setAttribute('viewBox', `0 0 ${origW} ${origH}`);
  }
  resolveUses(clone, svg);
  // Pintura dos filhos (o raiz herda da página, que o canvas não tem: compara com o inicial).
  const rootCs = getComputedStyle(svg);
  for (const [prop, initial] of Object.entries(PAINT_PROPS)) {
    const v = rootCs.getPropertyValue(prop);
    if (v && !v.includes('url(') && v !== initial) clone.setAttribute(prop, v);
  }
  const oc = Array.from(svg.children);
  // `defs` inserido por resolveUses fica no começo do clone: alinha pelas posições originais.
  const offset = clone.children.length - oc.length;
  for (let i = 0; i < oc.length; i++) {
    const c = clone.children[i + offset];
    if (c && c.localName === oc[i]!.localName) stampPaint(oc[i]!, c, rootCs);
  }
  clone.removeAttribute('style');
  clone.removeAttribute('class');
  clone.setAttribute('width', String(Math.round(width * 100) / 100));
  clone.setAttribute('height', String(Math.round(height * 100) / 100));
  if (!clone.hasAttribute('xmlns')) clone.setAttribute('xmlns', SVG_NS);
  let markup = new XMLSerializer().serializeToString(clone);
  markup = markup.replace(/currentcolor/gi, color);
  return markup;
}
