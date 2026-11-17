/** Import SVG into the `Vector` model and generate markup from it. */
import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import type { Element } from 'domhandler';
import { sanitizeSvg, svgRootAttrs } from '../svg.js';
import type {
  Node,
  Vector,
  VectorGradient,
  VectorPaint,
  VectorPath,
  VectorViewBox,
} from '../types.js';
import {
  IDENTITY,
  commandsBounds,
  ellipsePathData,
  formatNumber,
  multiplyMatrix,
  parsePathData,
  parseTransform,
  rectPathData,
  transformPathData,
} from './path.js';
import type { Matrix } from './path.js';
import { GENERATED_SVG_ATTRS, isSafePaintString } from './schema.js';

/* ------------------------------------------------------------------------------- import */

/** Marks the SVG as "not simple": only `raw` counts, with no editable paths. */
class NotSimple extends Error {}

const bail = (why: string): never => {
  throw new NotSimple(why);
};

const IMPORT_PRECISION = 4;

/** Paint properties inherited from `svg`/`g`. */
const INHERITED = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'fill-rule',
] as const;

/** Properties the model does not represent: only valid if they hold the neutral value. */
const UNSUPPORTED: Record<string, string[]> = {
  'fill-opacity': ['1'],
  'stroke-opacity': ['1'],
  'stroke-miterlimit': ['4'],
  'stroke-dashoffset': ['0'],
  'vector-effect': ['none'],
  'paint-order': ['normal'],
  'mix-blend-mode': ['normal'],
  display: ['inline', 'block'],
  visibility: ['visible'],
  filter: ['none'],
  'clip-path': ['none'],
  mask: ['none'],
  'marker-start': ['none'],
  'marker-mid': ['none'],
  'marker-end': ['none'],
  pathLength: [],
};

const PRESENTATION = new Set<string>([
  ...INHERITED,
  'opacity',
  'stop-color',
  'stop-opacity',
  ...Object.keys(UNSUPPORTED),
]);

const NUMBER_SRC = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const LEN_RE = new RegExp(`^(${NUMBER_SRC})(?:px)?$`);
const NUMBERS_RE = new RegExp(NUMBER_SRC, 'g');

/** Length in user units (`12`, `12px`); other units = not simple. */
function parseLen(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const m = LEN_RE.exec(value.trim());
  if (!m) return bail(`length "${value}"`);
  return parseFloat(m[1]!);
}

/** Fraction `0.5` or `50%`. */
function parseFraction(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const v = value.trim();
  if (v.endsWith('%')) {
    const m = LEN_RE.exec(v.slice(0, -1));
    if (!m) return bail(`fraction "${value}"`);
    return parseFloat(m[1]!) / 100;
  }
  const m = LEN_RE.exec(v);
  if (!m || v.endsWith('px')) return bail(`fraction "${value}"`);
  return parseFloat(m[1]!);
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Presentation properties of the element: attributes and inline `style` (the latter wins). */
function elementProps(el: Element): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attribs)) {
    if (PRESENTATION.has(k)) props[k] = v.trim();
  }
  const style = el.attribs.style;
  if (style) {
    for (const decl of style.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim().toLowerCase();
      const value = decl
        .slice(i + 1)
        .replace(/!important\s*$/i, '')
        .trim();
      if (name === 'transform') bail('transform in style');
      if (PRESENTATION.has(name) || name === 'pathlength') props[name] = value;
    }
  }
  return props;
}

function assertSupported(props: Record<string, string>): void {
  for (const [k, neutral] of Object.entries(UNSUPPORTED)) {
    const v = props[k] ?? props[k.toLowerCase()];
    if (v !== undefined && !neutral.includes(v)) bail(`property "${k}"`);
  }
}

const lname = (el: Element): string => el.name.toLowerCase();

const childElements = (el: Element): Element[] =>
  el.children.filter((c): c is Element => DomUtils.isTag(c));

