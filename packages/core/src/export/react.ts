import { documentBaseCssFor } from '../base.js';
import { expandDocument, isVirtualId } from '../components/expand.js';
import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import type { TailwindEngine } from '../tailwind/engine.js';
import type { AnyNode, Element } from 'domhandler';
import { fontFaceCss } from '../fonts.js';
import { isUnsafeUrl, slugify } from '../html.js';
import { toCamelCase } from '../styles.js';
import { sanitizeSvg, scopeSvgIds } from '../svg.js';
import { VOID_TAGS } from '../tags.js';
import { nodeTheme, themeDeclarations } from '../tokens.js';
import type { Document, Node } from '../types.js';
import { effectKinds } from '../effects/catalog.js';
import { effectMountSpec } from '../effects/runtime.js';
import {
  BOOLEAN_ATTRS,
  assetUrl,
  cleanTokens,
  preservesNewlines,
  resolveRoots,
  safeAttrs,
} from './common.js';
import { neutralLeadingSizes, tailwindNodeParts, tailwindThemeCss } from './tailwind.js';
import { createComponentSupport } from './reactComponents.js';
import {
  MOTION_ATTR,
  MotionCollector,
  buildRuntimeFunction,
  hasMotion,
  splitParts,
} from './motion.js';
import type { ComponentSupport, ScopeHooks } from './reactComponents.js';
import {
  mediaElement,
  paramBool,
  reactEffectsFiles,
  reactThreeFiles,
  type MediaAttr,
} from './media.js';
import {
  REACT_MEDIA_BOX,
  REACT_MEDIA_HELPERS,
  REACT_MEDIA_IMPORTS,
  REACT_MEDIA_NAMES,
  REACT_MEDIA_ORDER,
  REACT_MEDIA_TYPES,
  type ReactMediaHelper,
} from './react-media.js';

export interface ReactExportOptions {
  /** Root node of the component (one component per node). */
  nodeId: string;
  /** `tailwind` (default): `className` with Tailwind v4 classes; `inline`: `style={{...}}`. */
  styles?: 'tailwind' | 'inline';
  /** Component name (default: PascalCase of the node name). */
  componentName?: string;
  /** Extracts siblings with the same structure into `items.map(...)` over an array. Default `true`. */
  extractRepeats?: boolean;
  /** Prefix for the `src` of relative images (default `assets/`). */
  assetsBase?: string;
  /** Document's Tailwind engine (see `TailwindExportOptions.tailwind`). */
  tailwind?: TailwindEngine;
  /**
   * Static effects: effect node id → image (relative to `assetsBase`, e.g.
   * `effects/fx_ab12cd34.png`). These effects become `<img>`; the rest stay animated (canvas).
   */
  effectImages?: Record<string, string>;
}

export interface ReactExport {
  componentName: string;
  /** Complete `.tsx` file (exported function component). */
  code: string;
  /**
   * CSS that accompanies the component: with `styles: 'tailwind'`, the theme (`tailwindThemeCss`); with
   * `styles: 'inline'`, the basic reset and the `@font-face` rules (absent if there is nothing to declare).
   */
  css?: string;
  /**
   * Files the component imports, next to the `.tsx`: `mockup-effects.js`/`.d.ts` (effects
   * runtime) and `<slug>-three-<n>.js`/`.d.ts` (Three.js islands). Absent without effects/islands.
   */
  files?: { name: string; code: string }[];
}

/* ====================================================================== */
/* Code utilities                                                          */
/* ====================================================================== */

export const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'await',
  'async',
  'item',
  'index',
]);

