import { DomUtils, parseDocument as parseXml } from 'htmlparser2';
import type { AnyNode, Element } from 'domhandler';
import { fontFaceCss } from '../fonts.js';
import { isUnsafeUrl, slugify } from '../html.js';
import { toCamelCase } from '../styles.js';
import { sanitizeSvg } from '../svg.js';
import { VOID_TAGS } from '../tags.js';
import type { Document, Node } from '../types.js';
import {
  BASE_CSS,
  BOOLEAN_ATTRS,
  assetUrl,
  cleanTokens,
  preservesNewlines,
  resolveRoots,
  safeAttrs,
} from './common.js';
import { cssToTailwind, tailwindThemeCss } from './tailwind.js';

export interface ReactExportOptions {
  /** Nó raiz do componente (um componente por nó). */
  nodeId: string;
  /** `tailwind` (padrão): `className` com classes Tailwind v4; `inline`: `style={{...}}`. */
  styles?: 'tailwind' | 'inline';
  /** Nome do componente (padrão: PascalCase do nome do nó). */
  componentName?: string;
  /** Extrai irmãos com a mesma estrutura em `items.map(...)` sobre um array. Padrão `true`. */
  extractRepeats?: boolean;
  /** Prefixo do `src` de imagens relativas (padrão `assets/`). */
  assetsBase?: string;
}

export interface ReactExport {
  componentName: string;
  /** Arquivo `.tsx` completo (componente funcional exportado). */
  code: string;
  /**
   * CSS que acompanha o componente: com `styles: 'tailwind'`, o tema (`tailwindThemeCss`); com
   * `styles: 'inline'`, o reset básico e os `@font-face` (ausente se não houver nada a declarar).
   */
  css?: string;
}

/* ====================================================================== */
/* Utilitários de código                                                   */
/* ====================================================================== */

