/** Entering, confirming and cancelling visual crop mode (state in `uiStore`). */
import type { ImageCrop } from '@mockup/core';
import { daemon } from '../client/daemon';
import { getNode } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { CROP_MODE_PREVIEW_STYLE, NO_CROP, buildCropOp, cropOfStyle } from './crop';

/** Enters the image crop mode; returns `false` if the node is not an image or is locked. */
export function startCrop(nodeId: string): boolean {
  const node = useDoc.getState().doc ? getNode(useDoc.getState().doc!, nodeId) : undefined;
  if (!node || node.type !== 'image' || node.locked) return false;
  ui.select([nodeId]);
  ui.startCrop(nodeId, cropOfStyle(node.style) ?? NO_CROP);
  ui.setPreview({ ...useUi.getState().preview, [nodeId]: { style: CROP_MODE_PREVIEW_STYLE } });
  return true;
}

function leave(nodeId: string): void {
  const { preview } = useUi.getState();
  ui.endCrop();
  if (preview[nodeId]) ui.releasePreview({ [nodeId]: preview[nodeId]! });
}

/** Cancels (Esc): discards the crop being edited. */
export function cancelCrop(): void {
  const id = useUi.getState().cropNodeId;
  if (id) leave(id);
}

/** Confirms (Enter/click outside): one `updateStyles` op with `object-view-box` (or `unset` if reset). */
export async function commitCrop(crop?: ImageCrop): Promise<void> {
  const { cropNodeId, cropDraft } = useUi.getState();
  if (!cropNodeId) return;
  const doc = useDoc.getState().doc;
  const node = doc ? getNode(doc, cropNodeId) : undefined;
  const draft = crop ?? cropDraft;
  if (node && draft) {
    const op = buildCropOp(node.id, node.style, draft);
    if (op) await daemon.applySafe([op]);
  }
  leave(cropNodeId);
}

/** Removes the image crop (also outside crop mode). */
export async function removeCrop(nodeId: string): Promise<void> {
  const doc = useDoc.getState().doc;
  const node = doc ? getNode(doc, nodeId) : undefined;
  if (!node) return;
  const op = buildCropOp(nodeId, node.style, NO_CROP);
  if (op) await daemon.applySafe([op]);
  if (useUi.getState().cropNodeId === nodeId) leave(nodeId);
}