/** JS string in single quotes. */
export function jsString(s: string): string {
  return `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

/** JSX attribute value: plain literal or `{'...'}` expression. */
export function attrValue(v: string): string {
  return /^[^"&\n\r\u2028\u2029]*$/.test(v) ? `"${v}"` : `{${jsString(v)}}`;
}

export function words(name: string): string[] {
  const slug = slugify(name);
  return slug === 'node' && !/node/i.test(name) ? [] : slug.split('-').filter(Boolean);
}

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

export function pascalCase(name: string): string {
  return words(name).map(cap).join('');
}

function camelCase(name: string): string {
  const ws = words(name);
  return ws.map((w, i) => (i === 0 ? w : cap(w))).join('');
}

/** Valid component name (PascalCase, starts with a letter). */
export function componentIdent(name: string): string {
  const p = pascalCase(name);
  if (p === '') return 'Component';
  return /^[A-Za-z]/.test(p) ? p : `Component${p}`;
}

/** Safe camelCase identifier from a layer name; `null` if none can be derived. */
export function fieldIdent(name: string): string | null {
  const c = camelCase(name);
  if (c === '' || !/^[a-z]/.test(c)) return null;
  return RESERVED.has(c) ? `${c}Value` : c;
}

/** JSX text for a segment without line breaks. */
function jsxTextSegment(seg: string): string {
  if (seg !== seg.trim() || /[\t\u2028\u2029]/.test(seg)) return `{${jsString(seg)}}`;
  return seg.replace(/&/g, '&amp;').replace(/[{}<>]/g, (c) => `{'${c}'}`);
}

/** JSX children of a text: breaks become `{'\n'}` (white-space preserves) or `<br />`. */
export function textChildren(text: string, preserveNewlines: boolean): string[] {
  const parts = text.split(/\r?\n/);
  const out: string[] = [];
  parts.forEach((seg, i) => {
    if (seg !== '') out.push(jsxTextSegment(seg));
    if (i < parts.length - 1) out.push(preserveNewlines ? "{'\\n'}" : '<br />');
  });
  return out;
}

/* ====================================================================== */
/* Styles                                                                   */
/* ====================================================================== */

const needsCssPropertiesCast = (style: Record<string, string>): boolean =>
  Object.keys(style).some((k) => k.startsWith('--'));

export function reactStyleKey(prop: string): string {
  if (prop.startsWith('--')) return jsString(prop);
  if (prop.startsWith('-ms-')) return `ms${cap(toCamelCase(prop.slice(4)))}`;
  const c = toCamelCase(prop);
  return /^[A-Za-z_$][\w$]*$/.test(c) ? c : jsString(c);
}

export interface Usage {
  cssProperties: boolean;
  /** Some generated component uses `ReactNode` (slot props and `children`). */
  reactNode?: boolean;
  /** Some URL attribute receives `{{prop}}`: the file gets the `safeUrl` helper. */
  safeUrl?: boolean;
}

/** `style={{ ... }}`; custom properties require `as CSSProperties` (flagged in `usage`). */
export function styleProp(style: Record<string, string>, usage: Usage): string {
  const body = Object.entries(style)
    .map(([k, v]) => `${reactStyleKey(k)}: ${jsString(v)}`)
    .join(', ');
  if (needsCssPropertiesCast(style)) {
    usage.cssProperties = true;
    return `style={{ ${body} } as CSSProperties}`;
  }
  return `style={{ ${body} }}`;
}

/* ====================================================================== */
/* Attributes                                                              */
/* ====================================================================== */

/** HTML attribute → React prop (only known attributes are included, so the TSX compiles). */
const PROP_NAMES: Record<string, string> = {
  id: 'id',
  title: 'title',
  lang: 'lang',
  dir: 'dir',
  role: 'role',
  href: 'href',
  target: 'target',
  rel: 'rel',
  type: 'type',
  name: 'name',
  value: 'value',
  placeholder: 'placeholder',
  alt: 'alt',
  src: 'src',
  width: 'width',
  height: 'height',
  disabled: 'disabled',
  checked: 'defaultChecked',
  readonly: 'readOnly',
  required: 'required',
  autofocus: 'autoFocus',
  autocomplete: 'autoComplete',
  maxlength: 'maxLength',
  minlength: 'minLength',
  min: 'min',
  max: 'max',
  step: 'step',
  pattern: 'pattern',
  multiple: 'multiple',
  selected: 'selected',
  for: 'htmlFor',
  tabindex: 'tabIndex',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  cols: 'cols',
  rows: 'rows',
  action: 'action',
  method: 'method',
  enctype: 'encType',
  novalidate: 'noValidate',
  download: 'download',
  hreflang: 'hrefLang',
  draggable: 'draggable',
  hidden: 'hidden',
  spellcheck: 'spellCheck',
  contenteditable: 'contentEditable',
  accesskey: 'accessKey',
  controls: 'controls',
  autoplay: 'autoPlay',
  loop: 'loop',
  muted: 'muted',
  poster: 'poster',
  preload: 'preload',
  playsinline: 'playsInline',
  srcset: 'srcSet',
  sizes: 'sizes',
  loading: 'loading',
  decoding: 'decoding',
  crossorigin: 'crossOrigin',
  referrerpolicy: 'referrerPolicy',
  label: 'label',
  open: 'open',
  start: 'start',
  reversed: 'reversed',
  datetime: 'dateTime',
  cite: 'cite',
  media: 'media',
  form: 'form',
  list: 'list',
  accept: 'accept',
  inputmode: 'inputMode',
  enterkeyhint: 'enterKeyHint',
  translate: 'translate',
};

const NUMERIC_PROPS = new Set([
  'tabIndex',
  'colSpan',
  'rowSpan',
  'cols',
  'rows',
  'maxLength',
  'minLength',
  'start',
]);
const VALUE_AS_DEFAULT = new Set(['input', 'textarea', 'select']);

/** `name=value` snippets of a node's props (without `className`/`style`/image `src`). */
export function attrProps(
  node: Node,
  skip: Set<string>,
  fmt: (v: string, attr?: string) => string = attrValue,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(safeAttrs(node))) {
    const lower = k.toLowerCase();
    if (skip.has(lower)) continue;
    if (/^(aria|data)-[\w.-]+$/i.test(k)) {
      out.push(`${lower}=${fmt(v)}`);
      continue;
    }
    let prop = PROP_NAMES[lower];
    if (!prop || !Object.hasOwn(PROP_NAMES, lower)) continue;
    if (lower === 'value' && VALUE_AS_DEFAULT.has(node.tag)) prop = 'defaultValue';
    if (BOOLEAN_ATTRS.has(lower)) {
      if (v === 'false') continue;
      out.push(prop);
    } else if (NUMERIC_PROPS.has(prop)) {
      if (/^-?\d+$/.test(v.trim())) out.push(`${prop}={${v.trim()}}`);
    } else {
      out.push(`${prop}=${fmt(v, lower)}`);
    }
  }
  return out;
}

/* ====================================================================== */
/* SVG → JSX                                                               */
/* ====================================================================== */

const SVG_ELEMENTS = new Map(
  [
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
    'textPath',
    'a',
    'defs',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
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
    'feBlend',
    'feColorMatrix',
    'feComponentTransfer',
    'feComposite',
    'feConvolveMatrix',
    'feDiffuseLighting',
    'feDisplacementMap',
    'feDistantLight',
    'feDropShadow',
    'feFlood',
    'feFuncA',
    'feFuncB',
    'feFuncG',
    'feFuncR',
    'feGaussianBlur',
    'feImage',
    'feMerge',
    'feMergeNode',
    'feMorphology',
    'feOffset',
    'fePointLight',
    'feSpecularLighting',
    'feSpotLight',
    'feTile',
    'feTurbulence',
  ].map((n) => [n.toLowerCase(), n]),
);

/** JSX prop name of an SVG attribute (`stroke-width` → `strokeWidth`, `xlink:href` → `xlinkHref`). */
function svgPropName(attr: string): string {
  if (attr === 'class') return 'className';
  if (attr === 'for') return 'htmlFor';
  if (/^(aria|data)-/i.test(attr)) return attr;
  if (/[-:]/.test(attr)) {
    return attr.replace(/[-:]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  }
  return attr;
}

/** `fill: red; stroke-width: 2` → [CSS property, value] pairs. */
function parseStyleString(css: string): [string, string][] {
  const out: [string, string][] = [];
  let buf = '';
  let depth = 0;
  let quote = '';
  const flush = (): void => {
    const i = buf.indexOf(':');
    if (i > 0) {
      const k = buf.slice(0, i).trim();
      const v = buf.slice(i + 1).trim();
      if (k && v && /^(--[\w-]+|-?[a-zA-Z][\w-]*)$/.test(k)) out.push([k, v]);
    }
    buf = '';
  };
  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

function svgElementToJsx(
  el: Element,
  depth: number,
  extra: string[],
  usage: Usage,
  isRoot: boolean,
): string[] {
  const local = el.name.includes(':') ? el.name.slice(el.name.indexOf(':') + 1) : el.name;
  const tag = SVG_ELEMENTS.get(local.toLowerCase());
  if (!tag) return [];
  const props: string[] = [];
  for (const [k, v] of Object.entries(el.attribs)) {
    if (isRoot && (k === 'class' || k === 'style')) continue;
    if (/^on/i.test(k) || /^xmlns:(?!xlink$)/i.test(k)) continue;
    if (k === 'style') {
      const entries = Object.fromEntries(parseStyleString(v));
      if (Object.keys(entries).length > 0) props.push(styleProp(entries, usage));
      continue;
    }
    if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(k)) continue;
    props.push(`${svgPropName(k)}=${attrValue(v)}`);
  }
  props.push(...extra);
  const kids: string[][] = [];
  for (const c of el.children as AnyNode[]) {
    if (DomUtils.isTag(c)) {
      const lines = svgElementToJsx(c, depth + 1, [], usage, false);
      if (lines.length > 0) kids.push(lines);
    } else if (DomUtils.isText(c) && c.data.trim() !== '') {
      kids.push(textChildren(c.data, false).map((l) => '  '.repeat(depth + 1) + l));
    }
  }
  return emitElement(tag, props, kids, depth);
}

/** Sanitized SVG markup → JSX lines (`extra` = additional props of the root element). */
function svgToJsx(markup: string, depth: number, extra: string[], usage: Usage): string[] {
  const clean = sanitizeSvg(markup);
  if (!clean) return emitElement('svg', extra, [], depth);
  const dom = parseXml(clean, { xmlMode: true });
  const root = DomUtils.findOne((e) => e.name.toLowerCase() === 'svg', dom.children, true);
  if (!root) return emitElement('svg', extra, [], depth);
  return svgElementToJsx(root, depth, extra, usage, true);
}

/* ====================================================================== */
/* Element emission                                                         */
/* ====================================================================== */

export const pad = (depth: number): string => '  '.repeat(depth);
const MAX_LINE = 100;

/**
 * Builds an element: self-closing without children; one line with a single short text child;
 * otherwise indented children. Props go on their own lines if the tag exceeds `MAX_LINE` columns.
 */
export function emitElement(
  tag: string,
  props: string[],
  kids: string[][],
  depth: number,
): string[] {
  const p = pad(depth);
  const oneLine = `${p}<${tag}${props.length > 0 ? ' ' + props.join(' ') : ''}`;
  // multi-line props (slots as JSX) always go on their own lines
  const multi = oneLine.length > MAX_LINE || props.some((pr) => pr.includes('\n'));
  const out: string[] = [];
  const closeOpen = (selfClose: boolean): void => {
    if (multi) {
      out.push(`${p}<${tag}`);
      // multi-line props (JSX slots, long `className`) arrive indented relative to the prop
      for (const pr of props) out.push(`${p}  ${pr.split('\n').join('\n' + p + '  ')}`);
      out.push(`${p}${selfClose ? '/>' : '>'}`);
    } else out.push(`${oneLine}${selfClose ? ' />' : '>'}`);
  };
  if (kids.length === 0) {
    closeOpen(true);
    return out;
  }
  const flat = kids.flat();
  if (!multi && kids.length === 1 && flat.length === 1 && !flat[0].trimStart().startsWith('<')) {
    const text = flat[0].trim();
    const line = `${oneLine}>${text}</${tag}>`;
    if (line.length <= MAX_LINE) return [line];
  }
  closeOpen(false);
  out.push(...flat);
  out.push(`${p}</${tag}>`);
  return out;
}

/* ====================================================================== */
/* Repeats                                                                  */
/* ====================================================================== */

const VARYING_ATTRS = new Set(['alt', 'href']);

/** Structural signature: tags, types, styles, attributes and tree; ignores text, src, alt and href. */
function signature(node: Node): string {
  const attrs = Object.entries(node.attrs)
    .filter(([k]) => !VARYING_ATTRS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const varying = Object.keys(node.attrs)
    .filter((k) => VARYING_ATTRS.has(k.toLowerCase()))
    .map((k) => k.toLowerCase())
    .sort();
  return JSON.stringify([
    node.type,
    node.tag,
    Object.entries(node.style).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(node.states ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, st]) => [k, Object.entries(st).sort(([a], [b]) => a.localeCompare(b))]),
    attrs,
    varying,
    node.text !== undefined && node.text !== '',
    node.src !== undefined,
    node.type === 'svg' ? [node.svg ?? '', /\sid\s*=/i.test(node.svg ?? '') ? node.id : ''] : null,
    node.type === 'instance' ? [node.componentId, node.props, node.overrides] : null,
    node.children.map(signature),
  ]);
}

type SlotKind = 'text' | 'src' | 'alt' | 'href';

interface SlotRef {
  /** Field name on the item (`item.name`). */
  field: string;
}

type SlotMap = Map<Node, Partial<Record<SlotKind, SlotRef>>>;

const SLOT_SUFFIX: Record<SlotKind, string> = { text: '', src: 'Src', alt: 'Alt', href: 'Href' };

function fieldValue(node: Node, kind: SlotKind, assetsBase: string): string {
  switch (kind) {
    case 'text':
      return node.text ?? '';
    case 'src':
      return node.src === undefined ? '' : assetUrl(node.src, assetsBase);
    case 'alt':
      return node.attrs.alt ?? '';
    case 'href': {
      const h = node.attrs.href ?? '';
      return isUnsafeUrl(h) ? '' : h;
    }
  }
}

function hasKind(node: Node, kind: SlotKind): boolean {
  switch (kind) {
    case 'text':
      return node.text !== undefined && node.text !== '';
    case 'src':
      return node.src !== undefined;
    case 'alt':
      return node.attrs.alt !== undefined;
    case 'href':
      return node.attrs.href !== undefined;
  }
}

interface RunPlan {
  template: Node;
  slots: SlotMap;
  fields: string[];
  items: Record<string, string>[];
}

/** Varying fields of a set of parallel nodes (one per item), in pre-order. */
function planRun(nodes: Node[], assetsBase: string): RunPlan | null {
  const slots: SlotMap = new Map();
  const fields: string[] = [];
  const items: Record<string, string>[] = nodes.map(() => ({}));
  const used = new Set<string>();
  let fallback = 0;
  // layer names that differ between items (e.g. links "Product"/"Pricing") are not usable as a field
  const sameNamesAcross = (parallel: Node[]): boolean =>
    parallel.every((n) => n.name === parallel[0].name);

  const alloc = (node: Node, kind: SlotKind, sameNames: boolean): string => {
    const base = sameNames ? fieldIdent(node.name) : null;
    let name: string;
    if (base === null) {
      fallback++;
      name = kind === 'text' ? `text${fallback}` : `${kind}${fallback}`;
    } else {
      name = base + SLOT_SUFFIX[kind];
    }
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = `${name}${n}`;
    used.add(candidate);
    return candidate;
  };

  const visit = (parallel: Node[]): void => {
    const first = parallel[0];
    for (const kind of ['text', 'src', 'alt', 'href'] as SlotKind[]) {
      if (!hasKind(first, kind)) continue;
      const values = parallel.map((n) => fieldValue(n, kind, assetsBase));
      if (values.every((v) => v === values[0])) continue;
      const field = alloc(first, kind, sameNamesAcross(parallel));
      fields.push(field);
      parallel.forEach((_, i) => (items[i][field] = values[i]));
      slots.set(first, { ...slots.get(first), [kind]: { field } });
    }
    first.children.forEach((_, ci) => visit(parallel.map((n) => n.children[ci])));
  };
  visit(nodes);
  if (fields.length === 0) return null;
  return { template: nodes[0], slots, fields, items };
}

/** Common word prefix of the names (e.g. "Card A", "Card B" → "Card"). */
function commonName(nodes: Node[], parentName: string): string {
  const lists = nodes.map((n) => words(n.name));
  const first = lists[0] ?? [];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (lists.every((l) => l[i] === first[i])) common.push(first[i]);
    else break;
  }
  const base = common.length > 0 ? common.join('-') : parentName;
  return base;
}

/* ====================================================================== */
/* Rendering                                                               */
/* ====================================================================== */

export interface RenderCtx {
  mode: 'tailwind' | 'inline';
  doc: Document;
  /** Node theme (`data-theme`), to redeclare the variables in inline mode. */
  themeOf: (node: Node) => string | undefined;
  tokens: Record<string, string>;
  /** Document's Tailwind engine (canonicalized classes and variants). */
  engine?: TailwindEngine;
  /** `text-*` sizes with `line-height` neutralized in the theme. */
  neutralLeading: ReadonlySet<string>;
  assetsBase: string;
  extractRepeats: boolean;
  usage: Usage;
  arrays: string[];
  usedNames: Set<string>;
  slots?: SlotMap;
  /** Component support (instances as JSX, one component per main component used). */
  components?: ComponentSupport;
  /** Present while rendering the body of a main component (props, variants and slots). */
  scope?: ScopeHooks;
  media: ReactMedia;
  /** Node animations (CSS `@keyframes`, `data-mk` attributes, build runtime). */
  motion: MotionCollector;
}

/** What media nodes require in the file: helpers, imports and extra files. */
interface ReactMedia {
  effectImages: Record<string, string>;
  slug: string;
  helpers: Set<ReactMediaHelper>;
  /** Import lines for the Three.js islands. */
  imports: string[];
  files: { name: string; code: string }[];
  threeCount: number;
}

function uniqueName(base: string, ctx: RenderCtx): string {
  let name = base;
  for (let n = 2; ctx.usedNames.has(name); n++) name = `${base}${n}`;
  ctx.usedNames.add(name);
  return name;
}

/** Tailwind classes and inline declarations of a node (`inline`: style only; `tailwind`: classes + whatever did not become a class). */
export function styleParts(
  node: Node,
  ctx: RenderCtx,
  isRoot: boolean,
): { classes: string[]; style: Record<string, string> } {
  if (ctx.mode === 'inline') {
    const theme = ctx.themeOf(node);
    const style = {
      ...(isRoot ? ctx.tokens : {}),
      ...(theme ? themeDeclarations(ctx.doc, theme) : {}),
      ...node.style,
    };
    return { classes: [], style };
  }
  const { classes, rest } = tailwindNodeParts(node, ctx.tokens, {
    engine: ctx.engine,
    neutralLeading: ctx.neutralLeading,
  });
  return { classes, style: rest };
}

function styleProps(node: Node, ctx: RenderCtx, isRoot: boolean): string[] {
  if (ctx.scope) return ctx.scope.styleProps(node, ctx);
  const { classes, style } = styleParts(node, ctx, isRoot);
  const out: string[] = [];
  if (classes.length > 0) out.push(`className=${attrValue(classes.join(' '))}`);
  if (Object.keys(style).length > 0) out.push(styleProp(style, ctx.usage));
  return out;
}

export function renderNode(
  node: Node,
  depth: number,
  ctx: RenderCtx,
  inheritedPre: boolean,
  isRoot: boolean,
  extraProps: string[] = [],
): string[] {
  if (node.type === 'instance' && ctx.components) {
    return ctx.components.renderInstance(node, depth, ctx, inheritedPre, isRoot, extraProps);
  }
  const slot = ctx.slots?.get(node) ?? {};
  const pre = node.style['white-space']
    ? preservesNewlines(node.style['white-space'])
    : inheritedPre;
  const props: string[] = [...extraProps, ...styleProps(node, ctx, isRoot)];
  ctx.motion.register(node);
  const mk = ctx.motion.keyOf(node);
  if (mk !== undefined) props.push(`${MOTION_ATTR}="${mk}"`);

  if (node.type === 'svg') {
    return svgToJsx(scopeSvgIds(sanitizeSvg(node.svg ?? ''), node.id), depth, props, ctx.usage);
  }

  if (node.type === 'effect' || node.type === 'video' || node.type === 'embed') {
    const lines = renderMedia(node, depth, ctx, props);
    if (lines) return lines;
  }

  const isImg = node.type === 'image' || node.tag === 'img';
  if (isImg) {
    const fmt = ctx.scope?.attrValue ?? attrValue;
    if (slot.src) props.push(`src={item.${slot.src.field}}`);
    else if (node.src !== undefined) {
      if (ctx.scope?.hasPlaceholder(node.src)) props.push(`src=${fmt(node.src, 'src')}`);
      else {
        const url = assetUrl(node.src, ctx.assetsBase);
        if (!isUnsafeUrl(url)) props.push(`src=${attrValue(url)}`);
      }
    }
    if (slot.alt) props.push(`alt={item.${slot.alt.field}}`);
    else props.push(`alt=${fmt(node.attrs.alt ?? '')}`);
  }
  const skip = new Set<string>(isImg ? ['src', 'alt'] : []);
  if (slot.href) skip.add('href');
  props.push(...attrProps(node, skip, ctx.scope?.attrValue));
  if (slot.href) props.push(`href={item.${slot.href.field}}`);

  if (VOID_TAGS.has(node.tag)) return emitElement(node.tag, props, [], depth);

  const kids: string[][] = [];
  if (slot.text) kids.push([`{item.${slot.text.field}}`].map((l) => pad(depth + 1) + l));
  else if (node.text !== undefined && node.text !== '' && !ctx.scope && ctx.motion.splitOf(node)) {
    kids.push(splitJsx(node.text, ctx.motion.splitOf(node)!, depth + 1, ctx.usage));
  } else if (node.text !== undefined && node.text !== '') {
    const lines = ctx.scope?.textChildren(node, pre) ?? textChildren(node.text, pre);
    kids.push(lines.map((l) => pad(depth + 1) + l));
  }
  const slotKids = ctx.scope?.slotChildren(node, depth + 1, ctx, pre);
  kids.push(...(slotKids ?? renderChildren(node.children, depth + 1, ctx, pre, node)));
  return emitElement(node.tag, props, kids, depth);
}

/** JSX of a split text: the same span structure as the editor (see `splitParts`). */
function splitJsx(text: string, mode: 'words' | 'chars', depth: number, usage: Usage): string[] {
  const seg = (t: string, i: number): string =>
    `<span data-motion-seg="" ${styleProp({ '--mi': String(i) }, usage)}>${jsxTextSegment(t)}</span>`;
  const out: string[] = [];
  for (const p of splitParts(text, mode)) {
    if (p.type === 'text') out.push(...textChildren(p.text, true).map((l) => pad(depth) + l));
    else if (p.type === 'seg') out.push(pad(depth) + seg(p.text, p.index));
    else {
      out.push(`${pad(depth)}<span data-motion-word="">`);
      for (const s of p.segs) out.push(pad(depth + 1) + seg(s.text, s.index));
      out.push(`${pad(depth)}</span>`);
    }
  }
  return out;
}

/* ---------------- Media (effect, video, embed) ---------------- */

/** HTML media attribute → JSX prop. */
const MEDIA_PROPS: Record<string, string> = {
  autoplay: 'autoPlay',
  playsinline: 'playsInline',
  allowfullscreen: 'allowFullScreen',
};

function mediaJsxProps(attrs: MediaAttr[]): string[] {
  return attrs.map(([k, v]) => {
    const prop = MEDIA_PROPS[k] ?? k;
    return v === true ? prop : `${prop}=${attrValue(v)}`;
  });
}

/** Typed constant at the top of the file (stable reference across renders). */
function moduleConst(
  ctx: RenderCtx,
  node: Node,
  suffix: string,
  type: string,
  value: unknown,
): string {
  const name = uniqueName(`${fieldIdent(node.name) ?? 'media'}${suffix}`, ctx);
  ctx.arrays.push(`const ${name}: ${type} = ${JSON.stringify(value, null, 2)};`);
  return name;
}

/** JSX for a media node; `null` when the spec is missing (falls back to the regular element). */
function renderMedia(node: Node, depth: number, ctx: RenderCtx, props: string[]): string[] | null {
  const m = ctx.media;
  const url = (ref: string): string | null => {
    const u = assetUrl(ref, ctx.assetsBase);
    return isUnsafeUrl(u) ? null : u;
  };

  if (node.type === 'effect' && node.effect) {
    const image = m.effectImages[node.id];
    const src = image !== undefined ? url(image) : null;
    if (src) return emitElement('img', [`src=${attrValue(src)}`, 'alt=""', ...props], [], depth);
    const { kind, category, params, selects } = effectMountSpec(node.effect);
    m.helpers.add('effect');
    const spec = moduleConst(ctx, node, 'Effect', 'EffectMount', {
      kind,
      category,
      params,
      ...(selects ? { selects } : {}),
    });
    return emitElement('MockupEffect', [`spec={${spec}}`, ...props], [], depth);
  }

  if (node.type === 'embed' && node.embed) {
    const e = node.embed;
    if (e.provider === 'lottie' || e.provider === 'rive') {
      const src = e.src ? url(e.src) : null;
      if (!src) return null;
      const out = [`src=${attrValue(src)}`];
      if (!paramBool(e.params, 'autoplay', true)) out.push('autoplay={false}');
      if (e.provider === 'lottie') {
        if (!paramBool(e.params, 'loop', true)) out.push('loop={false}');
        m.helpers.add('lottie');
        return emitElement('MockupLottie', [...out, ...props], [], depth);
      }
      for (const [param, prop] of [
        ['artboard', 'artboard'],
        ['stateMachine', 'stateMachine'],
      ] as const) {
        const v = e.params?.[param];
        if (typeof v === 'string' && v !== '') out.push(`${prop}=${attrValue(v)}`);
      }
      m.helpers.add('rive');
      return emitElement('MockupRive', [...out, ...props], [], depth);
    }
    if (e.provider === 'three') {
      if (typeof e.code !== 'string') return null;
      m.threeCount++;
      const file = `${m.slug}-three-${m.threeCount}`;
      const setup = uniqueName(`setupThree${m.threeCount}`, ctx);
      m.files.push(...reactThreeFiles(file, e.code));
      m.imports.push(`import { setup as ${setup} } from './${file}.js';`);
      m.helpers.add('three');
      const params = moduleConst(ctx, node, 'Params', 'ThreeParams', e.params ?? {});
      return emitElement(
        'ThreeIsland',
        [`setup={${setup}}`, `params={${params}}`, ...props],
        [],
        depth,
      );
    }
  }

  // video, YouTube and iframe: native element
  const el = mediaElement(node, { mode: 'live', url });
  if (!el) return null;
  return emitElement(el.tag, [...mediaJsxProps(el.attrs), ...props], [], depth);
}

/** Header (imports, types and helpers) that media nodes require; empty without media. */
function mediaPreamble(m: ReactMedia, extraTypes: string[] = []): string[] {
  if (m.helpers.size === 0) return [];
  const types = ['CSSProperties', ...extraTypes].map((t) => `type ${t}`).join(', ');
  const out = [`import { useEffect, useRef, ${types} } from 'react';`];
  for (const h of REACT_MEDIA_ORDER) {
    const imp = m.helpers.has(h) ? REACT_MEDIA_IMPORTS[h] : null;
    if (imp) out.push(imp);
  }
  out.push(...m.imports, '', REACT_MEDIA_BOX);
  for (const h of REACT_MEDIA_ORDER) {
    const t = m.helpers.has(h) ? REACT_MEDIA_TYPES[h] : null;
    if (t) out.push(t);
  }
  out.push('');
  for (const h of REACT_MEDIA_ORDER) if (m.helpers.has(h)) out.push(REACT_MEDIA_HELPERS[h], '');
  if (m.helpers.has('effect')) {
    // runtime with the fragments of the WHOLE catalog: the file is the same for all components
    const all = new Map<string, string | undefined>();
    for (const kind of effectKinds()) all.set(kind, effectMountSpec({ kind, params: {} }).fragment);
    m.files.unshift(...reactEffectsFiles(all));
  }
  return out;
}

/** Children of a node; repeated siblings become `array.map(...)` when `extractRepeats` is on. */
export function renderChildren(
  children: Node[],
  depth: number,
  ctx: RenderCtx,
  pre: boolean,
  parent: Node,
): string[][] {
  const out: string[][] = [];
  let i = 0;
  // animated nodes keep their own element (`data-mk` is per element): no `map` extraction
  while (i < children.length) {
    let j = i + 1;
    if (ctx.extractRepeats && !ctx.slots) {
      const sig = signature(children[i]);
      while (j < children.length && signature(children[j]) === sig) j++;
    }
    const run = children.slice(i, j);
    const animated = (parent.animations?.length ?? 0) > 0 || run.some(hasMotion);
    const plan = run.length >= 2 && !animated ? planRun(run, ctx.assetsBase) : null;
    if (plan) {
      const arrayName = uniqueName(
        `${camelCaseOr(commonName(run, parent.name), 'items')}Items`,
        ctx,
      );
      ctx.arrays.push(arrayLiteral(arrayName, plan));
      const inner = renderNode(
        plan.template,
        depth + 1,
        { ...ctx, slots: plan.slots },
        pre,
        false,
        ['key={index}'],
      );
      out.push([`${pad(depth)}{${arrayName}.map((item, index) => (`, ...inner, `${pad(depth)}))}`]);
      i = j;
      continue;
    }
    out.push(renderNode(children[i], depth, ctx, pre, false));
    i++;
  }
  return out;
}

/** `const name = [{ ... }, ...]`: one item per line; fields on their own lines if it exceeds 100 columns. */
function arrayLiteral(name: string, plan: RunPlan): string {
  const rows = plan.items.map((it) => {
    const fields = plan.fields.map((f) => `${f}: ${jsString(it[f])}`);
    const line = `  { ${fields.join(', ')} },`;
    if (line.length <= MAX_LINE) return line;
    return ['  {', ...fields.map((f) => `    ${f},`), '  },'].join('\n');
  });
  return ['const ' + name + ' = [', ...rows, '];'].join('\n');
}

function camelCaseOr(slug: string, fallback: string): string {
  const c = fieldIdent(slug.replace(/-/g, ' '));
  return c ?? fallback;
}

/* ====================================================================== */
/* API                                                                     */
/* ====================================================================== */

/** Helper emitted once when a URL attribute receives `{{prop}}` (same criterion as `isUnsafeUrl`). */
const SAFE_URL_HELPER = [
  'function safeUrl(url: string): string {',
  "  const v = url.replace(/[\\s\\u0000-\\u001f]+/g, '').toLowerCase();",
  '  const unsafe =',
  "    v.startsWith('javascript:') ||",
  "    v.startsWith('vbscript:') ||",
  "    (v.startsWith('data:') && !v.startsWith('data:image/'));",
  "  return unsafe ? '#' : url;",
  '}',
];

/** Generates a function TSX component from a node (Vite + React + TypeScript strict). */
export function exportReact(doc: Document, options: ReactExportOptions): ReactExport {
  const mode = options.styles ?? 'tailwind';
  // virtual ids (`in_x/...`) only exist in the expanded tree; the others keep instances
  // as they are (they become JSX components)
  const [root] = resolveRoots(isVirtualId(options.nodeId) ? expandDocument(doc) : doc, {
    nodeIds: [options.nodeId],
  });
  const componentName = componentIdent(options.componentName ?? root.name);
  const usage: Usage = { cssProperties: false };
  const ctx: RenderCtx = {
    mode,
    doc,
    themeOf: (node) => nodeTheme(doc, node),
    tokens: cleanTokens(doc.tokens),
    engine: options.tailwind,
    neutralLeading: neutralLeadingSizes(doc),
    assetsBase: options.assetsBase ?? 'assets/',
    extractRepeats: options.extractRepeats ?? true,
    usage,
    arrays: [],
    usedNames: new Set([
      componentName,
      'CSSProperties',
      'ReactNode',
      'safeUrl',
      'installBuilds',
      ...REACT_MEDIA_NAMES,
    ]),
    media: {
      effectImages: options.effectImages ?? {},
      slug: componentName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
      helpers: new Set(),
      imports: [],
      files: [],
      threeCount: 0,
    },
    motion: new MotionCollector(),
  };
  ctx.components = createComponentSupport(doc, ctx);

  const body = renderNode(root, 2, ctx, false, true);
  // main components render before the preamble: media nodes inside them also register helpers
  const generated = ctx.components.renderAll(); // one component per main component used
  const code = mediaPreamble(ctx.media, usage.reactNode ? ['ReactNode'] : []);
  const { files } = ctx.media;
  if (code.length === 0) {
    const types = [
      usage.cssProperties ? 'CSSProperties' : '',
      usage.reactNode ? 'ReactNode' : '',
    ].filter(Boolean);
    if (ctx.motion.hasBuilds) {
      const named = ['useEffect', ...types.map((t) => `type ${t}`)];
      code.push(`import { ${named.join(', ')} } from 'react';`, '');
    } else if (types.length > 0) {
      code.push(`import type { ${types.join(', ')} } from 'react';`, '');
    }
  }
  if (usage.safeUrl) code.push(...SAFE_URL_HELPER, '');
  if (ctx.motion.hasBuilds) code.push(...buildRuntimeFunction(), '');
  for (const a of ctx.arrays) code.push(a, '');
  for (const g of generated) code.push(g, '');
  code.push(
    `export function ${componentName}() {`,
    ...(ctx.motion.hasBuilds ? ['  useEffect(() => installBuilds(), []);', ''] : []),
    '  return (',
    ...body,
    '  );',
    '}',
    '',
    `export default ${componentName};`,
    '',
  );

  let css: string | undefined;
  if (mode === 'tailwind') css = tailwindThemeCss(doc, { assetsBase: ctx.assetsBase });
  else {
    const faces = fontFaceCss(doc, (f) => `${ctx.assetsBase}${f}`, 'swap');
    css = `${documentBaseCssFor(doc)}\n${faces ? faces + '\n' : ''}`;
  }
  const motionCss = ctx.motion.css();
  if (motionCss) css = `${css}${css.endsWith('\n') ? '' : '\n'}${motionCss}\n`;
  return { componentName, code: code.join('\n'), css, ...(files.length > 0 ? { files } : {}) };
}