function parseGradient(el: Element): VectorGradient {
  const type = lname(el) === 'lineargradient' ? 'linear' : 'radial';
  const a = el.attribs;
  for (const k of Object.keys(a)) if (/(^|:)href$/i.test(k)) bail('gradient with href');
  if (a.gradientTransform !== undefined) bail('gradientTransform');
  if (a.gradientUnits !== undefined && a.gradientUnits !== 'objectBoundingBox') {
    bail('gradientUnits');
  }
  if (a.spreadMethod !== undefined && a.spreadMethod !== 'pad') bail('spreadMethod');

  const g: VectorGradient = { type, stops: [] };
  const setFrac = (key: 'x1' | 'y1' | 'x2' | 'y2' | 'cx' | 'cy' | 'r', attr = key): void => {
    if (a[attr] !== undefined) g[key] = parseFraction(a[attr], 0);
  };
  if (type === 'linear') {
    setFrac('x1');
    setFrac('y1');
    setFrac('x2');
    setFrac('y2');
  } else {
    setFrac('cx');
    setFrac('cy');
    setFrac('r');
    const cx = g.cx ?? 0.5;
    const cy = g.cy ?? 0.5;
    if (a.fx !== undefined && parseFraction(a.fx, cx) !== cx) bail('gradient focus');
    if (a.fy !== undefined && parseFraction(a.fy, cy) !== cy) bail('gradient focus');
    if (a.fr !== undefined && parseFraction(a.fr, 0) !== 0) bail('gradient fr');
  }

  let last = 0;
  for (const stop of childElements(el)) {
    if (lname(stop) !== 'stop') bail('gradient child');
    const props = elementProps(stop);
    const offset = Math.max(last, clamp01(parseFraction(stop.attribs.offset, 0)));
    last = offset;
    const color = props['stop-color'] ?? '#000';
    if (!isSafePaintString(color)) bail('stop color');
    const s: VectorGradient['stops'][number] = { offset, color };
    if (props['stop-opacity'] !== undefined) {
      const o = clamp01(parseFraction(props['stop-opacity'], 1));
      if (o !== 1) s.opacity = o;
    }
    g.stops.push(s);
  }
  if (g.stops.length === 0) bail('gradient without stops');
  return g;
}

interface Walk {
  inh: Record<string, string>;
  matrix: Matrix;
}

/** Shape elements → path data (`null`: the element draws nothing). */
function shapeToD(el: Element, name: string): string | null {
  const a = el.attribs;
  try {
    switch (name) {
      case 'path':
        if (!a.d || !a.d.trim()) return null;
        return a.d;
      case 'rect': {
        const w = parseLen(a.width, 0);
        const h = parseLen(a.height, 0);
        if (w <= 0 || h <= 0) return null;
        const x = parseLen(a.x, 0);
        const y = parseLen(a.y, 0);
        const rxv = a.rx === undefined || a.rx === 'auto' ? undefined : parseLen(a.rx, 0);
        const ryv = a.ry === undefined || a.ry === 'auto' ? undefined : parseLen(a.ry, 0);
        const rx = Math.max(0, rxv ?? ryv ?? 0);
        const ry = Math.max(0, ryv ?? rxv ?? 0);
        return rectPathData(x, y, w, h, rx, ry, IMPORT_PRECISION);
      }
      case 'circle': {
        const r = parseLen(a.r, 0);
        if (r <= 0) return null;
        return ellipsePathData(parseLen(a.cx, 0), parseLen(a.cy, 0), r, r, IMPORT_PRECISION);
      }
      case 'ellipse': {
        const rx = parseLen(a.rx, 0);
        const ry = parseLen(a.ry, 0);
        if (rx <= 0 || ry <= 0) return null;
        return ellipsePathData(parseLen(a.cx, 0), parseLen(a.cy, 0), rx, ry, IMPORT_PRECISION);
      }
      case 'line':
        return `M ${parseLen(a.x1, 0)} ${parseLen(a.y1, 0)} L ${parseLen(a.x2, 0)} ${parseLen(a.y2, 0)}`;
      case 'polyline':
      case 'polygon': {
        const nums = (a.points ?? '').match(NUMBERS_RE)?.map(Number) ?? [];
        const count = Math.floor(nums.length / 2);
        if (count < 2) return null;
        let d = '';
        for (let i = 0; i < count; i++)
          d += `${i === 0 ? 'M' : 'L'} ${nums[2 * i]} ${nums[2 * i + 1]} `;
        return name === 'polygon' ? `${d}Z` : d.trim();
      }
    }
  } catch (err) {
    if (err instanceof NotSimple) throw err;
    return bail(`geometry of <${name}>`);
  }
  return null;
}

