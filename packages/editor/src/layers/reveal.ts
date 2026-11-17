/** Selects nodes, switches page if needed and asks the canvas to frame them (like the MCP selection). */
import { baseNodeId } from '@mockup/core';
import { getEntry } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

/** Returns how many of the nodes actually exist in the active document. */
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
