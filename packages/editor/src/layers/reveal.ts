/** Seleciona nós, troca de página se preciso e pede ao canvas para enquadrá-los (como a seleção do MCP). */
import { baseNodeId } from '@mockup/core';
import { getEntry } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

/** Devolve quantos nós existem de fato no documento ativo. */
export function revealNodes(nodeIds: readonly string[]): number {
  const doc = useDoc.getState().doc;
  if (!doc) return 0;
  const ids = [...new Set(nodeIds.map(baseNodeId))].filter((id) => getEntry(doc, id));
  if (!ids.length) return 0;
  const pageId = getEntry(doc, ids[0]!)!.pageId;
  if (pageId !== (useUi.getState().pageId ?? doc.pages[0]?.id)) ui.setPage(pageId);
  ui.select(ids);
  ui.focus(ids);
  return ids.length;
}
