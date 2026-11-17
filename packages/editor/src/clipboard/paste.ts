/**
 * Pure clipboard logic: serialization with a marker, HTML detection, paste target and
 * node preparation (new ids, frame ↔ element conversion, positions).
 */
import {
  cloneNodeWithNewIds,
  htmlToNodes,
  nodesToHtml,
  svgToVector,
  vectorToSvg,
} from '@mockup/core';
import { COMPONENT_EDIT_PAGE_ID } from '@mockup/core';
import type { Document, Node, Op } from '@mockup/core';
import { looksLikeSnapshot } from '@mockup/snapshot-core';
import { canInsertInto } from '../components/model';
import { loadTailwindEngine } from '../tailwind/loader';
import { POSITION_STYLE_KEYS, isLeafNode, makeLeafFrame } from '../model/factory';
import {
  canHaveChildren,
  getEntry,
  getNode,
  isAbsolute,
  isFlex,
  isLockedDeep,
  pxValue,
  sortByDocumentOrder,
} from '../model/tree';

/* ------------------------------------------------------------------ */
/* serialization                                                      */
/* ------------------------------------------------------------------ */

const MARKER_RE = /<!--mockup-studio:([\w-]+)-->/;

export function makeMarker(token: string): string {
  return `<!--mockup-studio:${token}-->`;
}

/** Extracts the marker token from a clipboard string (or `null`). */
export function extractMarker(text: string | null | undefined): string | null {
  return text ? (MARKER_RE.exec(text)?.[1] ?? null) : null;
}

/** HTML written to the clipboard: marker + node markup (inline CSS). */
export function serializeNodes(nodes: Node[], token: string): string {
  return makeMarker(token) + nodesToHtml(nodes, { mode: 'inline', indent: false }).html;
}

const KNOWN_TAGS =
  'div|section|article|header|footer|nav|main|aside|p|span|a|button|h[1-6]|ul|ol|li|img|svg|form|input|label|table|figure|html|body|style';

/** Does the text look like HTML (starts with `<` and has a closing tag or a known tag)? */
export function looksLikeHtml(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.startsWith('<')) return false;
  if (t.startsWith('<!--') && MARKER_RE.test(t)) return true;
  return new RegExp(`</[a-z][\\w-]*\\s*>|<(?:${KNOWN_TAGS})(?:[\\s>/])`, 'i').test(t);
}

