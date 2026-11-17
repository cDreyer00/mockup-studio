/**
 * Componentes no editor (ver `docs/COMPONENTES.md`, seção Editor): a visão do documento com as
 * instâncias expandidas, a página sintética do modo de edição do principal, o papel de cada nó
 * (instância, nó interno, slot, principal) e as regras do que pode ser movido/inserido.
 *
 * O canvas, as camadas, a seleção e as propriedades trabalham sobre a visão (`useDoc().doc`); os
 * planejadores do core (`createComponentOps`, `instanceNodeFor`, `detachInstanceOps`...) recebem o
 * documento real (`useDoc().rawDoc`).
 */
import {
  COMPONENT_EDIT_PAGE_ID,
  SLOT_ATTR,
  expandDocument,
  expandNodeTree,
  findComponentNode,
  findNode,
  getComponent,
  isVirtualId,
} from '@mockup/core';
import type { Document, Node, Page } from '@mockup/core';
import { canHaveChildren, getEntry, getNode } from '../model/tree';

/** Frame sintético (não editável) que envolve a raiz do principal no modo de edição. */
export const COMPONENT_FRAME_ID = 'fr__component';
/** Respiro entre o quadro do modo de edição e a raiz do principal. */
export const COMPONENT_FRAME_PADDING = 48;

/** Parâmetros do modo de edição isolado do principal. */
export interface ComponentEditView {
  componentId: string;
  /** Largura (px) da área do principal: a da instância de origem, quando conhecida. */
  width: number | null;
  /** Fundo da página sintética (o da página de onde se entrou). */
  background: string | null;
}

/** Quadro sintético com a raiz do principal (instâncias aninhadas expandidas). */
function componentFrame(raw: Document, root: Node, name: string, width: number | null): Node {
  const pad = COMPONENT_FRAME_PADDING;
  return {
    id: COMPONENT_FRAME_ID,
    type: 'frame',
    name: `Componente ${name}`,
    tag: 'div',
    attrs: { 'data-component-frame': '' },
    style: {
      width: width ? `${Math.round(width + pad * 2)}px` : 'max-content',
      'min-width': '240px',
      padding: `${pad}px`,
      'box-sizing': 'border-box',
      display: 'flex',
      'flex-direction': 'column',
      'align-items': width ? 'stretch' : 'flex-start',
      overflow: 'visible',
      'box-shadow': 'none',
      background: 'transparent',
    },
    children: [expandNodeTree(raw, root)],
    locked: false,
    hidden: false,
    position: { x: 0, y: 0 },
  };
}

/**
 * Visão do documento: instâncias expandidas (`expandDocument`, com cache) e, no modo de edição,
 * uma página sintética `COMPONENT_EDIT_PAGE_ID` com o principal. Sem instâncias e sem edição,
 * devolve o próprio `raw`.
 */
export function buildView(raw: Document, edit: ComponentEditView | null): Document {
  const expanded = expandDocument(raw);
  const def = edit ? getComponent(raw, edit.componentId) : undefined;
  if (!edit || !def) return expanded;
  const page: Page = {
    id: COMPONENT_EDIT_PAGE_ID,
    name: def.name,
    frames: [componentFrame(raw, def.root, def.name, edit.width)],
    background: edit.background ?? raw.pages[0]?.background ?? '',
  };
  return { ...expanded, pages: [...expanded.pages, page] };
}

/* ------------------------------------------------------------------ */
/* papel dos nós                                                      */
/* ------------------------------------------------------------------ */

/**
 * - `instance`: raiz de uma instância (marcador `componentId` na árvore expandida);
 * - `internal`: nó vindo da árvore de um principal (id virtual): estilo/texto viram overrides;
 * - `slot`: contêiner de slot de uma instância (nó real; o conteúdo dele é comum);
 * - `main`: nó do principal em edição (página sintética);
 * - `frame`: o quadro sintético do modo de edição.
 */
export type ComponentRole = 'instance' | 'internal' | 'slot' | 'main' | 'frame';

export function componentRole(doc: Document | null, id: string): ComponentRole | null {
  if (!doc) return null;
  if (id === COMPONENT_FRAME_ID) return 'frame';
  const e = getEntry(doc, id);
  if (!e) return null;
  if (isVirtualId(id)) return 'internal';
  if (e.node.componentId !== undefined) return 'instance';
  if (e.pageId === COMPONENT_EDIT_PAGE_ID) return 'main';
  if (e.node.attrs[SLOT_ATTR] !== undefined && e.parentId) {
    const parent = getNode(doc, e.parentId);
    if (isVirtualId(e.parentId) || parent?.componentId !== undefined) return 'slot';
  }
  return null;
}

/** Papéis desenhados em roxo no canvas (contorno de hover/seleção). */
export function isPurpleRole(role: ComponentRole | null): boolean {
  return role === 'instance' || role === 'internal' || role === 'main' || role === 'slot';
}

/** Raiz do principal em edição (filha do quadro sintético). */
export function isMainRoot(doc: Document, id: string): boolean {
  const e = getEntry(doc, id);
  return !!e && e.pageId === COMPONENT_EDIT_PAGE_ID && e.parentId === COMPONENT_FRAME_ID;
}

/** Instância real (raiz expandida com id real) na visão. */
export function isRealInstance(doc: Document, id: string): boolean {
  return !isVirtualId(id) && getNode(doc, id)?.componentId !== undefined;
}

/**
 * Mensagem quando mover, reordenar, excluir, duplicar ou agrupar não vale para algum dos nós;
 * `null` quando pode.
 */
export function structureBlock(doc: Document, ids: readonly string[]): string | null {
  for (const id of ids) {
    if (id === COMPONENT_FRAME_ID) return 'O quadro do componente não é editável';
    if (isVirtualId(id)) {
      return 'Nós internos de uma instância não podem ser movidos, duplicados nem excluídos: edite o principal ou destaque a instância';
    }
    if (isMainRoot(doc, id)) return 'A raiz do principal não pode ser movida nem excluída';
    if (componentRole(doc, id) === 'slot') {
      return 'O contêiner de slot faz parte da instância: mova ou exclua o conteúdo dele';
    }
  }
  return null;
}

/**
 * O nó aceita filhos novos (criar, colar, soltar)? Não: nós internos, raízes de instância (só
 * aceitam conteúdo dentro de um slot) e o quadro sintético.
 */
export function canInsertInto(doc: Document, id: string): boolean {
  if (id === COMPONENT_FRAME_ID || isVirtualId(id)) return false;
  const n = getNode(doc, id);
  if (!n || n.componentId !== undefined) return false;
  return canHaveChildren(n);
}

/** Remove os marcadores de instância de nós concretos (árvore expandida copiada). */
function stripMarkers(n: Node): Node {
  const out: Node = { ...n, children: n.children.map(stripMarkers) };
  if (out.type !== 'instance') {
    delete out.componentId;
    delete out.props;
    delete out.overrides;
  }
  return out;
}

/**
 * Nó para copiar: o nó real do documento quando existe (instâncias continuam instâncias); nós
 * internos saem como a árvore concreta da visão (sem marcadores).
 */
export function copyableNode(raw: Document | null, view: Document, id: string): Node | undefined {
  if (raw && !isVirtualId(id)) {
    const real = findNode(raw, id)?.node ?? findComponentNode(raw, id)?.node;
    if (real) return structuredClone(real);
  }
  const n = getNode(view, id);
  return n ? structuredClone(stripMarkers(n)) : undefined;
}
