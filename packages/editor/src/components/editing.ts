/**
 * Modo de edição isolado do principal: o canvas mostra só a página sintética com a raiz do
 * principal (ver `components/model.ts`); as edições usam os ids reais dos nós do principal e o
 * daemon as roteia para `updateComponent` (propagam para todas as instâncias; undo/redo normais).
 */
import { COMPONENT_EDIT_PAGE_ID, findComponentNode, getComponent } from '@mockup/core';
import type { Document } from '@mockup/core';
import { canvasApi } from '../canvas/canvasApi';
import { getEntry } from '../model/tree';
import { getRawDoc, useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';

/** Componente dono do primeiro id que é nó de um principal (ou `null`). */
export function mainOfSelection(raw: Document, ids: readonly string[]): string | null {
  for (const id of ids) {
    const hit = findComponentNode(raw, id);
    if (hit) return hit.component.id;
  }
  return null;
}

/** O principal em edição ainda existe no documento? */
export function isEditingValid(): boolean {
  const id = useUi.getState().editingComponentId;
  const raw = getRawDoc();
  return !!id && !!raw && !!getComponent(raw, id);
}

/**
 * Entra no modo de edição do principal `componentId` (seleciona a raiz dele). `originId` é a
 * instância de onde se entrou: a área do principal usa a largura dela e ela volta a ser
 * selecionada ao concluir.
 */
export function enterComponent(componentId: string, originId: string | null = null): boolean {
  const raw = getRawDoc();
  const def = raw ? getComponent(raw, componentId) : undefined;
  if (!def) {
    ui.toast(`Componente "${componentId}" não encontrado`, 'error');
    return false;
  }
  const u = useUi.getState();
  const prev = u.editingComponentId ? u.componentEdit : null;
  const rect = originId ? canvasApi.nodeRect(originId) : null;
  // Primeiro o modo (a visão ganha a página sintética), depois a página e a seleção.
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

/** Sai do modo de edição: volta à página de origem e seleciona a instância de onde se entrou. */
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

/** Nome do principal em edição (para a barra do modo). */
export function editingComponentName(): string | null {
  const id = useUi.getState().editingComponentId;
  const raw = getRawDoc();
  return id && raw ? (getComponent(raw, id)?.name ?? null) : null;
}
