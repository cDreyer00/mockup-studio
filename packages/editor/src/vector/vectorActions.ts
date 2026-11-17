/**
 * Vector actions: text to outlines (server route), booleans and flatten (core builders).
 * Each action applies the ops in ONE `applySafe` call (= one undo entry) and selects the result.
 */
import { buildBooleanOps, buildFlattenOps, findNode, isFreeNode } from '@mockup/core';
import type { BooleanOp, Box, Document, Op } from '@mockup/core';
import { findNodeEl, getCanvasRoot, measureWorldRect } from '../canvas/dom';
import { daemon } from '../client/daemon';
import { getNode, isLockedDeep, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Top-level selection without locked nodes. */
function selectedIds(doc: Document): string[] {
  return topLevel(doc, useUi.getState().selection).filter((id) => !isLockedDeep(doc, id));
}

/** Ids of the selection's svg nodes. */
export function selectedSvgIds(doc: Document | null, selection: readonly string[]): string[] {
  if (!doc) return [];
  return topLevel(doc, selection).filter((id) => getNode(doc, id)?.type === 'svg');
}

/** Converts the selected text nodes to svg (outlines) and selects the new nodes. */
export async function textToOutlines(): Promise<void> {
  const { doc, activeDocId } = useDoc.getState();
  if (!doc || !activeDocId) return;
  const ids = selectedIds(doc).filter((id) => getNode(doc, id)?.type === 'text');
  if (ids.length === 0) {
    ui.toast('Select a text to convert to outlines', 'info');
    return;
  }
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(activeDocId)}/text-to-outlines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeIds: ids }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      nodeIds?: string[];
      notes?: string[];
      error?: string;
    };
    if (!res.ok || !body.nodeIds) {
      ui.toast(body.error ?? `Failed to convert to outlines (${res.status})`, 'error');
      return;
    }
    ui.select(body.nodeIds);
    if (body.notes && body.notes.length > 0) ui.toast(body.notes.join(' '), 'info');
  } catch (e) {
    ui.toast(errorText(e), 'error');
  }
}

/**
 * Boxes measured from the DOM for flow nodes (non-root and without position absolute/fixed), in world px,
 * relative to the parent's padding box (child rect − parent rect − parent border). Free-positioned ones follow
 * the style and are left out; without a canvas or element, the core rejects the node with a clear message.
 */
export function measureFlowBoxes(doc: Document, ids: readonly string[]): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  const root = getCanvasRoot();
  if (!root) return boxes;
  for (const id of ids) {
    const found = findNode(doc, id);
    if (!found?.parent || isFreeNode(found.node, false)) continue;
    const rect = measureWorldRect(root, id);
    const parentRect = measureWorldRect(root, found.parent.id);
    const parentEl = findNodeEl(root, found.parent.id);
    if (!rect || !parentRect) continue;
    boxes[id] = {
      x: rect.x - parentRect.x - (parentEl?.clientLeft ?? 0),
      y: rect.y - parentRect.y - (parentEl?.clientTop ?? 0),
      width: rect.w,
      height: rect.h,
    };
  }
  return boxes;
}

async function applyBuilt(
  build: (
    doc: Document,
    ids: string[],
    boxes: Record<string, Box>,
  ) => { ops: Op[]; nodeId: string },
  minNodes: number,
  hint: string,
): Promise<void> {
  const doc = useDoc.getState().doc;
  if (!doc) return;
  const ids = selectedSvgIds(doc, selectedIds(doc));
  if (ids.length < minNodes) {
    ui.toast(hint, 'info');
    return;
  }
  try {
    const { ops, nodeId } = build(doc, ids, measureFlowBoxes(doc, ids));
    const ack = await daemon.applySafe(ops);
    if (ack) ui.select([nodeId]);
  } catch (e) {
    ui.toast(errorText(e), 'error');
  }
}

/** Union, subtraction, intersection or exclusion between the selected svgs (2 or more). */
export function booleanOp(op: BooleanOp): Promise<void> {
  return applyBuilt(
    (doc, ids, boxes) => buildBooleanOps(doc, ids, op, { boxes }),
    2,
    'Select 2 or more vectors to combine',
  );
}

/** Flatten: merges the paths of the selected svg, or of several selected svgs, into a single node. */
export function flatten(): Promise<void> {
  return applyBuilt(
    (doc, ids, boxes) => buildFlattenOps(doc, ids, { boxes }),
    1,
    'Select a vector to flatten',
  );
}
