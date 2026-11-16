/**
 * Comandos de alto nível compartilhados por canvas, camadas, barra de ferramentas e atalhos.
 * Cada comando produz `Op`s e as envia em UMA chamada `daemon.apply` (= uma entrada de undo).
 * As funções `build*` são puras (testáveis); as demais leem os stores e aplicam.
 */
import { createNodeFromTag } from '@mockup/core';
import type { Document, Node, Op } from '@mockup/core';
import { daemon } from './client/daemon';
import {
  canHaveChildren,
  flexDirection,
  getEntry,
  getNode,
  getParent,
  getSiblings,
  haveSameParent,
  isFlex,
  isLockedDeep,
  isRoot,
  pxValue,
  topLevel,
} from './model/tree';
import { currentPageId } from './state/hooks';
import { useDoc } from './state/docStore';
import { ui, useUi } from './state/uiStore';

const px = (n: number): string => `${Math.round(n)}px`;

function state(): { doc: Document | null; selection: string[] } {
  return { doc: useDoc.getState().doc, selection: useUi.getState().selection };
}

/** Seleção de topo, sem nós travados (diretamente ou por ancestral). */
function editableSelection(doc: Document, ids: readonly string[]): string[] {
  return topLevel(doc, ids).filter((id) => !isLockedDeep(doc, id));
}

/* ------------------------------------------------------------------ */
/* posição                                                            */
/* ------------------------------------------------------------------ */

/** Posição atual (x, y) de um frame raiz ou filho absoluto, em px. */
export function nodeXY(doc: Document, node: Node): { x: number; y: number } {
  if (isRoot(doc, node.id)) return { x: node.position?.x ?? 0, y: node.position?.y ?? 0 };
  return {
    x: pxValue(node.style.left) ?? node.position?.x ?? 0,
    y: pxValue(node.style.top) ?? node.position?.y ?? 0,
  };
}

/**
 * Ops que levam um frame raiz ou um filho absoluto a (x, y).
 * Frames raiz usam `setPosition`; filhos absolutos usam `left`/`top` em `style`
 * (ou `setPosition`, se o nó já usa `position` sem left/top no CSS).
 */
export function buildPositionOps(doc: Document, node: Node, x: number, y: number): Op[] {
  if (
    isRoot(doc, node.id) ||
    (node.position && !('left' in node.style) && !('top' in node.style))
  ) {
    return [
      {
        type: 'setPosition',
        changes: [{ nodeId: node.id, position: { x: Math.round(x), y: Math.round(y) } }],
      },
    ];
  }
  return [
    { type: 'updateStyles', changes: [{ nodeId: node.id, set: { left: px(x), top: px(y) } }] },
  ];
}

/** Nó que se move livremente (frame raiz ou `position: absolute|fixed`). */
export function isFreelyPositioned(doc: Document, node: Node): boolean {
  if (isRoot(doc, node.id)) return true;
  const p = node.style.position;
  return p === 'absolute' || p === 'fixed';
}

/**
 * Setas: frames e absolutos movem dx/dy; filhos em fluxo dentro de flex reordenam
 * (seta para trás/frente no eixo principal).
 */
export function buildNudgeOps(doc: Document, ids: readonly string[], dx: number, dy: number): Op[] {
  const ops: Op[] = [];
  const flowByParent = new Map<string, string[]>();
  for (const id of editableSelection(doc, ids)) {
    const node = getNode(doc, id)!;
    if (isFreelyPositioned(doc, node)) {
      const { x, y } = nodeXY(doc, node);
      ops.push(...buildPositionOps(doc, node, x + dx, y + dy));
    } else {
      const parent = getParent(doc, id);
      if (!parent || !isFlex(parent)) continue;
      const list = flowByParent.get(parent.id) ?? [];
      list.push(id);
      flowByParent.set(parent.id, list);
    }
  }
  for (const [parentId, list] of flowByParent) {
    const parent = getNode(doc, parentId)!;
    const delta = flexDirection(parent) === 'row' ? Math.sign(dx) : Math.sign(dy);
    if (!delta) continue;
    const first = Math.min(...list.map((id) => getEntry(doc, id)!.index));
    const target = Math.max(0, Math.min(parent.children.length - list.length, first + delta));
    ops.push({ type: 'moveNodes', nodeIds: list, parentId, index: target });
  }
  return ops;
}

