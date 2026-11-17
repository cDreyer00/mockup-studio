import { BLOCKED_TAGS, createNodeFromTag, isValidTag, VOID_TAGS, type Node } from '@mockup/core';
import type { AssetRegistry } from './assets.js';
import { type Defaults, readStyle, type StyleRec } from './defaults.js';
import { KEEP_ATTRS, PLACEHOLDER_NAMES, REPLACED_TAGS, SKIP_TAGS } from './props.js';
import { reduceStyles } from './reduce.js';
import { serializeSvg } from './svg.js';
import {
  capitalize,
  cleanText,
  fontFamilies,
  NAME_TEXT_MAX,
  parseContent,
  px,
  truncate,
} from './util.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const PLACEHOLDER_BG = '#e5e7eb';
const FLOW_DISPLAYS = new Set(['block', 'inline', 'inline-block', 'list-item', 'flow-root']);
const OFFSETS = ['top', 'right', 'bottom', 'left'] as const;

export interface TreeCtx {
  root: Element;
  defaults: Defaults;
  assets: AssetRegistry;
  /** Font families used (lowercase, no quotes). */
  families: Set<string>;
  maxNodes: number;
  maxDepth: number;
  count: number;
  truncated: boolean;
  warnings: string[];
  /** Many nodes: skips the automatic `height` test. */
  cheap: boolean;
}

const num = (v: string | undefined): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
};

function take(ctx: TreeCtx): boolean {
  if (ctx.count >= ctx.maxNodes) {
    if (!ctx.truncated)
      ctx.warnings.push(`Limit of ${ctx.maxNodes} nodes reached: the rest was cut off.`);
    ctx.truncated = true;
    return false;
  }
  ctx.count++;
  return true;
}

function elementName(el: Element, text?: string): string {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return truncate(aria, NAME_TEXT_MAX);
  const first = el.classList[0];
  if (first) return capitalize(first);
  if (text) return truncate(text, NAME_TEXT_MAX);
  return capitalize(el.localName);
}

function absoluteUrl(value: string): string | null {
  try {
    const u = new URL(value, document.baseURI);
    return u.protocol === 'javascript:' ? null : u.href;
  } catch {
    return null;
  }
}

function collectAttrs(el: Element, tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of KEEP_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null && v.trim() !== '') attrs[a] = v;
  }
  const href = el.getAttribute('href');
  if (href && (tag === 'a' || tag === 'area')) {
    const abs = absoluteUrl(href.trim());
    if (abs) attrs['href'] = abs;
  }
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = input.type;
    if (type !== 'password' && type !== 'file' && type !== 'hidden' && input.value) {
      attrs['value'] = input.value;
    }
    if ((type === 'checkbox' || type === 'radio') && input.checked) attrs['checked'] = '';
  }
  if (tag === 'option' && (el as HTMLOptionElement).selected) attrs['selected'] = '';
  return attrs;
}

