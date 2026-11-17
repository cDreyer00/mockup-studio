/** Pure logic of the layers panel: visible list, selection range and drop computation. */
import { COMPONENT_EDIT_PAGE_ID } from '@mockup/core';
import type { Document, Node, Op, Page, StyleChange } from '@mockup/core';
import {
  LEAF_FRAME_PADDING,
  POSITION_STYLE_KEYS,
  isLeafNode,
  makeLeafFrame,
} from '../model/factory';
import { canInsertInto, structureBlock } from '../components/model';
import { canHaveChildren, getEntry, getNode, isAncestor, pxValue, topLevel } from '../model/tree';

export interface FlatRow {
  id: string;
  node: Node;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

/** Visible rows (pre-order) of the page, omitting the descendants of collapsed nodes. */
export function flattenTree(page: Page, collapsed: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const visit = (node: Node, depth: number, parentId: string | null) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && !collapsed.has(node.id);
    out.push({ id: node.id, node, depth, parentId, hasChildren, expanded });
    if (expanded) for (const c of node.children) visit(c, depth + 1, node.id);
  };
  for (const f of page.frames) visit(f, 0, null);
  return out;
}

/** Ids between `anchor` and `id` (inclusive) in visible order; without a valid anchor, just `[id]`. */
export function rangeBetween(
  visible: readonly string[],
  anchor: string | null,
  id: string,
): string[] {
  const a = anchor ? visible.indexOf(anchor) : -1;
  const b = visible.indexOf(id);
  if (b < 0) return [id];
  if (a < 0) return [id];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return visible.slice(from, to + 1);
}

/** Next free name "Page N". */
export function nextPageName(pages: readonly Page[]): string {
  const names = new Set(pages.map((p) => p.name));
  let n = pages.length + 1;
  while (names.has(`Page ${n}`)) n++;
  return `Page ${n}`;
}

export type DropZone = 'before' | 'after' | 'inside';
export type DropTarget = { id: string; zone: DropZone } | { rootOfPage: string; index?: number };

export type Measure = (id: string) => { x: number; y: number; w: number; h: number } | null;

/** Drop zone from the relative vertical position (0..1) in the row. */
export function zoneFor(node: Node, fraction: number): DropZone {
  if (canHaveChildren(node)) {
    if (fraction < 0.25) return 'before';
    if (fraction > 0.75) return 'after';
    return 'inside';
  }
  return fraction < 0.5 ? 'before' : 'after';
}

/**
 * Ops to drop `draggedIds` onto `target`. `null` when the drop is invalid (into itself or a
 * descendant, a target that does not accept children, nothing to move).
 * The core `index` is applied after removing the moved nodes; here it is adjusted for that.
 */
export function computeDropOps(
  doc: Document,
  draggedIds: readonly string[],
  target: DropTarget,
  measure?: Measure,
): Op[] | null {
  const dragged = topLevel(doc, draggedIds);
  if (!dragged.length) return null;
  // Internal nodes of instances, slot containers and the main component root do not move.
  if (structureBlock(doc, dragged)) return null;

  let parentId: string | null;
  let pageId: string;
  let index: number;
  if ('rootOfPage' in target) {
    const page = doc.pages.find((p) => p.id === target.rootOfPage);
    if (!page || page.id === COMPONENT_EDIT_PAGE_ID) return null;
    parentId = null;
    pageId = page.id;
    index = target.index ?? page.frames.length;
  } else {
    const entry = getEntry(doc, target.id);
    if (!entry) return null;
    if (target.zone === 'inside') {
      if (!canHaveChildren(entry.node)) return null;
      parentId = entry.node.id;
      pageId = entry.pageId;
      index = entry.node.children.length;
    } else {
      parentId = entry.parentId;
      pageId = entry.pageId;
      index = entry.index + (target.zone === 'after' ? 1 : 0);
    }
  }

  if (parentId) {
    if (dragged.includes(parentId)) return null;
    if (dragged.some((d) => isAncestor(doc, d, parentId!))) return null;
    const p = getNode(doc, parentId);
    if (!p || !canHaveChildren(p) || !canInsertInto(doc, parentId)) return null;
  }

  // Subtracts the moved nodes that are before the insertion point in the same container.
  let before = 0;
  for (const id of dragged) {
    const e = getEntry(doc, id)!;
    if (e.parentId === parentId && e.pageId === pageId && e.index < index) before++;
  }
  index -= before;

  const move: Op = parentId
    ? { type: 'moveNodes', nodeIds: dragged, parentId, index }
    : { type: 'moveNodes', nodeIds: dragged, parentId: null, pageId, index };
  const ops: Op[] = [move];

  if (parentId === null) {
    const pad = LEAF_FRAME_PADDING;
    const positions: { nodeId: string; position: { x: number; y: number } | null }[] = [];
    const styles: StyleChange[] = [];
    // Text, image and SVG do not become frames on their own (as with paste): they get a wrapping
    // frame in the same place. The `moveNodes` above put them contiguously at `index + k`; each wrap inserts the
    // frame before the leaf and moves the leaf into it, without changing the index of the following ones.
    const wraps: Op[] = [];
    dragged.forEach((id, k) => {
      const e = getEntry(doc, id)!;
      if (e.parentId === null) return;
      const rect = measure?.(id) ?? null;
      if (isLeafNode(e.node)) {
        const w = rect?.w ?? pxValue(e.node.style.width) ?? 200;
        const h = rect?.h ?? pxValue(e.node.style.height) ?? 40;
        const at = rect ? { x: rect.x, y: rect.y } : { x: pad, y: pad };
        const frame = makeLeafFrame(e.node, at.x - pad, at.y - pad, w, h);
        wraps.push(
          { type: 'createNode', parentId: null, pageId, index: index + k, node: frame },
          { type: 'moveNodes', nodeIds: [id], parentId: frame.id, index: 0 },
        );
        const unset = POSITION_STYLE_KEYS.filter((p) => e.node.style[p] !== undefined);
        if (unset.length) styles.push({ nodeId: id, unset });
        if (e.node.position) positions.push({ nodeId: id, position: null });
        return;
      }
      positions.push({
        nodeId: id,
        position: rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : { x: 0, y: 0 },
      });
      const set: Record<string, string> = {};
      if (rect) {
        if (pxValue(e.node.style.width) === undefined) set.width = `${Math.round(rect.w)}px`;
        if (pxValue(e.node.style.height) === undefined) set.height = `${Math.round(rect.h)}px`;
      }
      if (Object.keys(set).length) styles.push({ nodeId: id, set });
    });
    ops.push(...wraps);
    if (positions.length) ops.push({ type: 'setPosition', changes: positions });
    if (styles.length) ops.push({ type: 'updateStyles', changes: styles });
  } else {
    const roots = dragged.filter((id) => getEntry(doc, id)!.parentId === null);
    if (roots.length) {
      ops.push({
        type: 'setPosition',
        changes: roots.map((nodeId) => ({ nodeId, position: null })),
      });
    }
  }
  return ops;
}