const DASH_NUMBERS_RE = /^[\s,]*(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px)?[\s,]*)+$/;

function importShape(
  el: Element,
  name: string,
  w: Walk,
  gradients: Map<string, VectorGradient>,
  paths: VectorPath[],
): void {
  const d = shapeToD(el, name);
  if (d === null) return;
  let data: string;
  try {
    data = transformPathData(d, w.matrix, IMPORT_PRECISION);
  } catch {
    return bail('invalid path');
  }
  if (!data) return;

  const own = elementProps(el);
  const { a, b, c, d: md } = w.matrix;
  const axisAligned = Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9 && a > 0 && md > 0;
  const scale = Math.hypot(a, b);
  const scaleY = Math.hypot(c, md);

  const paint = (value: string): VectorPaint => {
    const m = /^url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)\s*(.*)$/i.exec(value);
    if (m) {
      const g = gradients.get(m[1]!);
      if (!g || m[2]!.trim() || !axisAligned) return bail('gradient');
      return JSON.parse(JSON.stringify(g)) as VectorGradient;
    }
    if (!isSafePaintString(value)) return bail(`paint "${value}"`);
    return value;
  };

  const path: VectorPath = { id: `p${paths.length + 1}`, d: data };
  path.fill = paint(w.inh.fill ?? '#000');
  if (w.inh.stroke !== undefined) path.stroke = paint(w.inh.stroke);
  const hasStroke = path.stroke !== undefined && path.stroke !== 'none';
  if (hasStroke && Math.abs(scale - scaleY) > 1e-6 * Math.max(1, scale))
    bail('stroke with anisotropic scale');
  const scaled = Math.abs(scale - 1) > 1e-9;

  if (w.inh['stroke-width'] !== undefined || (hasStroke && scaled)) {
    const sw = parseLen(w.inh['stroke-width'], 1);
    if (sw < 0) bail('negative stroke-width');
    path.strokeWidth = Number(formatNumber(hasStroke ? sw * scale : sw, IMPORT_PRECISION));
  }
  const cap = w.inh['stroke-linecap'];
  if (cap !== undefined) {
    if (cap !== 'butt' && cap !== 'round' && cap !== 'square') bail('stroke-linecap');
    path.strokeLinecap = cap as VectorPath['strokeLinecap'];
  }
  const join = w.inh['stroke-linejoin'];
  if (join !== undefined) {
    if (join !== 'miter' && join !== 'round' && join !== 'bevel') bail('stroke-linejoin');
    path.strokeLinejoin = join as VectorPath['strokeLinejoin'];
  }
  const dash = w.inh['stroke-dasharray'];
  if (dash !== undefined && dash !== 'none') {
    if (!DASH_NUMBERS_RE.test(dash)) bail('stroke-dasharray');
    const nums = dash
      .match(NUMBERS_RE)!
      .map((n) => formatNumber(parseFloat(n) * scale, IMPORT_PRECISION));
    path.strokeDasharray = nums.join(' ');
  }
  const rule = w.inh['fill-rule'];
  if (rule !== undefined) {
    if (rule !== 'nonzero' && rule !== 'evenodd') bail('fill-rule');
    path.fillRule = rule as VectorPath['fillRule'];
  }
  if (own.opacity !== undefined) {
    const o = clamp01(parseFraction(own.opacity, 1));
    if (o !== 1) path.opacity = o;
  }
  paths.push(path);
}

