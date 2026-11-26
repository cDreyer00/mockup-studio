/** Pieces shared by the exporters (html, tailwind, react, svg). */
import { deepClone } from '../clone.js';
import { expandRepeaters } from '../data.js';
import { findNode, findPage } from '../document.js';
import { isUnsafeUrl, slugify } from '../html.js';
import { cssValueProblem, dropUnsafeStyles, isValidCssPropertyName } from '../styles.js';
import { sanitizeSvg, scopeSvgIds } from '../svg.js';
import { ATTR_NAME_RE, TOKEN_NAME_RE, VOID_TAGS } from '../tags.js';
import type { Document, Node } from '../types.js';
import { DOCUMENT_ROOT_DECLARATIONS, documentBaseCss, documentRootDeclarations } from '../base.js';
import { BREAKPOINT_PX, parseStateKey, sortStateKeys } from '../states.js';
import type { Breakpoint } from '../states.js';
import {
  mediaElement,
  mediaStyleDefaults,
  renderMediaAttrs,
  type MediaCollector,
} from './media.js';
import { MOTION_ATTR, splitParts } from './motion.js';
import type { MotionCollector } from './motion.js';

/** Document base (the same as the canvas and the render): see `documentBaseCss`. */
export const BASE_CSS = documentBaseCss();

/** Document root typography for Tailwind (the preflight already covers box-sizing, margin and controls). */
export const TAILWIND_BASE_CSS = `@layer base {
  body { ${DOCUMENT_ROOT_DECLARATIONS.split(';').join('; ')}; }
}`;

/** Root typography for Tailwind according to `doc.cssBase` (the `body` of the base layer). */
export function tailwindBaseCssFor(doc: { cssBase?: 'tailwind' }): string {
  return `@layer base {\n  body { ${documentRootDeclarations(doc).split(';').join('; ')}; }\n}`;
}

/** Selection of nodes to export: `nodeIds` or the page's frames (`pageId` or the first page). */
export interface RootSelection {
  pageId?: string;
  nodeIds?: string[];
}

export interface PrepareOptions {
  /** Keeps `height` on root frames (default: becomes `min-height`, so content can grow). */
  keepHeight?: boolean;
}

/**
 * Prepares a tree for export: removes hidden nodes, drops unsafe CSS declarations,
 * converts canvas `position` into left/top on absolute children and, on the root frame, swaps
 * `height` for `min-height`. A direct child with `height:100%` (the typical screen wrapper) also becomes
 * `min-height` with the frame's height; without that the % has no reference and the content collapses, unlike
 * what is seen on the canvas. Works on a copy; the original document is not changed.
 */
function prepareNode(node: Node, isRoot: boolean, opts: PrepareOptions): void {
  node.style = dropUnsafeStyles(node.style);
  if (node.states) {
    const states: Record<string, Record<string, string>> = {};
    for (const [key, style] of Object.entries(node.states)) {
      if (!parseStateKey(key)) continue;
      const safe = dropUnsafeStyles(style);
      if (Object.keys(safe).length > 0) states[key] = safe;
    }
    if (Object.keys(states).length > 0) node.states = states;
    else delete node.states;
  }
  if (node.type === 'effect' || node.type === 'embed') {
    // effect fallback background (visible without JS) and `border:0` on iframes; the node's style wins
    node.style = { ...mediaStyleDefaults(node), ...node.style };
  }
  if (!isRoot && node.style.position === 'absolute' && node.position) {
    if (!node.style.left) node.style.left = `${node.position.x}px`;
    if (!node.style.top) node.style.top = `${node.position.y}px`;
  }
  if (isRoot && node.type === 'frame' && !opts.keepHeight && node.style.height) {
    if (!node.style['min-height']) node.style['min-height'] = node.style.height;
    const frameHeight = node.style.height;
    delete node.style.height;
    if (!node.style.padding && !node.style['padding-top'] && !node.style['padding-bottom']) {
      for (const c of node.children) {
        if (c.style.height === '100%' && !c.style['min-height']) {
          c.style['min-height'] = frameHeight;
          delete c.style.height;
        }
      }
    }
  }
  node.children = node.children.filter((c) => !c.hidden);
  for (const c of node.children) prepareNode(c, false, opts);
}

