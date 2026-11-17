const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG paint properties that the page's CSS may have set and that the `<img>` would lose. */
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

/** Copies into the clone the elements referenced by `<use href="#id">` outside the svg. */
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
  // Symbols can reference other symbols.
  resolveUses(clone, original, depth + 1);
}

/** Stamps the computed paint (the page's CSS) as attributes on the clone's elements. */
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
 * Markup of the inline `<svg>` for the `svg` node: without `style`/`class`, with the rectangle's
 * `width`/`height`, `currentColor` replaced by the computed color and `<use>` resolved.
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
  // Paint of the children (the root inherits from the page, which the canvas does not have: compare with the initial value).
  const rootCs = getComputedStyle(svg);
  for (const [prop, initial] of Object.entries(PAINT_PROPS)) {
    const v = rootCs.getPropertyValue(prop);
    if (v && !v.includes('url(') && v !== initial) clone.setAttribute(prop, v);
  }
  const oc = Array.from(svg.children);
  // The `defs` inserted by resolveUses sits at the start of the clone: align by the original positions.
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
