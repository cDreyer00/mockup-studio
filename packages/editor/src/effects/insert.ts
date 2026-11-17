/** Pure assembly of the ops that insert an effect (as a background or as a layer). No DOM or daemon. */
import { EFFECT_BACKGROUND_STYLE, createEffectNode, getEffect } from '@mockup/core';
import type { Document, MediaParamValue, Node, Op } from '@mockup/core';
import { getFrameOf, getNode } from '../model/tree';

export interface EffectInsertOptions {
  /** Plain child layer (100% x 240px, in flow) instead of the parent background. */
  asLayer?: boolean;
}

export interface EffectInsertPlan {
  ops: Op[];
  /** Id of the created effect node. */
  nodeId: string;
  /** Parent that receives the effect. */
  parentId: string;
}

/** Style of a plain effect layer. */
export const EFFECT_LAYER_STYLE: Readonly<Record<string, string>> = {
  width: '100%',
  height: '240px',
  display: 'block',
};

/**
 * Effect parent: the first selected node if it is a frame/element; otherwise its frame; with no
 * selection, the first frame of page `pageId` (or of the first page).
 */
export function resolveEffectTarget(
  doc: Document,
  selection: readonly string[],
  pageId: string | null,
): string | null {
  for (const id of selection) {
    const node = getNode(doc, id);
    if (!node) continue;
    if (node.type === 'frame' || node.type === 'element') return node.id;
    const frame = getFrameOf(doc, id);
    if (frame) return frame.id;
  }
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  return page?.frames[0]?.id ?? null;
}

/**
 * Ops to insert an effect into `targetId`: a `createNode` (index 0 for the background) and, when
 * missing, `position: relative` and `isolation: isolate` on the parent, all in the same apply. `null` if the target does not exist.
 */
export function buildEffectInsertOps(
  doc: Document,
  targetId: string,
  kind: string,
  params: Record<string, MediaParamValue>,
  opts: EffectInsertOptions = {},
): EffectInsertPlan | null {
  const parent = getNode(doc, targetId);
  if (!parent) return null;
  const name = getEffect(kind)?.label ?? 'Effect';
  const styles = opts.asLayer ? EFFECT_LAYER_STYLE : EFFECT_BACKGROUND_STYLE;
  const node: Node = createEffectNode(kind, params, { name, styles: { ...styles } });
  const ops: Op[] = [];
  if (!opts.asLayer) {
    const set: Record<string, string> = {};
    const pos = parent.style.position;
    if (!pos || pos === 'static') set.position = 'relative';
    if (parent.style.isolation !== 'isolate') set.isolation = 'isolate';
    if (Object.keys(set).length)
      ops.push({ type: 'updateStyles', changes: [{ nodeId: targetId, set }] });
  }
  ops.push({
    type: 'createNode',
    parentId: targetId,
    node,
    ...(opts.asLayer ? {} : { index: 0 }),
  });
  return { ops, nodeId: node.id, parentId: targetId };
}