/* ------------------------------------------------------------------ */
/* estrutura                                                          */
/* ------------------------------------------------------------------ */

export function buildDeleteOps(doc: Document, ids: readonly string[]): Op[] {
  const top = editableSelection(doc, ids);
  return top.length ? [{ type: 'deleteNodes', nodeIds: top }] : [];
}

/**
 * Agrupa irmãos num container novo, na posição do primeiro. Em pai flex o container herda
 * direção/gap/alinhamento para manter o layout; frames raiz não são agrupáveis.
 */
export function buildGroupOps(
  doc: Document,
  ids: readonly string[],
): { ops: Op[]; groupId: string } | null {
  const top = editableSelection(doc, ids);
  if (!top.length || !haveSameParent(doc, top) || isRoot(doc, top[0]!)) return null;
  const parent = getParent(doc, top[0]!)!;
  const index = Math.min(...top.map((id) => getEntry(doc, id)!.index));
  const styles: Record<string, string> = {};
  if (isFlex(parent)) {
    styles.display = 'flex';
    for (const k of ['flex-direction', 'gap', 'align-items', 'justify-content', 'flex-wrap']) {
      if (parent.style[k]) styles[k] = parent.style[k]!;
    }
  }
  const group = createNodeFromTag('div', { name: 'Grupo', styles });
  return {
    groupId: group.id,
    ops: [
      { type: 'createNode', parentId: parent.id, node: group, index },
      { type: 'moveNodes', nodeIds: top, parentId: group.id, index: 0 },
    ],
  };
}

/** Desagrupa: move os filhos para o lugar do container e o exclui. */
export function buildUngroupOps(
  doc: Document,
  ids: readonly string[],
): { ops: Op[]; childIds: string[] } | null {
  const ops: Op[] = [];
  const childIds: string[] = [];
  // Ordem inversa: desagrupar um irmão posterior não desloca o índice dos anteriores.
  for (const id of editableSelection(doc, ids).reverse()) {
    const node = getNode(doc, id)!;
    if (isRoot(doc, id) || !canHaveChildren(node) || node.children.length === 0) continue;
    const entry = getEntry(doc, id)!;
    const kids = node.children.map((c) => c.id);
    ops.push({ type: 'moveNodes', nodeIds: kids, parentId: entry.parentId, index: entry.index });
    ops.push({ type: 'deleteNodes', nodeIds: [id] });
    childIds.push(...kids);
  }
  return ops.length ? { ops, childIds } : null;
}

export type ReorderKind = 'front' | 'back' | 'forward' | 'backward';

/** Ordem entre irmãos: última posição = à frente (pintada por último). */
export function buildReorderOps(doc: Document, ids: readonly string[], kind: ReorderKind): Op[] {
  const top = editableSelection(doc, ids);
  if (!top.length || !haveSameParent(doc, top)) return [];
  const e = getEntry(doc, top[0]!)!;
  const count = getSiblings(doc, top[0]!).length;
  const indices = top.map((id) => getEntry(doc, id)!.index);
  let index: number;
  if (kind === 'front') index = count - top.length;
  else if (kind === 'back') index = 0;
  else if (kind === 'forward') index = Math.min(count - top.length, Math.min(...indices) + 1);
  else index = Math.max(0, Math.min(...indices) - 1);
  const base = e.parentId ? { parentId: e.parentId } : { parentId: null, pageId: e.pageId };
  return [{ type: 'moveNodes', nodeIds: top, index, ...base }];
}

/* ------------------------------------------------------------------ */
/* comandos (leem os stores e aplicam)                                */
/* ------------------------------------------------------------------ */