/** Prepared copy (see `prepareNode`) of a tree that is not an export root: main components and expanded instances. */
export function prepareTree(node: Node, opts: PrepareOptions = {}): Node {
  const copy = deepClone(node);
  prepareNode(copy, false, opts);
  return copy;
}

export function resolveRoots(
  doc: Document,
  selection: RootSelection = {},
  opts: PrepareOptions = {},
): Node[] {
  let nodes: Node[];
  if (selection.nodeIds && selection.nodeIds.length > 0) {
    nodes = selection.nodeIds.map((id) => {
      const path = findNode(doc, id);
      if (!path) throw new Error(`Node "${id}" not found`);
      return path.node;
    });
  } else {
    const page = selection.pageId ? findPage(doc, selection.pageId) : doc.pages[0];
    if (!page) throw new Error(`Page "${selection.pageId ?? ''}" not found`);
    nodes = page.frames;
  }
  // Repeaters become containers with the expanded items (real data in the exported code).
  const copies = deepClone(nodes).map((n) => expandRepeaters(n));
  for (const n of copies) prepareNode(n, true, opts);
  return copies;
}

/** Tokens with a valid name and value (drops whatever would break the exported CSS). */
export function cleanTokens(tokens: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (TOKEN_NAME_RE.test(k) && cssValueProblem(v) === null) out[k] = v;
  }
  return out;
}

export function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `:root { --token: value }` block (empty if there are no tokens). */
export function rootTokensCss(tokens: Record<string, string>, indent = '  '): string {
  const entries = Object.entries(cleanTokens(tokens));
  if (entries.length === 0) return '';
  return `${indent}:root {\n${entries.map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}`;
}

/** Body of a CSS rule (`prop: value;` per line). */
export function cssBody(style: Record<string, string>, indent = '  '): string {
  return Object.entries(style)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');
}

/** Allocates class names from the layer name (slug; duplicates get `-2`, `-3`...). */
export class ClassNamer {
  private used = new Set<string>();
  private counts = new Map<string, number>();

  next(name: string): string {
    let base = slugify(name);
    if (/^[0-9]/.test(base)) base = `n-${base}`;
    let n = this.counts.get(base) ?? 0;
    let candidate: string;
    do {
      n++;
      candidate = n === 1 ? base : `${base}-${n}`;
    } while (this.used.has(candidate));
    this.counts.set(base, n);
    this.used.add(candidate);
    return candidate;
  }
}

