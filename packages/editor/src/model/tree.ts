/**
 * Index and queries over the document tree, used by all areas of the editor.
 * The index is computed once per document object (cached in a WeakMap).
 */
import type { Document, Node, Page } from '@mockup/core';

export interface NodeEntry {
  node: Node;
  /** Parent id; `null` for root frames. */
  parentId: string | null;
  pageId: string;
  /** Index among siblings (in `parent.children` or `page.frames`). */
  index: number;
  /** 0 for root frames. */
  depth: number;
}

export interface DocIndex {
  nodes: Map<string, NodeEntry>;
  pages: Map<string, Page>;
}

const cache = new WeakMap<Document, DocIndex>();

export function getIndex(doc: Document): DocIndex {
  let idx = cache.get(doc);
  if (idx) return idx;
  const nodes = new Map<string, NodeEntry>();
  const pages = new Map<string, Page>();
  const visit = (
    node: Node,
    parentId: string | null,
    pageId: string,
    index: number,
    depth: number,
  ) => {
    nodes.set(node.id, { node, parentId, pageId, index, depth });
    node.children.forEach((c, i) => visit(c, node.id, pageId, i, depth + 1));
  };
  for (const page of doc.pages) {
    pages.set(page.id, page);
    page.frames.forEach((f, i) => visit(f, null, page.id, i, 0));
  }
  idx = { nodes, pages };
  cache.set(doc, idx);
  return idx;
}

export function getEntry(doc: Document, id: string): NodeEntry | undefined {
  return getIndex(doc).nodes.get(id);
}

export function getNode(doc: Document, id: string): Node | undefined {
  return getIndex(doc).nodes.get(id)?.node;
}

export function getParent(doc: Document, id: string): Node | null {
  const e = getEntry(doc, id);
  return e?.parentId ? (getNode(doc, e.parentId) ?? null) : null;
}

/** Siblings of the node (including itself), in document order. */
export function getSiblings(doc: Document, id: string): Node[] {
  const e = getEntry(doc, id);
  if (!e) return [];
  if (e.parentId) return getNode(doc, e.parentId)?.children ?? [];
  return getIndex(doc).pages.get(e.pageId)?.frames ?? [];
}

/** Chain from the root frame to the node (inclusive). Empty if the node does not exist. */
export function getChain(doc: Document, id: string): Node[] {
  const out: Node[] = [];
  let cur: string | null = id;
  while (cur) {
    const e = getEntry(doc, cur);
    if (!e) return out.length ? out.reverse() : [];
    out.push(e.node);
    cur = e.parentId;
  }
  return out.reverse();
}

/** Root frame containing the node (the node itself, if it is a root). */
export function getFrameOf(doc: Document, id: string): Node | undefined {
  return getChain(doc, id)[0];
}

export function isRoot(doc: Document, id: string): boolean {
  const e = getEntry(doc, id);
  return !!e && e.parentId === null;
}

/** `true` if `ancestorId` is a strict ancestor of `id`. */
export function isAncestor(doc: Document, ancestorId: string, id: string): boolean {
  let cur = getEntry(doc, id)?.parentId ?? null;
  while (cur) {
    if (cur === ancestorId) return true;
    cur = getEntry(doc, cur)?.parentId ?? null;
  }
  return false;
}

/** Removes nonexistent ids and those that have an ancestor also in the list; keeps document order. */
export function topLevel(doc: Document, ids: readonly string[]): string[] {
  const set = new Set(ids.filter((id) => getEntry(doc, id)));
  const kept = [...set].filter((id) => ![...set].some((o) => o !== id && isAncestor(doc, o, id)));
  return sortByDocumentOrder(doc, kept);
}

/** Sorts ids by pre-order in the document. */
export function sortByDocumentOrder(doc: Document, ids: readonly string[]): string[] {
  const order = new Map<string, number>();
  let i = 0;
  for (const id of getIndex(doc).nodes.keys()) order.set(id, i++);
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** `true` if all ids have the same parent (and the same page, for root frames). */
export function haveSameParent(doc: Document, ids: readonly string[]): boolean {
  const entries = ids.map((id) => getEntry(doc, id));
  if (entries.some((e) => !e) || entries.length === 0) return false;
  const first = entries[0]!;
  return entries.every((e) => e!.parentId === first.parentId && e!.pageId === first.pageId);
}

export function canHaveChildren(node: Node): boolean {
  if (node.type === 'text' || node.type === 'image' || node.type === 'svg') return false;
  return !['img', 'input', 'br', 'hr', 'area', 'col', 'source', 'track', 'wbr'].includes(node.tag);
}

/** Flex container (display flex/inline-flex). */
export function isFlex(node: Node | null | undefined): boolean {
  const d = node?.style.display;
  return d === 'flex' || d === 'inline-flex';
}

/** Main direction of the flex: `row` or `column` (default `row`). */
export function flexDirection(node: Node | null | undefined): 'row' | 'column' {
  return (node?.style['flex-direction'] ?? 'row').startsWith('column') ? 'column' : 'row';
}

export function isAbsolute(node: Node): boolean {
  const p = node.style.position;
  return p === 'absolute' || p === 'fixed';
}

/** `true` if the node or any ancestor is locked. */
export function isLockedDeep(doc: Document, id: string): boolean {
  return getChain(doc, id).some((n) => n.locked);
}

/** `true` if the node or any ancestor is hidden. */
export function isHiddenDeep(doc: Document, id: string): boolean {
  return getChain(doc, id).some((n) => n.hidden);
}

/** Numeric value in px of a style (`'120px'` → 120, `'120'` → 120); `undefined` if not px. */
export function pxValue(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(v);
  return m ? Number(m[1]) : undefined;
}

/** Size in px of a root frame (width/height in px; default 800x600). */
export function frameSize(frame: Node): { w: number; h: number } {
  return { w: pxValue(frame.style.width) ?? 800, h: pxValue(frame.style.height) ?? 600 };
}
