/**
 * Isolated edit mode of the main component: the canvas shows only the synthetic page with the main
 * component root (see `components/model.ts`); edits use the real ids of the main component nodes and the
 * daemon routes them to `updateComponent` (they propagate to all instances; normal undo/redo).
 */
import { COMPONENT_EDIT_PAGE_ID, findComponentNode, getComponent } from '@mockup/core';
import type { Document } from '@mockup/core';
import { canvasApi } from '../canvas/canvasApi';
import { getEntry } from '../model/tree';
import { getRawDoc, useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';

/** Component that owns the first id that is a node of a main component (or `null`). */
export function mainOfSelection(raw: Document, ids: readonly string[]): string | null {
  for (const id of ids) {
    const hit = findComponentNode(raw, id);
    if (hit) return hit.component.id;
  }
  return null;
}

/** Does the main component being edited still exist in the document? */
export function isEditingValid(): boolean {
  const id = useUi.getState().editingComponentId;
  const raw = getRawDoc();
  return !!id && !!raw && !!getComponent(raw, id);
}

/**
 * Enters edit mode of the main component `componentId` (selects its root). `originId` is the
 * instance it was entered from: the main component area uses its width and it is selected
 * again when done.
 */
export function enterComponent(componentId: string, originId: string | null = null): boolean {
  const raw = getRawDoc();
  const def = raw ? getComponent(raw, componentId) : undefined;
  if (!def) {
    ui.toast(`Component "${componentId}" not found`, 'error');
    return false;
  }
  const u = useUi.getState();
  const prev = u.editingComponentId ? u.componentEdit : null;
  const rect = originId ? canvasApi.nodeRect(originId) : null;
  // First the mode (the view gets the synthetic page), then the page and the selection.
  useUi.setState({
    editingComponentId: componentId,
    componentEdit: {
      fromPageId: prev ? prev.fromPageId : currentPageId(),
      originId: prev ? prev.originId : originId,
      width: rect && rect.w > 0 ? Math.round(rect.w) : null,
    },
  });
  useUi.setState({
    pageId: COMPONENT_EDIT_PAGE_ID,
    selection: [def.root.id],
    hoverId: null,
    editingTextId: null,
    preview: {},
  });
  return true;
}

/** Leaves edit mode: returns to the origin page and selects the instance it was entered from. */
export function exitComponent(): void {
  const u = useUi.getState();
  if (!u.editingComponentId) return;
  const ce = u.componentEdit;
  useUi.setState({ editingComponentId: null, componentEdit: null });
  useUi.setState({
    pageId: ce?.fromPageId ?? null,
    selection: [],
    hoverId: null,
    editingTextId: null,
    preview: {},
  });
  const doc = useDoc.getState().doc;
  if (ce?.originId && doc && getEntry(doc, ce.originId)) {
    ui.select([ce.originId]);
    ui.focus([ce.originId], true);
  }
}

/** Name of the main component being edited (for the mode bar). */
export function editingComponentName(): string | null {
  const id = useUi.getState().editingComponentId;
  const raw = getRawDoc();
  return id && raw ? (getComponent(raw, id)?.name ?? null) : null;
}