/** Image `src` relative to `assets/` → exported URL; data URLs and absolute URLs pass through. */
export function assetUrl(src: string, base = 'assets/'): string {
  if (/^(data:|https?:|\/\/|\/|#|blob:)/i.test(src)) return src;
  if (src.startsWith(base)) return src;
  return base + src.replace(/^\.?\//, '');
}

/** Does the `white-space` value preserve line breaks? */
export function preservesNewlines(whiteSpace: string | undefined): boolean {
  return !!whiteSpace && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(whiteSpace.trim());
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

/** Safe HTML attributes of the node (no `on*`, `style`, `class`, `srcdoc` or dangerous URLs). */
export function safeAttrs(node: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    const lower = k.toLowerCase();
    if (!ATTR_NAME_RE.test(k) || /^on/i.test(k)) continue;
    if (lower === 'style' || lower === 'class' || lower === 'srcdoc') continue;
    if (URL_ATTRS.has(lower) && isUnsafeUrl(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Attributes that are boolean when present with an empty value (or equal to the name). */
export const BOOLEAN_ATTRS = new Set([
  'allowfullscreen',
  'async',
  'autofocus',
  'autoplay',
  'checked',
  'controls',
  'default',
  'defer',
  'disabled',
  'formnovalidate',
  'hidden',
  'inert',
  'ismap',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'open',
  'playsinline',
  'readonly',
  'required',
  'reversed',
  'selected',
]);

export interface HtmlStyleAttrs {
  /** Value of the `class` attribute. */
  cls?: string;
  /** Value of the `style` attribute (`a: b; c: d` declarations). */
  style?: string;
}

export interface HtmlRenderOptions {
  /** Class/style of each node (called in document order; `isRoot` for root nodes). */
  styleOf: (node: Node, isRoot: boolean) => HtmlStyleAttrs;
  /** Prefix for relative images (default `assets/`). */
  assetsBase?: string;
  /** Overrides the image `src` (e.g. data URL). `undefined` keeps the default. */
  resolveSrc?: (src: string) => string | undefined;
  /** XHTML-compatible output (void tags `<br />`, `xmlns` on svg). */
  xhtml?: boolean;
  /** Initial indentation in levels (default 0). */
  depth?: number;
  /**
   * Media nodes: `live` (default) generates canvas/iframe/video ready for the scripts from
   * `mediaScripts(media)`; `static` generates inert markup (`data-mockup-*`), without scripts.
   */
  mediaMode?: 'live' | 'static';
  /** Receives what `live` media nodes need to load (scripts, fragments). */
  media?: MediaCollector;
  /** Reads files from `assets/` to embed the JSON of small Lottie animations in the HTML. */
  readAsset?: (ref: string) => string | Uint8Array | undefined;
  /** Node animations: adds `data-mk` to the animated elements and renders split texts as spans. */
  motion?: MotionCollector;
}

/** Node text: `\n` stays literal (CSS decides whether it becomes a break); only escapes. */
function renderText(text: string): string {
  return escapeHtmlText(text);
}

function injectIntoSvg(markup: string, attrs: HtmlStyleAttrs, xhtml: boolean, mk?: number): string {
  let out = markup;
  const extra: string[] = [];
  if (mk !== undefined) extra.push(`${MOTION_ATTR}="${mk}"`);
  if (xhtml && !/^\s*<svg[^>]*\sxmlns=/i.test(out)) {
    extra.push('xmlns="http://www.w3.org/2000/svg"');
  }
  if (attrs.cls) extra.push(`class="${escapeHtmlAttr(attrs.cls)}"`);
  if (attrs.style) extra.push(`style="${escapeHtmlAttr(attrs.style)}"`);
  if (extra.length > 0) out = out.replace(/^(\s*<svg)/i, `$1 ${extra.join(' ')}`);
  return out;
}

/** Inline markup of a split text (see `splitParts`). */
function renderSplit(text: string, mode: 'words' | 'chars'): string {
  const seg = (t: string, i: number): string =>
    `<span data-motion-seg style="--mi: ${i}">${renderText(t)}</span>`;
  return splitParts(text, mode)
    .map((p) => {
      if (p.type === 'text') return renderText(p.text);
      if (p.type === 'seg') return seg(p.text, p.index);
      return `<span data-motion-word>${p.segs.map((s) => seg(s.text, s.index)).join('')}</span>`;
    })
    .join('');
}

/** Renders the trees as HTML (one line per tag; text on the element's line). */
export function renderHtmlTree(roots: Node[], opts: HtmlRenderOptions): string {
  const lines: string[] = [];
  const pad = (d: number): string => '  '.repeat(d);
  const xhtml = opts.xhtml === true;

  const render = (node: Node, depth: number, isRoot: boolean): void => {
    const sa = opts.styleOf(node, isRoot);
    opts.motion?.register(node);
    const mk = opts.motion?.keyOf(node);

    if (node.type === 'svg') {
      const markup = scopeSvgIds(sanitizeSvg(node.svg ?? '') || '<svg></svg>', node.id);
      lines.push(pad(depth) + injectIntoSvg(markup, sa, xhtml, mk));
      return;
    }

    const parts: string[] = [];
    if (sa.cls) parts.push(`class="${escapeHtmlAttr(sa.cls)}"`);
    if (mk !== undefined) parts.push(`${MOTION_ATTR}="${mk}"`);
    if (node.type === 'effect' || node.type === 'video' || node.type === 'embed') {
      const m = mediaElement(node, {
        mode: opts.mediaMode ?? 'live',
        collector: opts.media,
        readAsset: opts.readAsset,
        url: (ref, kind) => {
          const url =
            (kind === 'poster' ? opts.resolveSrc?.(ref) : undefined) ??
            assetUrl(ref, opts.assetsBase);
          return isUnsafeUrl(url) ? null : url;
        },
      });
      if (m) {
        parts.push(...renderMediaAttrs(m.attrs, xhtml));
        if (sa.style) parts.push(`style="${escapeHtmlAttr(sa.style)}"`);
        lines.push(`${pad(depth)}<${m.tag} ${parts.join(' ')}></${m.tag}>`);
        return;
      }
    }
    const isImg = node.type === 'image' || node.tag === 'img';
    if (isImg && node.src !== undefined) {
      const url = opts.resolveSrc?.(node.src) ?? assetUrl(node.src, opts.assetsBase);
      if (!isUnsafeUrl(url)) parts.push(`src="${escapeHtmlAttr(url)}"`);
    }
    for (const [k, v] of Object.entries(safeAttrs(node))) {
      if (isImg && k.toLowerCase() === 'src') continue;
      if (v === '' && BOOLEAN_ATTRS.has(k.toLowerCase()) && !xhtml) parts.push(k);
      else parts.push(`${k}="${escapeHtmlAttr(v)}"`);
    }
    if (sa.style) parts.push(`style="${escapeHtmlAttr(sa.style)}"`);
    const open = `<${node.tag}${parts.length > 0 ? ' ' + parts.join(' ') : ''}`;

    if (VOID_TAGS.has(node.tag)) {
      lines.push(`${pad(depth)}${open}${xhtml ? ' />' : '>'}`);
      return;
    }
    const text = node.text ?? '';
    const split = text !== '' ? opts.motion?.splitOf(node) : null;
    if (split) {
      // split text: one inline-block span per word/character (same structure as the editor)
      if (node.children.length === 0) {
        lines.push(`${pad(depth)}${open}>${renderSplit(text, split)}</${node.tag}>`);
        return;
      }
      lines.push(`${pad(depth)}${open}>${renderSplit(text, split)}`);
      for (const c of node.children) render(c, depth + 1, false);
      lines.push(`${pad(depth)}</${node.tag}>`);
      return;
    }
    if (node.children.length === 0) {
      lines.push(`${pad(depth)}${open}>${renderText(text)}</${node.tag}>`);
      return;
    }
    lines.push(`${pad(depth)}${open}>`);
    if (text !== '') lines.push(pad(depth + 1) + renderText(text));
    for (const c of node.children) render(c, depth + 1, false);
    lines.push(`${pad(depth)}</${node.tag}>`);
  };

  for (const r of roots) render(r, opts.depth ?? 0, true);
  return lines.join('\n');
}

/** Valid CSS property and safe value (for direct use in `style=`/rules). */
export function isSafeDeclaration(key: string, value: string): boolean {
  return isValidCssPropertyName(key) && cssValueProblem(value) === null;
}

/** Indents each non-empty line of `text` by `n` levels of 2 spaces. */
export function indentLines(text: string, n: number): string {
  const p = '  '.repeat(n);
  return text
    .split('\n')
    .map((l) => (l === '' ? l : p + l))
    .join('\n');
}

/** Does the node have any state with the `dark` variant? */
export function usesDarkState(node: Node): boolean {
  if (node.states && Object.keys(node.states).some((k) => parseStateKey(k)?.dark)) return true;
  return node.children.some(usesDarkState);
}

/**
 * CSS rules for a node's states for the `.cls` selector: pseudo-classes (`.cls:hover`), `dark`
 * (`.cls:where([data-theme="dark"], [data-theme="dark"] *)`, the same selector as the `@custom-variant`) and
 * breakpoints (`@media (min-width: 768px)`, mobile first). `important` appends `!important` to the
 * declarations (needed when the base style is inline).
 */
export function stateRulesCss(
  selector: string,
  states: Record<string, Record<string, string>> | undefined,
  opts: { important?: boolean; breakpoints?: Partial<Record<Breakpoint, number>> } = {},
): string[] {
  if (!states) return [];
  const out: string[] = [];
  for (const key of sortStateKeys(Object.keys(states))) {
    const parts = parseStateKey(key);
    const style = states[key];
    if (!parts || Object.keys(style).length === 0) continue;
    let sel = selector;
    if (parts.dark) sel += ':where([data-theme="dark"], [data-theme="dark"] *)';
    if (parts.pseudo) sel += `:${parts.pseudo}`;
    const decls = opts.important
      ? Object.fromEntries(
          Object.entries(style).map(([k, v]) => [
            k,
            /!important\s*$/.test(v) ? v : `${v} !important`,
          ]),
        )
      : style;
    if (parts.breakpoint) {
      const min = opts.breakpoints?.[parts.breakpoint] ?? BREAKPOINT_PX[parts.breakpoint];
      out.push(`@media (min-width: ${min}px) {\n  ${sel} {\n${cssBody(decls, '    ')}\n  }\n}`);
    } else out.push(`${sel} {\n${cssBody(decls)}\n}`);
  }
  return out;
}
