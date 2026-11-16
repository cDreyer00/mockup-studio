/** Lógica pura do painel de camadas: lista visível, intervalo de seleção e cálculo de drop. */
import type { Document, Node, Op, Page, StyleChange } from '@mockup/core';
import {
  LEAF_FRAME_PADDING,
  POSITION_STYLE_KEYS,
  isLeafNode,
  makeLeafFrame,
} from '../model/factory';
import { canHaveChildren, getEntry, getNode, isAncestor, pxValue, topLevel } from '../model/tree';

export interface FlatRow {
  id: string;
  node: Node;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

/** Linhas visíveis (pré-ordem) da página, omitindo os descendentes de nós recolhidos. */
export function flattenTree(page: Page, collapsed: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const visit = (node: Node, depth: number, parentId: string | null) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && !collapsed.has(node.id);
    out.push({ id: node.id, node, depth, parentId, hasChildren, expanded });
    if (expanded) for (const c of node.children) visit(c, depth + 1, node.id);
  };
  for (const f of page.frames) visit(f, 0, null);
  return out;
}

/** Ids entre `anchor` e `id` (inclusive) na ordem visível; sem âncora válida, só `[id]`. */
export function rangeBetween(
  visible: readonly string[],
  anchor: string | null,
  id: string,
): string[] {
  const a = anchor ? visible.indexOf(anchor) : -1;
  const b = visible.indexOf(id);
  if (b < 0) return [id];
  if (a < 0) return [id];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return visible.slice(from, to + 1);
}

/** Próximo nome livre "Página N". */
export function nextPageName(pages: readonly Page[]): string {
  const names = new Set(pages.map((p) => p.name));
  let n = pages.length + 1;
  while (names.has(`Página ${n}`)) n++;
  return `Página ${n}`;
}

export type DropZone = 'before' | 'after' | 'inside';
export type DropTarget = { id: string; zone: DropZone } | { rootOfPage: string; index?: number };

export type Measure = (id: string) => { x: number; y: number; w: number; h: number } | null;

/** Zona de drop a partir da posição vertical relativa (0..1) na linha. */
export function zoneFor(node: Node, fraction: number): DropZone {
  if (canHaveChildren(node)) {
    if (fraction < 0.25) return 'before';
    if (fraction > 0.75) return 'after';
    return 'inside';
  }
  return fraction < 0.5 ? 'before' : 'after';
}

/**
 * Ops para soltar `draggedIds` em `target`. `null` quando o drop é inválido (dentro de si mesmo ou
 * de descendente, destino que não aceita filhos, nada para mover).
 * O `index` do core é aplicado após remover os nós movidos; aqui ele é descontado.
 */
export function computeDropOps(
  doc: Document,
  draggedIds: readonly string[],
  target: DropTarget,
  measure?: Measure,
): Op[] | null {
  const dragged = topLevel(doc, draggedIds);
  if (!dragged.length) return null;

  let parentId: string | null;
  let pageId: string;
  let index: number;
  if ('rootOfPage' in target) {
    const page = doc.pages.find((p) => p.id === target.rootOfPage);
    if (!page) return null;
    parentId = null;
    pageId = page.id;
    index = target.index ?? page.frames.length;
  } else {
    const entry = getEntry(doc, target.id);
    if (!entry) return null;
    if (target.zone === 'inside') {
      if (!canHaveChildren(entry.node)) return null;
      parentId = entry.node.id;
      pageId = entry.pageId;
      index = entry.node.children.length;
    } else {
      parentId = entry.parentId;
      pageId = entry.pageId;
      index = entry.index + (target.zone === 'after' ? 1 : 0);
    }
  }

  if (parentId) {
    if (dragged.includes(parentId)) return null;
    if (dragged.some((d) => isAncestor(doc, d, parentId!))) return null;
    const p = getNode(doc, parentId);
    if (!p || !canHaveChildren(p)) return null;
  }

  // Desconta os movidos que estão antes do ponto de inserção no mesmo contêiner.
  let before = 0;
  for (const id of dragged) {
    const e = getEntry(doc, id)!;
    if (e.parentId === parentId && e.pageId === pageId && e.index < index) before++;
  }
  index -= before;

  const move: Op = parentId
    ? { type: 'moveNodes', nodeIds: dragged, parentId, index }
    : { type: 'moveNodes', nodeIds: dragged, parentId: null, pageId, index };
  const ops: Op[] = [move];

  if (parentId === null) {
    const pad = LEAF_FRAME_PADDING;
    const positions: { nodeId: string; position: { x: number; y: number } | null }[] = [];
    const styles: StyleChange[] = [];
    // Texto, imagem e SVG não viram frame sozinhos (como na colagem): ganham um frame em volta,
    // no mesmo lugar. O `moveNodes` acima os pôs contíguos em `index + k`; cada embrulho insere o
    // frame antes da folha e a move para dentro dele, sem mudar o índice das seguintes.
    const wraps: Op[] = [];
    dragged.forEach((id, k) => {
      const e = getEntry(doc, id)!;
      if (e.parentId === null) return;
      const rect = measure?.(id) ?? null;
      if (isLeafNode(e.node)) {
        const w = rect?.w ?? pxValue(e.node.style.width) ?? 200;
        const h = rect?.h ?? pxValue(e.node.style.height) ?? 40;
        const at = rect ? { x: rect.x, y: rect.y } : { x: pad, y: pad };
        const frame = makeLeafFrame(e.node, at.x - pad, at.y - pad, w, h);
        wraps.push(
          { type: 'createNode', parentId: null, pageId, index: index + k, node: frame },
          { type: 'moveNodes', nodeIds: [id], parentId: frame.id, index: 0 },
        );
        const unset = POSITION_STYLE_KEYS.filter((p) => e.node.style[p] !== undefined);
        if (unset.length) styles.push({ nodeId: id, unset });
        if (e.node.position) positions.push({ nodeId: id, position: null });
        return;
      }
      positions.push({
        nodeId: id,
        position: rect ? { x: Math.round(rect.x), y: Math.round(rect.y) } : { x: 0, y: 0 },
      });
      const set: Record<string, string> = {};
      if (rect) {
        if (pxValue(e.node.style.width) === undefined) set.width = `${Math.round(rect.w)}px`;
        if (pxValue(e.node.style.height) === undefined) set.height = `${Math.round(rect.h)}px`;
      }
      if (Object.keys(set).length) styles.push({ nodeId: id, set });
    });
    ops.push(...wraps);
    if (positions.length) ops.push({ type: 'setPosition', changes: positions });
    if (styles.length) ops.push({ type: 'updateStyles', changes: styles });
  } else {
    const roots = dragged.filter((id) => getEntry(doc, id)!.parentId === null);
    if (roots.length) {
      ops.push({
        type: 'setPosition',
        changes: roots.map((nodeId) => ({ nodeId, position: null })),
      });
    }
  }
  return ops;
}