const RESERVED = new Set([
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

/** String JS entre aspas simples. */
function jsString(s: string): string {
  return `'${s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

/** Valor de atributo JSX: literal simples ou expressão `{'...'}`. */
function attrValue(v: string): string {
  return /^[^"&\n\r\u2028\u2029]*$/.test(v) ? `"${v}"` : `{${jsString(v)}}`;
}

function words(name: string): string[] {
  const slug = slugify(name);
  return slug === 'node' && !/node/i.test(name) ? [] : slug.split('-').filter(Boolean);
}

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

function pascalCase(name: string): string {
  return words(name).map(cap).join('');
}

function camelCase(name: string): string {
  const ws = words(name);
  return ws.map((w, i) => (i === 0 ? w : cap(w))).join('');
}

/** Nome de componente válido (PascalCase, começa por letra). */
function componentIdent(name: string): string {
  const p = pascalCase(name);
  if (p === '') return 'Component';
  return /^[A-Za-z]/.test(p) ? p : `Component${p}`;
}

/** Identificador camelCase seguro a partir de um nome de camada; `null` se não der. */
function fieldIdent(name: string): string | null {
  const c = camelCase(name);
  if (c === '' || !/^[a-z]/.test(c)) return null;
  return RESERVED.has(c) ? `${c}Value` : c;
}

/** Texto JSX de um trecho sem quebras de linha. */
function jsxTextSegment(seg: string): string {
  if (seg !== seg.trim() || /[\t\u2028\u2029]/.test(seg)) return `{${jsString(seg)}}`;
  return seg.replace(/&/g, '&amp;').replace(/[{}<>]/g, (c) => `{'${c}'}`);
}

/** Filhos JSX de um texto: quebras viram `{'\n'}` (white-space preserva) ou `<br />`. */
function textChildren(text: string, preserveNewlines: boolean): string[] {
  const parts = text.split(/\r?\n/);
  const out: string[] = [];
  parts.forEach((seg, i) => {
    if (seg !== '') out.push(jsxTextSegment(seg));
    if (i < parts.length - 1) out.push(preserveNewlines ? "{'\\n'}" : '<br />');
  });
  return out;
}

/* ====================================================================== */
/* Estilos                                                                 */
/* ====================================================================== */

const needsCssPropertiesCast = (style: Record<string, string>): boolean =>
  Object.keys(style).some((k) => k.startsWith('--'));

function reactStyleKey(prop: string): string {
  if (prop.startsWith('--')) return jsString(prop);
  if (prop.startsWith('-ms-')) return `ms${cap(toCamelCase(prop.slice(4)))}`;
  const c = toCamelCase(prop);
  return /^[A-Za-z_$][\w$]*$/.test(c) ? c : jsString(c);
}

interface Usage {
  cssProperties: boolean;
}

/** `style={{ ... }}`; custom properties exigem `as CSSProperties` (marcado em `usage`). */
function styleProp(style: Record<string, string>, usage: Usage): string {
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
/* Atributos                                                               */
/* ====================================================================== */

/** Atributo HTML → prop do React (só atributos conhecidos entram, para o TSX compilar). */
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

/** Trechos `nome=valor` das props de um nó (sem `className`/`style`/`src` de imagem). */
function attrProps(node: Node, skip: Set<string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(safeAttrs(node))) {
    const lower = k.toLowerCase();
    if (skip.has(lower)) continue;
    if (/^(aria|data)-[\w.-]+$/i.test(k)) {
      out.push(`${lower}=${attrValue(v)}`);
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
      out.push(`${prop}=${attrValue(v)}`);
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

/** Nome da prop JSX de um atributo SVG (`stroke-width` → `strokeWidth`, `xlink:href` → `xlinkHref`). */
function svgPropName(attr: string): string {
  if (attr === 'class') return 'className';
  if (attr === 'for') return 'htmlFor';
  if (/^(aria|data)-/i.test(attr)) return attr;
  if (/[-:]/.test(attr)) {
    return attr.replace(/[-:]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  }
  return attr;
}

/** `fill: red; stroke-width: 2` → pares [propriedade CSS, valor]. */
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

/** Markup SVG sanitizado → linhas de JSX (`extra` = props adicionais do elemento raiz). */
function svgToJsx(markup: string, depth: number, extra: string[], usage: Usage): string[] {
  const clean = sanitizeSvg(markup);
  if (!clean) return emitElement('svg', extra, [], depth);
  const dom = parseXml(clean, { xmlMode: true });
  const root = DomUtils.findOne((e) => e.name.toLowerCase() === 'svg', dom.children, true);
  if (!root) return emitElement('svg', extra, [], depth);
  return svgElementToJsx(root, depth, extra, usage, true);
}

/* ====================================================================== */
/* Emissão de elementos                                                    */
/* ====================================================================== */

const pad = (depth: number): string => '  '.repeat(depth);
const MAX_LINE = 100;

/**
 * Monta um elemento: auto-fechado sem filhos; uma linha com um único filho de texto curto;
 * senão filhos recuados. Props vão para linhas próprias se a tag passar de `MAX_LINE` colunas.
 */
function emitElement(tag: string, props: string[], kids: string[][], depth: number): string[] {
  const p = pad(depth);
  const oneLine = `${p}<${tag}${props.length > 0 ? ' ' + props.join(' ') : ''}`;
  const multi = oneLine.length > MAX_LINE;
  const out: string[] = [];
  const closeOpen = (selfClose: boolean): void => {
    if (multi) {
      out.push(`${p}<${tag}`);
      for (const pr of props) out.push(`${p}  ${pr}`);
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
/* Repetições                                                              */
/* ====================================================================== */

const VARYING_ATTRS = new Set(['alt', 'href']);

/** Assinatura estrutural: tags, tipos, estilos, atributos e árvore; ignora texto, src, alt e href. */
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
    attrs,
    varying,
    node.text !== undefined && node.text !== '',
    node.src !== undefined,
    node.type === 'svg' ? (node.svg ?? '') : null,
    node.children.map(signature),
  ]);
}

type SlotKind = 'text' | 'src' | 'alt' | 'href';

interface SlotRef {
  /** Nome do campo no item (`item.nome`). */
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

/** Campos variáveis de um conjunto de nós paralelos (um por item), em pré-ordem. */
function planRun(nodes: Node[], assetsBase: string): RunPlan | null {
  const slots: SlotMap = new Map();
  const fields: string[] = [];
  const items: Record<string, string>[] = nodes.map(() => ({}));
  const used = new Set<string>();
  let fallback = 0;
  // nomes de camada diferentes entre os itens (ex.: links "Produto"/"Preços") não servem de campo
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

/** Prefixo comum de palavras dos nomes (ex.: "Card A", "Card B" → "Card"). */
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
/* Renderização                                                            */
/* ====================================================================== */

interface RenderCtx {
  mode: 'tailwind' | 'inline';
  tokens: Record<string, string>;
  assetsBase: string;
  extractRepeats: boolean;
  usage: Usage;
  arrays: string[];
  usedNames: Set<string>;
  slots?: SlotMap;
}

function uniqueName(base: string, ctx: RenderCtx): string {
  let name = base;
  for (let n = 2; ctx.usedNames.has(name); n++) name = `${base}${n}`;
  ctx.usedNames.add(name);
  return name;
}

function styleProps(node: Node, ctx: RenderCtx, isRoot: boolean): string[] {
  if (ctx.mode === 'inline') {
    const style = isRoot ? { ...ctx.tokens, ...node.style } : node.style;
    return Object.keys(style).length > 0 ? [styleProp(style, ctx.usage)] : [];
  }
  const { classes, rest } = cssToTailwind(node.style, { tokens: ctx.tokens });
  const out: string[] = [];
  if (classes.length > 0) out.push(`className=${attrValue(classes.join(' '))}`);
  if (Object.keys(rest).length > 0) out.push(styleProp(rest, ctx.usage));
  return out;
}

function renderNode(
  node: Node,
  depth: number,
  ctx: RenderCtx,
  inheritedPre: boolean,
  isRoot: boolean,
  extraProps: string[] = [],
): string[] {
  const slot = ctx.slots?.get(node) ?? {};
  const pre = node.style['white-space']
    ? preservesNewlines(node.style['white-space'])
    : inheritedPre;
  const props: string[] = [...extraProps, ...styleProps(node, ctx, isRoot)];

  if (node.type === 'svg') {
    return svgToJsx(node.svg ?? '', depth, props, ctx.usage);
  }

  const isImg = node.type === 'image' || node.tag === 'img';
  if (isImg) {
    if (slot.src) props.push(`src={item.${slot.src.field}}`);
    else if (node.src !== undefined) {
      const url = assetUrl(node.src, ctx.assetsBase);
      if (!isUnsafeUrl(url)) props.push(`src=${attrValue(url)}`);
    }
    if (slot.alt) props.push(`alt={item.${slot.alt.field}}`);
    else props.push(`alt=${attrValue(node.attrs.alt ?? '')}`);
  }
  const skip = new Set<string>(isImg ? ['src', 'alt'] : []);
  if (slot.href) skip.add('href');
  props.push(...attrProps(node, skip));
  if (slot.href) props.push(`href={item.${slot.href.field}}`);

  if (VOID_TAGS.has(node.tag)) return emitElement(node.tag, props, [], depth);

  const kids: string[][] = [];
  if (slot.text) kids.push([`{item.${slot.text.field}}`].map((l) => pad(depth + 1) + l));
  else if (node.text !== undefined && node.text !== '') {
    kids.push(textChildren(node.text, pre).map((l) => pad(depth + 1) + l));
  }
  kids.push(...renderChildren(node.children, depth + 1, ctx, pre, node));
  return emitElement(node.tag, props, kids, depth);
}

/** Filhos de um nó; irmãos repetidos viram `array.map(...)` quando `extractRepeats` está ligado. */
function renderChildren(
  children: Node[],
  depth: number,
  ctx: RenderCtx,
  pre: boolean,
  parent: Node,
): string[][] {
  const out: string[][] = [];
  let i = 0;
  while (i < children.length) {
    let j = i + 1;
    if (ctx.extractRepeats && !ctx.slots) {
      const sig = signature(children[i]);
      while (j < children.length && signature(children[j]) === sig) j++;
    }
    const run = children.slice(i, j);
    const plan = run.length >= 2 ? planRun(run, ctx.assetsBase) : null;
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

/** `const nome = [{ ... }, ...]`: um item por linha; campos em linhas próprias se passar de 100 colunas. */
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

/** Gera um componente TSX funcional a partir de um nó (Vite + React + TypeScript strict). */
export function exportReact(doc: Document, options: ReactExportOptions): ReactExport {
  const mode = options.styles ?? 'tailwind';
  const [root] = resolveRoots(doc, { nodeIds: [options.nodeId] });
  const componentName = componentIdent(options.componentName ?? root.name);
  const usage: Usage = { cssProperties: false };
  const ctx: RenderCtx = {
    mode,
    tokens: cleanTokens(doc.tokens),
    assetsBase: options.assetsBase ?? 'assets/',
    extractRepeats: options.extractRepeats ?? true,
    usage,
    arrays: [],
    usedNames: new Set([componentName, 'CSSProperties']),
  };

  const body = renderNode(root, 2, ctx, false, true);
  const code: string[] = [];
  if (usage.cssProperties) code.push("import type { CSSProperties } from 'react';", '');
  for (const a of ctx.arrays) code.push(a, '');
  code.push(
    `export function ${componentName}() {`,
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
    css = `${BASE_CSS}\n${faces ? faces + '\n' : ''}`;
  }
  return { componentName, code: code.join('\n'), css };
}