/** Used box measurements (border-box) in px: `offsetWidth/Height`, refined by the computed style. */
function usedBox(el: Element, cs: CSSStyleDeclaration, rec: StyleRec): { w: number; h: number } {
  const he = el as HTMLElement;
  let w = typeof he.offsetWidth === 'number' ? he.offsetWidth : NaN;
  let h = typeof he.offsetHeight === 'number' ? he.offsetHeight : NaN;
  if (Number.isNaN(w) || Number.isNaN(h)) {
    const r = el.getBoundingClientRect();
    w = r.width;
    h = r.height;
  }
  const content = rec['box-sizing'] === 'content-box';
  const bw = (s: string): number =>
    rec[`border-${s}-style`] === 'none' ? 0 : num(rec[`border-${s}-width`]);
  const padW = content
    ? num(rec['padding-left']) + num(rec['padding-right']) + bw('left') + bw('right')
    : 0;
  const padH = content
    ? num(rec['padding-top']) + num(rec['padding-bottom']) + bw('top') + bw('bottom')
    : 0;
  const cw = parseFloat(cs.width) + padW;
  const ch = parseFloat(cs.height) + padH;
  if (Number.isFinite(cw) && Math.abs(cw - w) <= 1) w = cw;
  if (Number.isFinite(ch) && Math.abs(ch - h) <= 1) h = ch;
  return { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
}

/**
 * Applies `prop: auto !important`, measures and restores EXACTLY the original `style` attribute.
 * True if the size does not change (the size is "auto" for the canvas too).
 */
function isAutoSize(el: HTMLElement, prop: 'width' | 'height'): boolean {
  const read = (): number => (prop === 'width' ? el.offsetWidth : el.offsetHeight);
  const before = read();
  const original = el.getAttribute('style');
  let after = before;
  try {
    el.style.setProperty(prop, 'auto', 'important');
    after = read();
  } finally {
    if (original === null) el.removeAttribute('style');
    else el.setAttribute('style', original);
  }
  return Math.abs(before - after) <= 0.5;
}

function hasElementChildren(el: Element): boolean {
  return el.firstElementChild !== null;
}

/** Side margins declared as `auto` (via `computedStyleMap`, when available). */
function autoMargins(el: Element, rec: StyleRec): { left: boolean; right: boolean } | undefined {
  if (num(rec['margin-left']) === 0 && num(rec['margin-right']) === 0) return undefined;
  const map = (
    el as Element & { computedStyleMap?: () => { get(p: string): unknown } }
  ).computedStyleMap?.();
  if (!map) return undefined;
  try {
    return {
      left: String(map.get('margin-left')) === 'auto',
      right: String(map.get('margin-right')) === 'auto',
    };
  } catch {
    return undefined;
  }
}

/** Computed `top/right/bottom/left` offsets (px) other than `auto`. */
function computedOffsets(out: Record<string, string>, rec: StyleRec): void {
  for (const k of OFFSETS) {
    const v = rec[k];
    if (v && v !== 'auto') out[k] = v;
  }
}

interface PositionResult {
  /** The node becomes the containing block of its children (positioned or with transform). */
  isCb: boolean;
}

/** Position of a descendant (the root is handled in `visit`). */
function applyPosition(
  out: Record<string, string>,
  rec: StyleRec,
  el: Element,
  cb: Element,
  ctx: TreeCtx,
  box: { w: number; h: number },
): PositionResult {
  const pos = rec['position'];
  if (pos === 'relative') {
    out['position'] = 'relative';
    computedOffsets(out, rec);
  } else if (pos === 'sticky') {
    out['position'] = 'relative';
  } else if (pos === 'absolute' || pos === 'fixed') {
    out['position'] = 'absolute';
    const parent = (el as HTMLElement).offsetParent;
    const inside = pos === 'absolute' && !!parent && ctx.root.contains(parent);
    if (inside) computedOffsets(out, rec);
    else {
      // The original containing block is outside the subtree: position relative to the current block.
      const r = el.getBoundingClientRect();
      const c = cb.getBoundingClientRect();
      const cx = r.left + r.width / 2 - box.w / 2;
      const cy = r.top + r.height / 2 - box.h / 2;
      const left = cx - c.left - cb.clientLeft - num(rec['margin-left']);
      const top = cy - c.top - cb.clientTop - num(rec['margin-top']);
      out['left'] = px(left);
      out['top'] = px(top);
      delete out['right'];
      delete out['bottom'];
    }
  }
  return { isCb: !!out['position'] || !!out['transform'] };
}

interface BuildResult {
  text?: string;
  children: Node[];
}

function isInlineLevel(n: ChildNode | null): boolean {
  if (!n) return false;
  if (n.nodeType === 3) return true;
  if (n.nodeType !== 1) return false;
  const e = n as Element;
  return e.localName !== 'br' && getComputedStyle(e).display.startsWith('inline');
}

function pseudoNode(
  el: Element,
  which: '::before' | '::after',
  elRec: StyleRec,
  ctx: TreeCtx,
): Node | null {
  const pcs = getComputedStyle(el, which);
  const parsed = parseContent(pcs.getPropertyValue('content'), el);
  if (!parsed || pcs.display === 'none') return null;

  let kind: 'image' | 'text' | 'box';
  if (parsed.url) kind = 'image';
  else if (parsed.text !== '') kind = 'text';
  else if (parsed.box) kind = 'box';
  else return null;

  const rec = readStyle(pcs);
  for (const f of fontFamilies(rec['font-family'] ?? '')) ctx.families.add(f);
  const blockLevel = !rec['display']!.startsWith('inline') && rec['display'] !== 'contents';
  const tag = kind === 'image' ? 'img' : kind === 'box' && blockLevel ? 'div' : 'span';
  const out = reduceStyles({
    cur: rec,
    def: ctx.defaults.get(tag),
    parent: elRec,
    body: ctx.defaults.body,
    isRoot: false,
    assets: ctx.assets,
    baseUrl: document.baseURI,
  });

  const w = parseFloat(pcs.width);
  const h = parseFloat(pcs.height);
  if (kind === 'box' || kind === 'image') {
    if (!(w > 0) || !(h > 0)) return null;
    out['width'] = px(w);
    out['height'] = px(h);
  }
  const pos = rec['position'];
  if (pos === 'relative' || pos === 'absolute' || pos === 'fixed') {
    out['position'] = pos === 'relative' ? 'relative' : 'absolute';
    computedOffsets(out, rec);
  } else if (pos === 'sticky') out['position'] = 'relative';

  if (!take(ctx)) return null;
  const name = which;
  if (kind === 'image') {
    const url = absoluteUrl(parsed.url!);
    if (!url) return null;
    return createNodeFromTag('img', { name, styles: out, src: ctx.assets.imageRef(url) });
  }
  if (kind === 'text') {
    const preserve = /^(pre|break-spaces)/.test(rec['white-space'] ?? '');
    const text = preserve ? parsed.text : parsed.text.replace(/[ \t\r\n\f]+/g, ' ');
    return createNodeFromTag('span', { name, styles: out, text });
  }
  return createNodeFromTag(tag, { name, styles: out });
}

function buildChildren(
  el: Element,
  tag: string,
  rec: StyleRec,
  depth: number,
  cb: Element,
  ctx: TreeCtx,
  forceChildren: boolean,
): BuildResult {
  const preserve = /^(pre|break-spaces)/.test(rec['white-space'] ?? '');
  if (tag === 'textarea') {
    const value = (el as HTMLTextAreaElement).value;
    return { text: value !== '' ? value : undefined, children: [] };
  }

  const before = pseudoNode(el, '::before', rec, ctx);
  type Part = { raw: string; dom: ChildNode } | { node: Node };
  const parts: Part[] = [];
  const canDescend = depth + 1 <= ctx.maxDepth;
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3) parts.push({ raw: (c as Text).data, dom: c });
    else if (c.nodeType === 1) {
      if (!canDescend) {
        if (!ctx.truncated) {
          ctx.warnings.push(`Maximum depth (${ctx.maxDepth}) reached: the rest was cut off.`);
        }
        ctx.truncated = true;
        continue;
      }
      const node = visit(c as Element, rec, depth + 1, cb, ctx, false);
      if (node) parts.push({ node });
    }
  }
  const after = pseudoNode(el, '::after', rec, ctx);

  const hasNodes = !!before || !!after || parts.some((p) => 'node' in p);
  if (!hasNodes && !forceChildren) {
    const joined = parts.map((p) => ('raw' in p ? p.raw : '')).join('');
    const text = preserve ? joined : cleanText(joined);
    return { text: text !== '' ? text : undefined, children: [] };
  }

  const children: Node[] = [];
  if (before) children.push(before);
  const flow = FLOW_DISPLAYS.has(rec['display'] ?? '');
  for (const p of parts) {
    if ('node' in p) {
      children.push(p.node);
      continue;
    }
    let value = preserve ? p.raw : cleanText(p.raw);
    if (value === '' && !preserve && p.raw !== '' && flow) {
      // Space between two inline elements counts ("<b>a</b> <i>b</i>").
      if (isInlineLevel(p.dom.previousSibling) && isInlineLevel(p.dom.nextSibling)) value = ' ';
    }
    if (value === '' || !take(ctx)) continue;
    children.push(
      createNodeFromTag('span', {
        text: value,
        name: value.trim() ? truncate(value.trim(), NAME_TEXT_MAX) : 'Space',
      }),
    );
  }
  if (after) children.push(after);
  return { children };
}