function walkElement(
  el: Element,
  parent: Walk,
  gradients: Map<string, VectorGradient>,
  paths: VectorPath[],
  isRoot = false,
): void {
  const name = lname(el);
  if (name.includes(':')) bail(`element <${el.name}>`);
  if (name === 'title' || name === 'desc') return;
  if (name === 'lineargradient' || name === 'radialgradient') return;
  if (name === 'defs') {
    for (const child of childElements(el)) {
      const n = lname(child);
      if (n !== 'lineargradient' && n !== 'radialgradient') bail(`<${n}> in defs`);
    }
    return;
  }
  const isShape = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(
    name,
  );
  if (!isShape && name !== 'g' && !(isRoot && name === 'svg')) bail(`element <${name}>`);

  const own = elementProps(el);
  assertSupported(own);
  const inh = { ...parent.inh };
  for (const k of INHERITED) {
    const v = own[k];
    if (v !== undefined && v !== 'inherit') inh[k] = v;
  }
  let matrix = parent.matrix;
  if (el.attribs.transform !== undefined) {
    try {
      matrix = multiplyMatrix(matrix, parseTransform(el.attribs.transform));
    } catch {
      bail('invalid transform');
    }
  }
  const here: Walk = { inh, matrix };

  if (isShape) {
    importShape(el, name, here, gradients, paths);
    return;
  }
  // group `opacity` composes with the children in a way that `VectorPath.opacity` does not reproduce
  if (own.opacity !== undefined && parseFraction(own.opacity, 1) !== 1) bail('group opacity');
  for (const child of childElements(el)) walkElement(child, here, gradients, paths);
}

function parseViewBox(value: string | undefined): VectorViewBox | null {
  if (!value) return null;
  const n = value.match(NUMBERS_RE)?.map(Number) ?? [];
  if (n.length !== 4 || !(n[2]! > 0) || !(n[3]! > 0)) return null;
  return { x: n[0]!, y: n[1]!, width: n[2]!, height: n[3]! };
}