/** HTML with a class attribute (only then is it worth loading the Tailwind engine). */
const HAS_CLASS_RE = /\bclass\s*=\s*["']/i;

export interface HtmlPaste {
  nodes: Node[];
  /** Extra ops applied together with the creation (e.g. setCssBase for Tailwind). */
  ops: Op[];
  tailwind: boolean;
  /** Notices for the user (e.g. shadcn tokens created together with the paste). */
  notes: string[];
}

/** Name of the shadcn color the class uses (`hover:bg-primary/90` → `primary`), as in the MCP. */
function shadcnColorOf(cls: string, names: string[]): string | null {
  const utility = cls
    .slice(cls.lastIndexOf(':') + 1)
    .replace(/^[!-]/, '')
    .replace(/\/\S+$/, '')
    .replace(/!$/, '');
  let best: string | null = null;
  for (const n of names) {
    if (utility.endsWith(`-${n}`) && (!best || n.length > best.length)) best = n;
  }
  return best;
}

/**
 * Pasted HTML → nodes. If it looks like Tailwind (detectTailwind), loads the engine on demand, keeps the
 * classes (node.classes), compiles them into style/states and requests the preflight (setCssBase) if the
 * document does not use it yet. Without Tailwind (or if the engine fails), it is the usual htmlToNodes.
 */
export async function htmlToPasteNodes(html: string, doc: Document): Promise<HtmlPaste> {
  const plain = (): HtmlPaste => ({
    nodes: htmlToNodes(html),
    ops: [],
    tailwind: false,
    notes: [],
  });
  if (!HAS_CLASS_RE.test(html)) return plain();
  let loaded: Awaited<ReturnType<typeof loadTailwindEngine>>;
  try {
    loaded = await loadTailwindEngine(doc);
  } catch {
    return plain();
  }
  const { mod, engine } = loaded;
  if (!mod.detectTailwind(html, engine).tailwind) return plain();
  const nodes = htmlToNodes(html, { keepClasses: true });
  const ops: Op[] = doc.cssBase === 'tailwind' ? [] : [{ type: 'setCssBase', base: 'tailwind' }];
  const notes: string[] = [];

  // Like `import_component` (tokens "auto"): if the HTML uses shadcn preset colors that the document
  // does not have, creates the tokens in the same paste (a single undo) and recompiles the engine with them.
  let tokens = doc.tokens;
  let themes = doc.themes;
  const used = new Set<string>();
  for (const n of mod.nodesWithClasses(nodes)) {
    for (const c of n.classes!.split(/\s+/)) {
      if (!c || !mod.usesShadcnColor(c)) continue;
      const name = shadcnColorOf(c, mod.SHADCN_COLOR_NAMES);
      if (name) used.add(name);
    }
  }
  if ([...used].some((n) => !(`--color-${n}` in doc.tokens))) {
    const plan = mod.planShadcnTokens(doc);
    if (plan.created.length) {
      ops.push(...plan.ops);
      tokens = { ...doc.tokens };
      for (const op of plan.ops) {
        if (op.type === 'setTokens') Object.assign(tokens, op.set);
        if (op.type === 'setThemes') themes = op.themes;
      }
      notes.push(`shadcn preset tokens created (${plan.created.length}, plus the "dark" theme).`);
    }
  }
  const finalEngine =
    tokens === doc.tokens ? engine : await mod.getTailwindEngine({ tokens, themes });
  // Same rule as the MCP: with the shadcn tokens, a border without a color uses var(--color-border).
  const shadcn = '--color-border' in tokens && '--color-primary' in tokens;
  mod.applyTailwindToNodes(nodes, finalEngine, {
    ...(shadcn ? { defaultBorderColor: 'var(--color-border)' } : {}),
  });
  return { nodes, ops, tailwind: true, notes };
}

export type PasteKind = 'internal' | 'snapshot' | 'images' | 'html' | 'text' | 'none';

/**
 * SVG nodes pasted as markup get the vector model (`svgToVector`, with `raw` preserved) and the
 * viewBox size, if the style has no width/height. Markup that does not become a vector stays as is.
 */
export function withVectors(nodes: Node[]): Node[] {
  return nodes.map((n) => {
    let next = n;
    if (n.type === 'svg' && !n.vector && n.svg) {
      try {
        const vector = svgToVector(n.svg);
        const style = { ...n.style };
        if (!style.width) style.width = `${vector.viewBox.width}px`;
        if (!style.height) style.height = `${vector.viewBox.height}px`;
        next = { ...n, vector, style, svg: vectorToSvg(vector) };
      } catch {
        next = n;
      }
    }
    return next.children.length ? { ...next, children: withVectors(next.children) } : next;
  });
}

/** Decides how to interpret the pasted content. */
export function classifyPaste(
  data: { html: string; text: string; imageCount: number },
  internalToken: string | null,
): PasteKind {
  const token = extractMarker(data.html) ?? extractMarker(data.text);
  if (token && internalToken && token === internalToken) return 'internal';
  if (looksLikeSnapshot(data.text)) return 'snapshot';
  if (data.imageCount > 0) return 'images';
  if (looksLikeHtml(data.html) || looksLikeHtml(data.text)) return 'html';
  if (data.text.length > 0) return 'text';
  return 'none';
}

/* ------------------------------------------------------------------ */
/* target                                                             */
/* ------------------------------------------------------------------ */

export interface PasteTarget {
  /** Target parent; `null` = page root. */
  parentId: string | null;
  parent: Node | null;
  pageId: string;
  /** Insertion index; absent = at the end. */
  index?: number;
}

/**
 * Where to paste: 1 node that accepts children → inside it, at the end; leaf node (or several) → after
 * it in the same parent; no selection → page root.
 */
export function resolvePasteTarget(
  doc: Document,
  selection: readonly string[],
  pageId: string | null,
): PasteTarget | null {
  const entries = selection.map((id) => getEntry(doc, id)).filter((e) => !!e);
  const fallbackPage = (pageId && doc.pages.find((p) => p.id === pageId)) || doc.pages[0];
  if (entries.length === 0) {
    return fallbackPage
      ? intoMain(doc, { parentId: null, parent: null, pageId: fallbackPage.id })
      : null;
  }
  let target: PasteTarget;
  if (entries.length === 1 && canHaveChildren(entries[0]!.node)) {
    const e = entries[0]!;
    target = { parentId: e.node.id, parent: e.node, pageId: e.pageId };
  } else {
    const lastId = sortByDocumentOrder(
      doc,
      entries.map((e) => e!.node.id),
    ).at(-1)!;
    const last = getEntry(doc, lastId)!;
    target = {
      parentId: last.parentId,
      parent: last.parentId ? (getNode(doc, last.parentId) ?? null) : null,
      pageId: last.pageId,
      index: last.index + 1,
    };
  }
  // Nothing goes into a locked node (nor into a descendant of it): goes up to the first free parent, pasting
  // right after the locked one; above the root frame, the paste goes to the page root.
  // Nor into internal nodes/roots of instances (only into slot content) and into the main component's frame.
  while (
    target.parentId &&
    (isLockedDeep(doc, target.parentId) || !canInsertInto(doc, target.parentId))
  ) {
    const locked = getEntry(doc, target.parentId)!;
    target = locked.parentId
      ? {
          parentId: locked.parentId,
          parent: getNode(doc, locked.parentId) ?? null,
          pageId: locked.pageId,
          index: locked.index + 1,
        }
      : { parentId: null, parent: null, pageId: locked.pageId };
  }
  return intoMain(doc, target);
}

/** In main component edit mode there is no page root: pastes inside the main component's root. */
function intoMain(doc: Document, target: PasteTarget): PasteTarget | null {
  if (target.parentId || target.pageId !== COMPONENT_EDIT_PAGE_ID) return target;
  const root = doc.pages.find((p) => p.id === COMPONENT_EDIT_PAGE_ID)?.frames[0]?.children[0];
  if (!root || !canInsertInto(doc, root.id)) return null;
  return { parentId: root.id, parent: root, pageId: target.pageId };
}

/* ------------------------------------------------------------------ */
/* preparation                                                        */
/* ------------------------------------------------------------------ */

export interface PasteOptions {
  /** Screen center in world coordinates (paste at the root). */
  center: { x: number; y: number };
  /** How many times this same content has already been pasted (shifts +40 / +16 each time). */
  pasteCount?: number;
  /** Measures the original node (id) in px; used when width/height are missing. */
  measure?: (id: string) => { w: number; h: number } | null;
}

const DEFAULT_PASTE_SIZE = { w: 400, h: 300 };

const px = (n: number): string => `${Math.round(n)}px`;

function sizeOf(node: Node, measure?: PasteOptions['measure']): { w: number; h: number } {
  const m = measure?.(node.id);
  return {
    w: pxValue(node.style.width) ?? m?.w ?? DEFAULT_PASTE_SIZE.w,
    h: pxValue(node.style.height) ?? m?.h ?? DEFAULT_PASTE_SIZE.h,
  };
}

/**
 * Clones the nodes with new ids and adapts them to the target. At the root they become frames (leaf nodes — text,
 * image, svg — are wrapped in a new frame); inside a node, frames become elements.
 */
export function prepareNodesForPaste(
  nodes: readonly Node[],
  target: Pick<PasteTarget, 'parentId' | 'parent'>,
  opts: PasteOptions,
): Node[] {
  const count = opts.pasteCount ?? 0;
  if (target.parentId === null) return prepareForRoot(nodes, opts, count);

  const parentFlex = isFlex(target.parent);
  return nodes.map((original) => {
    const base: Node = { ...original, type: original.type === 'frame' ? 'element' : original.type };
    const { node } = cloneNodeWithNewIds(base);
    delete node.position;
    if (original.type === 'frame') {
      node.style = { ...node.style };
      for (const k of ['left', 'top', 'right', 'bottom']) delete node.style[k];
      if (node.style.position === 'absolute' || node.style.position === 'fixed') {
        delete node.style.position;
      }
    }
    if (!parentFlex && isAbsolute(node)) {
      const shift = 16 * (count + 1);
      const left = pxValue(node.style.left);
      const top = pxValue(node.style.top);
      if (left !== undefined) node.style.left = px(left + shift);
      if (top !== undefined) node.style.top = px(top + shift);
    }
    return node;
  });
}

function prepareForRoot(nodes: readonly Node[], opts: PasteOptions, count: number): Node[] {
  interface Item {
    node: Node;
    w: number;
    h: number;
    relX: number;
    relY: number;
  }
  const items: Item[] = [];
  let cursorX = 0;
  const first = nodes[0]?.position;
  for (const original of nodes) {
    const { w, h } = sizeOf(original, opts.measure);
    let node: Node;
    let width = w;
    let height = h;
    if (isLeafNode(original)) {
      const child = cloneNodeWithNewIds(original).node;
      delete child.position;
      for (const k of POSITION_STYLE_KEYS) delete child.style[k];
      node = makeLeafFrame(original, 0, 0, w, h, DEFAULT_PASTE_SIZE);
      node.children = [child];
      width = pxValue(node.style.width)!;
      height = pxValue(node.style.height)!;
    } else {
      node = cloneNodeWithNewIds({ ...original, type: 'frame' }).node;
      node.style = { ...node.style, width: px(w), height: px(h) };
      for (const k of ['left', 'top', 'right', 'bottom']) delete node.style[k];
      node.style.position = 'relative';
    }
    let relX = cursorX;
    let relY = 0;
    if (first && original.position) {
      relX = original.position.x - first.x;
      relY = original.position.y - first.y;
    }
    items.push({ node, w: width, h: height, relX, relY });
    cursorX += width + 40;
  }
  if (items.length === 0) return [];
  const minX = Math.min(...items.map((i) => i.relX));
  const minY = Math.min(...items.map((i) => i.relY));
  const maxX = Math.max(...items.map((i) => i.relX + i.w));
  const maxY = Math.max(...items.map((i) => i.relY + i.h));
  const originX = opts.center.x - (maxX - minX) / 2 - minX + 40 * count;
  const originY = opts.center.y - (maxY - minY) / 2 - minY + 40 * count;
  return items.map((i) => {
    i.node.position = { x: Math.round(originX + i.relX), y: Math.round(originY + i.relY) };
    return i.node;
  });
}
