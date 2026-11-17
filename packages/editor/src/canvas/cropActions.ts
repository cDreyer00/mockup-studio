/** Entrada, confirmação e cancelamento do modo de recorte visual (estado em `uiStore`). */
import type { ImageCrop } from '@mockup/core';
import { daemon } from '../client/daemon';
import { getNode } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { CROP_MODE_PREVIEW_STYLE, NO_CROP, buildCropOp, cropOfStyle } from './crop';

/** Entra no modo de recorte da imagem; devolve `false` se o nó não é uma imagem ou está travado. */
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

/** Cancela (Esc): descarta o recorte em edição. */
export function cancelCrop(): void {
  const id = useUi.getState().cropNodeId;
  if (id) leave(id);
}

/** Confirma (Enter/clicar fora): uma op `updateStyles` com `object-view-box` (ou `unset` se zerado). */
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

/** Remove o recorte da imagem (também fora do modo de recorte). */
export async function removeCrop(nodeId: string): Promise<void> {
  const doc = useDoc.getState().doc;
  const node = doc ? getNode(doc, nodeId) : undefined;
  if (!node) return;
  const op = buildCropOp(nodeId, node.style, NO_CROP);
  if (op) await daemon.applySafe([op]);
  if (useUi.getState().cropNodeId === nodeId) leave(nodeId);
}