let nudgeQueue: Promise<void> = Promise.resolve();

export const actions = {
  async deleteSelection(): Promise<void> {
    const { doc, selection } = state();
    if (!doc) return;
    const ops = buildDeleteOps(doc, selection);
    if (!ops.length) return;
    if (await daemon.applySafe(ops)) ui.select([]);
  },

  async duplicateSelection(): Promise<void> {
    const { doc, selection } = state();
    if (!doc) return;
    const top = topLevel(doc, selection);
    if (!top.length) return;
    const ack = await daemon.applySafe([{ type: 'duplicateNodes', nodeIds: top }]);
    const ids = ack?.results[0]?.nodeIds;
    if (Array.isArray(ids)) ui.select(ids as string[]);
  },

  async group(): Promise<void> {
    const { doc, selection } = state();
    if (!doc) return;
    const r = buildGroupOps(doc, selection);
    if (!r) return ui.toast('Selecione irmãos (mesmo pai) dentro de um frame para agrupar');
    if (await daemon.applySafe(r.ops)) ui.select([r.groupId]);
  },

  async ungroup(): Promise<void> {
    const { doc, selection } = state();
    if (!doc) return;
    const r = buildUngroupOps(doc, selection);
    if (!r) return;
    if (await daemon.applySafe(r.ops)) ui.select(r.childIds);
  },

  async reorder(kind: ReorderKind): Promise<void> {
    const { doc, selection } = state();
    if (!doc) return;
    await daemon.applySafe(buildReorderOps(doc, selection, kind));
  },

  /** Serializado: cada seta lê o documento depois do ack da anterior (senão perde movimentos). */
  nudge(dx: number, dy: number): Promise<void> {
    nudgeQueue = nudgeQueue.then(async () => {
      const { doc, selection } = state();
      if (!doc) return;
      await daemon.applySafe(buildNudgeOps(doc, selection, dx, dy));
    });
    return nudgeQueue;
  },

  async setHidden(ids: string[], hidden: boolean): Promise<void> {
    if (!ids.length) return;
    await daemon.applySafe([
      { type: 'setNodeFlags', changes: ids.map((nodeId) => ({ nodeId, hidden })) },
    ]);
  },

  async setLocked(ids: string[], locked: boolean): Promise<void> {
    if (!ids.length) return;
    await daemon.applySafe([
      { type: 'setNodeFlags', changes: ids.map((nodeId) => ({ nodeId, locked })) },
    ]);
  },

  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await daemon.applySafe([{ type: 'renameNodes', changes: [{ nodeId: id, name: trimmed }] }]);
  },

  /** Ctrl+A: irmãos da seleção atual, ou todos os frames da página. */
  selectAll(): void {
    const { doc, selection } = state();
    if (!doc) return;
    if (selection.length) {
      ui.select(
        getSiblings(doc, selection[0]!)
          .filter((n) => !n.hidden)
          .map((n) => n.id),
      );
      return;
    }
    const pageId = currentPageId();
    const page = doc.pages.find((p) => p.id === pageId);
    ui.select(page ? page.frames.filter((f) => !f.hidden).map((f) => f.id) : []);
  },

  /** Esc: sobe um nível (pai da seleção) ou limpa a seleção quando já está no frame raiz. */
  selectParent(): void {
    const { doc, selection } = state();
    if (!doc || !selection.length) return;
    const parent = getParent(doc, selection[0]!);
    ui.select(parent ? [parent.id] : []);
  },

  async undo(): Promise<void> {
    await daemon.undo().catch((e: unknown) => ui.toast(String((e as Error).message ?? e), 'error'));
  },

  async redo(): Promise<void> {
    await daemon.redo().catch((e: unknown) => ui.toast(String((e as Error).message ?? e), 'error'));
  },

  async save(): Promise<void> {
    try {
      const { path } = await daemon.save();
      ui.toast(`Salvo em ${path}`);
    } catch (e) {
      ui.toast((e as Error).message, 'error');
    }
  },
};
