/**
 * Where a new node (rectangle, text, image) goes: deepest container under the pointer and the
 * way to position it (flex flow or absolute relative to the parent), plus the creation ops.
 */
import type { Document, Node, Op } from '@mockup/core';
import {
  canHaveChildren,
  flexDirection,
  getNode,
  isFlex,
  isHiddenDeep,
  isLockedDeep,
} from '../model/tree';
import { canInsertInto } from '../components/model';
import { clientToWorld, findNodeEl, getCanvasRoot, measureWorldRect, worldToClient } from './dom';
import { resolveFlowInsert } from './geometry';
import type { Axis, Point, SiblingRect } from './geometry';

export interface Placement {
  /** Parent of the new node; `null` = no container (becomes a root frame). */
  parentId: string | null;
  /** Goes into the parent's flow (flex), without `position`. */
  flow: boolean;
  /** Insertion index when `flow`. */
  index?: number;
  /** Position relative to the parent (when not flow) or, without a parent, position in the world. */
  x: number;
  y: number;
  /** The parent is static: include `position: relative` in the same apply. */
  parentNeedsRelative: boolean;
}

/**
 * Deepest container under the window point that accepts children and is not locked/hidden.
 * Inner nodes and roots of component instances do not accept children (only slot content).
 */
export function findContainerAt(
  root: HTMLElement,
  doc: Document,
  clientX: number,
  clientY: number,
): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!root.contains(el)) continue;
    const id = el.closest('[data-node-id]')?.getAttribute('data-node-id');
    const node = id ? getNode(doc, id) : undefined;
    if (!id || !node) continue;
    if (
      canHaveChildren(node) &&
      canInsertInto(doc, id) &&
      !isLockedDeep(doc, id) &&
      !isHiddenDeep(doc, id)
    )
      return id;
  }
  return null;
}

/** Stacking axis of flow children: flex uses `flex-direction`; block is vertical. */
export function flowAxis(parent: Node): Axis {
  return isFlex(parent) ? flexDirection(parent) : 'column';
}

/** Rectangles (world) of the parent's rendered children, with the real index in `children`. */
export function siblingWorldRects(root: HTMLElement, parent: Node): SiblingRect[] {
  const out: SiblingRect[] = [];
  parent.children.forEach((c, index) => {
    const rect = c.hidden ? null : measureWorldRect(root, c.id);
    if (rect) out.push({ index, rect });
  });
  return out;
}

/**
 * Decides the parent and position for a node created at `at` (world). `client` is the window point
 * used to find the container (default: derived from `at`).
 */
export function planPlacement(doc: Document, at: Point, client?: Point): Placement {
  const root = getCanvasRoot();
  const none: Placement = {
    parentId: null,
    flow: false,
    x: at.x,
    y: at.y,
    parentNeedsRelative: false,
  };
  if (!root) return none;
  const c = client ?? worldToClient(root, at);
  const parentId = findContainerAt(root, doc, c.x, c.y);
  const parent = parentId ? getNode(doc, parentId) : undefined;
  if (!parentId || !parent) return none;
  const pointer = client ? clientToWorld(root, client.x, client.y) : at;
  if (isFlex(parent)) {
    const { moveIndex } = resolveFlowInsert(
      siblingWorldRects(root, parent),
      pointer,
      flowAxis(parent),
    );
    return { parentId, flow: true, index: moveIndex, x: 0, y: 0, parentNeedsRelative: false };
  }
  // Origin of the absolute child = parent's padding edge (positioned parent or becoming relative).
  const rect = measureWorldRect(root, parentId);
  const el = findNodeEl(root, parentId);
  const ox = (rect?.x ?? 0) + (el?.clientLeft ?? 0);
  const oy = (rect?.y ?? 0) + (el?.clientTop ?? 0);
  const pos = parent.style.position;
  return {
    parentId,
    flow: false,
    x: Math.round(at.x - ox),
    y: Math.round(at.y - oy),
    parentNeedsRelative: !pos || pos === 'static',
  };
}

/** Creation ops: `node` is a root frame when `placement.parentId` is null. */
export function buildCreateOps(pageId: string, placement: Placement, node: Node): Op[] {
  if (!placement.parentId) return [{ type: 'createNode', pageId, node }];
  const ops: Op[] = [];
  if (placement.parentNeedsRelative) {
    ops.push({
      type: 'updateStyles',
      changes: [{ nodeId: placement.parentId, set: { position: 'relative' } }],
    });
  }
  ops.push({
    type: 'createNode',
    parentId: placement.parentId,
    node,
    ...(placement.flow && placement.index !== undefined ? { index: placement.index } : {}),
  });
  return ops;
}