/** Serializes an element (and its subtree) into a core node; `null` if it produces no node. */
export function visit(
  el: Element,
  parentRec: StyleRec | null,
  depth: number,
  cb: Element,
  ctx: TreeCtx,
  isRoot: boolean,
  forceChildren = false,
): Node | null {
  if (ctx.defaults.isOwn(el)) return null;
  const isSvg = el.namespaceURI === SVG_NS && el.localName === 'svg';
  if (!isSvg && el.namespaceURI !== XHTML_NS) return null;
  const tag = isSvg ? 'svg' : el.localName.toLowerCase();
  const placeholder = PLACEHOLDER_NAMES[tag];

  if (!isRoot && SKIP_TAGS.has(tag)) return null;
  if (!placeholder && (BLOCKED_TAGS.has(tag) || !isValidTag(tag))) return null;
  if (tag === 'input' && (el as HTMLInputElement).type === 'hidden') return null;
  if (tag === 'picture') {
    const img = el.querySelector('img');
    return img ? visit(img, parentRec, depth, cb, ctx, false) : null;
  }
  if (tag === 'br') return take(ctx) ? createNodeFromTag('br', { name: 'Break' }) : null;

  const cs = getComputedStyle(el);
  if (cs.display === 'none') return null;

  const rec = readStyle(cs);
  for (const f of fontFamilies(rec['font-family'] ?? '')) ctx.families.add(f);

  let nodeTag = tag;
  if (placeholder) nodeTag = 'div';
  else if (tag.includes('-')) nodeTag = rec['display']!.startsWith('inline') ? 'span' : 'div';

  // Image without a source: no node.
  let imgUrl = '';
  if (tag === 'img') {
    const img = el as HTMLImageElement;
    imgUrl = img.currentSrc || img.src || '';
    if (!imgUrl) return null;
  }

  const box = usedBox(el, cs, rec);
  if (isSvg && !isRoot && box.w === 0 && box.h === 0) return null; // hidden sprite
  if (!take(ctx)) return null;

  const variant =
    tag === 'input'
      ? (el as HTMLInputElement).type
      : (tag === 'a' || tag === 'area') && nodeTag === tag && el.hasAttribute('href')
        ? 'href'
        : '';
  const def = ctx.defaults.get(nodeTag, variant);
  const out = reduceStyles({
    cur: rec,
    def,
    parent: parentRec,
    body: ctx.defaults.body,
    isRoot,
    assets: ctx.assets,
    baseUrl: document.baseURI,
    autoMargin: autoMargins(el, rec),
    box,
  });

  // Size.
  const replaced = REPLACED_TAGS.has(tag) || !!placeholder;
  const display = rec['display']!;
  const positioned = rec['position'] === 'absolute' || rec['position'] === 'fixed';
  if (isRoot || replaced || positioned) {
    if (display !== 'contents') {
      out['width'] = px(box.w);
      out['height'] = px(box.h);
    }
  } else if (display !== 'contents' && !(display === 'inline' && !replaced)) {
    const he = el as HTMLElement;
    if (!isAutoSize(he, 'width')) out['width'] = px(box.w);
    const overflowed = rec['overflow-x'] !== 'visible' || rec['overflow-y'] !== 'visible';
    if (!ctx.cheap || overflowed || !hasElementChildren(el)) {
      if (!isAutoSize(he, 'height')) out['height'] = px(box.h);
    }
  }

  // Position and root.
  let isCb = false;
  if (isRoot) {
    for (const k of ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left']) {
      delete out[k];
    }
    for (const k of [
      'top',
      'right',
      'bottom',
      'left',
      'transform',
      'transform-origin',
      'float',
      'z-index',
    ]) {
      delete out[k];
    }
    out['position'] = 'relative';
    if (display === 'inline') out['display'] = 'inline-block';
    isCb = true;
  } else {
    isCb = applyPosition(out, rec, el, cb, ctx, box).isCb;
  }

  const name = elementName(el);

  if (isSvg) {
    const svg = serializeSvg(el as SVGSVGElement, rec['color']!, box.w, box.h);
    return createNodeFromTag('svg', { name, styles: out, svg });
  }
  if (tag === 'img') {
    return createNodeFromTag('img', {
      name,
      styles: out,
      src: ctx.assets.imageRef(imgUrl),
      attrs: collectAttrs(el, tag),
    });
  }
  if (placeholder) {
    delete out['background-image'];
    delete out['background-size'];
    delete out['background-position'];
    delete out['background-repeat'];
    delete out['background-origin'];
    delete out['background-clip'];
    delete out['-webkit-background-clip'];
    out['background-color'] = PLACEHOLDER_BG;
    if (display === 'inline') out['display'] = 'inline-block';
    return createNodeFromTag('div', { name: placeholder, styles: out });
  }
  if (VOID_TAGS.has(tag)) {
    return createNodeFromTag(nodeTag, { name, styles: out, attrs: collectAttrs(el, tag) });
  }

  const built = buildChildren(el, tag, rec, depth, isCb ? el : cb, ctx, forceChildren);
  const attrs = collectAttrs(el, nodeTag === tag ? tag : 'div');
  if (built.text !== undefined && built.children.length === 0) {
    return createNodeFromTag(nodeTag, {
      name: elementName(el, built.text.trim()),
      styles: out,
      attrs,
      text: built.text,
    });
  }
  return createNodeFromTag(nodeTag, { name, styles: out, attrs, children: built.children });
}