/** Attributes of the root `<svg>` that remain valid on regeneration (e.g. `preserveAspectRatio`). */
function extraRootAttrs(root: Element): Record<string, string> | undefined {
  const skip = new Set<string>([
    ...GENERATED_SVG_ATTRS,
    'version',
    'x',
    'y',
    'style',
    'transform',
    'opacity',
    ...PRESENTATION,
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.attribs)) {
    if (skip.has(k) || k.startsWith('xmlns') || /^on/i.test(k) || /(^|:)href$/i.test(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Imports SVG markup. Sanitizes (`sanitizeSvg`) and stores the result in `raw`, intact.
 * `viewBox`: that of the `<svg>` (or `0 0 width height`, or the box of the paths).
 * `paths`: extracted when the SVG is simple: only `svg`, `g`, `path`, `rect`, `circle`, `ellipse`,
 * `line`, `polyline`, `polygon`, `title`, `desc` and `defs` containing only `linearGradient`/
 * `radialGradient` with `stop` (used by `fill`/`stroke` `url(#id)`). Shapes become `d`;
 * `transform` of elements and groups is applied to the points; presentation attributes (and inline `style`
 * with the same properties) inherited from `svg`/`g` are resolved on each path
 * (`fill` defaults to `#000` as in SVG). Anything else (filters, masks, clipPath, `use`,
 * text, image, gradients with `href`/`gradientTransform`/complex `userSpaceOnUse`) = `paths: []`.
 * Also counted as "not simple" is what `VectorPath` does not represent (`fill-opacity`,
 * `stroke-opacity`, `stroke-dashoffset`, markers, group `opacity`, stroke with
 * anisotropic scale, gradient under rotation/mirroring...). Throws if there is no `<svg>`.
 */
export function svgToVector(markup: string): Vector {
  const raw = sanitizeSvg(markup);
  if (!raw) throw new Error('Invalid SVG: there is no <svg> element');
  const dom = parseXml(raw, { xmlMode: true });
  const root = DomUtils.findOne((e) => lname(e) === 'svg', dom.children, true);
  if (!root) throw new Error('Invalid SVG: there is no <svg> element');

  let paths: VectorPath[] = [];
  try {
    const gradients = new Map<string, VectorGradient>();
    for (const g of DomUtils.findAll(
      (e) => lname(e) === 'lineargradient' || lname(e) === 'radialgradient',
      root.children,
    )) {
      if (g.attribs.id) gradients.set(g.attribs.id, parseGradient(g));
      else parseGradient(g);
    }
    walkElement(root, { inh: {}, matrix: IDENTITY }, gradients, paths, true);
  } catch (err) {
    if (!(err instanceof NotSimple)) throw err;
    paths = [];
  }

  let viewBox = parseViewBox(root.attribs.viewBox);
  if (!viewBox) {
    const w = LEN_RE.exec((root.attribs.width ?? '').trim());
    const h = LEN_RE.exec((root.attribs.height ?? '').trim());
    if (w && h && parseFloat(w[1]!) > 0 && parseFloat(h[1]!) > 0) {
      viewBox = { x: 0, y: 0, width: parseFloat(w[1]!), height: parseFloat(h[1]!) };
    }
  }
  if (!viewBox) {
    const cmds = paths.flatMap((p) => parsePathData(p.d));
    const b = commandsBounds(cmds);
    viewBox =
      b.width > 0 && b.height > 0
        ? { x: b.x, y: b.y, width: b.width, height: b.height }
        : { x: 0, y: 0, width: 100, height: 100 };
  }

  const v: Vector = { viewBox, paths, raw };
  const attrs = extraRootAttrs(root) ?? {};
  // Without preserveAspectRatio in the original, the browser uses "xMidYMid meet": we store it so that the
  // regenerated markup (which uses "none" by default) keeps the same drawing.
  if (attrs.preserveAspectRatio === undefined) attrs.preserveAspectRatio = 'xMidYMid meet';
  v.attrs = attrs;
  return v;
}

/** Does the vector have editable paths? */
export function isVectorEditable(v: Vector): boolean {
  return v.paths.length > 0;
}

/** Vector markup: `raw` when present (unedited), otherwise `generateVectorSvg`. */
export function vectorToSvg(v: Vector): string {
  return v.raw ?? generateVectorSvg(v);
}

/* ------------------------------------------------------------------------------- generation */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ATTR_KEY_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

function gradientMarkup(id: string, g: VectorGradient): string {
  const n = (x: number): string => formatNumber(x, 4);
  const stops = g.stops
    .map(
      (s) =>
        `<stop offset="${n(s.offset)}" stop-color="${esc(s.color)}"${
          s.opacity !== undefined && s.opacity !== 1 ? ` stop-opacity="${n(s.opacity)}"` : ''
        }/>`,
    )
    .join('');
  if (g.type === 'linear') {
    return `<linearGradient id="${esc(id)}" x1="${n(g.x1 ?? 0)}" y1="${n(g.y1 ?? 0)}" x2="${n(g.x2 ?? 1)}" y2="${n(g.y2 ?? 0)}">${stops}</linearGradient>`;
  }
  return `<radialGradient id="${esc(id)}" cx="${n(g.cx ?? 0.5)}" cy="${n(g.cy ?? 0.5)}" r="${n(g.r ?? 0.5)}">${stops}</radialGradient>`;
}

/**
 * Generates `<svg xmlns viewBox width="100%" height="100%" ...attrs>` with one `<path>` per item
 * (gradients in `<defs>` with deterministic ids). Output already sanitized and stable.
 */
export function generateVectorSvg(v: Vector): string {
  const n = (x: number): string => formatNumber(x, 4);
  const vb = v.viewBox;
  const defs: string[] = [];
  const body: string[] = [];

  const paintAttr = (name: 'fill' | 'stroke', p: VectorPath): string => {
    const value: VectorPaint | undefined = p[name];
    if (value === undefined) return '';
    if (typeof value === 'string') return ` ${name}="${esc(value)}"`;
    const gid = `g-${p.id}-${name}`;
    defs.push(gradientMarkup(gid, value));
    return ` ${name}="url(#${esc(gid)})"`;
  };

  for (const p of v.paths) {
    let attrs = ` d="${esc(p.d)}"`;
    attrs += paintAttr('fill', p);
    attrs += paintAttr('stroke', p);
    if (p.strokeWidth !== undefined) attrs += ` stroke-width="${n(p.strokeWidth)}"`;
    if (p.strokeLinecap !== undefined) attrs += ` stroke-linecap="${esc(p.strokeLinecap)}"`;
    if (p.strokeLinejoin !== undefined) attrs += ` stroke-linejoin="${esc(p.strokeLinejoin)}"`;
    if (p.strokeDasharray !== undefined) attrs += ` stroke-dasharray="${esc(p.strokeDasharray)}"`;
    if (p.fillRule !== undefined) attrs += ` fill-rule="${esc(p.fillRule)}"`;
    if (p.opacity !== undefined) attrs += ` opacity="${n(p.opacity)}"`;
    body.push(`<path${attrs}/>`);
  }

  let extra = '';
  for (const k of Object.keys(v.attrs ?? {}).sort()) {
    if (
      GENERATED_SVG_ATTRS.includes(k) ||
      k.startsWith('xmlns') ||
      !ATTR_KEY_RE.test(k) ||
      /^on/i.test(k) ||
      /(^|:)(href|style)$/i.test(k)
    ) {
      continue;
    }
    extra += ` ${k}="${esc(v.attrs![k]!)}"`;
  }

  if (v.attrs?.preserveAspectRatio === undefined) extra += ' preserveAspectRatio="none"';
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vb.x)} ${n(vb.y)} ${n(vb.width)} ${n(vb.height)}" width="100%" height="100%"${extra}>`;
  const defsMarkup = defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '';
  return sanitizeSvg(`${head}${defsMarkup}${body.join('')}</svg>`);
}

/** Parses a `preserveAspectRatio` value (`defer` ignored). */
function parsePreserveAspectRatio(value: string): { align: string; slice: boolean } | 'none' {
  const parts = value
    .trim()
    .split(/\s+/)
    .filter((t) => t && t !== 'defer');
  const align = parts[0] ?? 'xMidYMid';
  if (align === 'none') return 'none';
  return { align, slice: parts[1] === 'slice' };
}

/**
 * How the vector is drawn inside the node: `'none'` (stretches to fill) or `{ align, slice }`
 * (e.g. `{ align: 'xMidYMid', slice: false }` = `meet`). Reads `preserveAspectRatio` from the root `<svg>` of
 * `raw` (absent = browser default, `xMidYMid meet`); without `raw`, from `attrs`; with neither,
 * `'none'` (generated markup).
 */
export function vectorPreserveAspectRatio(v: Vector): { align: string; slice: boolean } | 'none' {
  if (v.raw !== undefined) {
    const par = svgRootAttrs(v.raw).preserveAspectRatio;
    return par === undefined ? { align: 'xMidYMid', slice: false } : parsePreserveAspectRatio(par);
  }
  const par = v.attrs?.preserveAspectRatio;
  return par === undefined ? 'none' : parsePreserveAspectRatio(par);
}

/** `node.vector`, or the vector imported from `node.svg` (svg nodes without a model); `null` if there is no markup. */
export function ensureVector(node: Node): Vector | null {
  if (node.vector) return node.vector;
  return node.svg ? svgToVector(node.svg) : null;
}

/** New version of the vector with the changes applied and without `raw` (it is regenerated). */
export function editVector(
  v: Vector,
  patch: Partial<Pick<Vector, 'paths' | 'viewBox' | 'attrs'>>,
): Vector {
  const { raw: _raw, ...rest } = v;
  void _raw;
  return { ...rest, ...patch };
}

/* ------------------------------------------------------------------------------- paint */

/** Paint/stroke change; `null` removes the property from the path. */
export interface VectorPaintPatch {
  fill?: VectorPaint | null;
  stroke?: VectorPaint | null;
  strokeWidth?: number | null;
  opacity?: number | null;
  strokeLinecap?: VectorPath['strokeLinecap'] | null;
  strokeLinejoin?: VectorPath['strokeLinejoin'] | null;
  strokeDasharray?: string | null;
  fillRule?: VectorPath['fillRule'] | null;
}

const PAINT_KEYS = [
  'fill',
  'stroke',
  'strokeWidth',
  'opacity',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeDasharray',
  'fillRule',
] as const;

/** Applies the paint to the paths `pathIds` (default: all); returns an edited vector (without `raw`). */
export function setVectorPaint(v: Vector, patch: VectorPaintPatch, pathIds?: string[]): Vector {
  if (pathIds) {
    const known = new Set(v.paths.map((p) => p.id));
    const missing = pathIds.find((id) => !known.has(id));
    if (missing !== undefined) throw new Error(`Path "${missing}" does not exist in the vector`);
  }
  const target = pathIds ? new Set(pathIds) : null;
  const paths = v.paths.map((p) => {
    if (target && !target.has(p.id)) return p;
    const next: Record<string, unknown> = { ...p };
    for (const key of PAINT_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
    }
    return next as unknown as VectorPath;
  });
  return editVector(v, { paths });
}

const DASH_RE = /^(?:none|[0-9eE.,+\-\s]+)$/;

/**
 * Converts CSS paint styles (`fill`, `stroke`, `stroke-width`, `stroke-linecap`,
 * `stroke-linejoin`, `stroke-dasharray`, `fill-rule`, `fill-opacity` excluded) into a patch; returns the
 * patch and the remaining styles (which belong to the node). Used by `create_shape` and by the panel.
 * Empty value removes the property; a value the model does not accept stays in `rest`.
 */
export function splitPaintStyles(styles: Record<string, string>): {
  paint: VectorPaintPatch;
  rest: Record<string, string>;
} {
  const paint: VectorPaintPatch = {};
  const rest: Record<string, string> = {};
  for (const [key, raw] of Object.entries(styles)) {
    const value = String(raw).trim();
    const name = key.trim().toLowerCase();
    switch (name) {
      case 'fill':
      case 'stroke':
        if (value === '') paint[name] = null;
        else if (isSafePaintString(value)) paint[name] = value;
        else rest[key] = raw;
        break;
      case 'stroke-width': {
        const m = LEN_RE.exec(value);
        if (value === '') paint.strokeWidth = null;
        else if (m && parseFloat(m[1]!) >= 0) paint.strokeWidth = parseFloat(m[1]!);
        else rest[key] = raw;
        break;
      }
      case 'stroke-linecap':
        if (value === '') paint.strokeLinecap = null;
        else if (value === 'butt' || value === 'round' || value === 'square')
          paint.strokeLinecap = value;
        else rest[key] = raw;
        break;
      case 'stroke-linejoin':
        if (value === '') paint.strokeLinejoin = null;
        else if (value === 'miter' || value === 'round' || value === 'bevel')
          paint.strokeLinejoin = value;
        else rest[key] = raw;
        break;
      case 'stroke-dasharray':
        if (value === '' || value === 'none') paint.strokeDasharray = null;
        else if (DASH_RE.test(value)) paint.strokeDasharray = value;
        else rest[key] = raw;
        break;
      case 'fill-rule':
        if (value === '') paint.fillRule = null;
        else if (value === 'nonzero' || value === 'evenodd') paint.fillRule = value;
        else rest[key] = raw;
        break;
      default:
        rest[key] = raw;
    }
  }
  return { paint, rest };
}
