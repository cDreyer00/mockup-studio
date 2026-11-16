/**
 * Onde um nó novo (retângulo, texto, imagem) entra: contêiner mais profundo sob o ponteiro e a
 * forma de posicioná-lo (fluxo flex ou absoluto relativo ao pai), mais as ops de criação.
 */
import type { Document, Node, Op } from '@mockup/core';
import {
  canHaveChildren,
  flexDirection,
  getNode,
  isFlex,
  isHiddenDeep,
  isLockedDeep,
} from '../model/tree';
import { clientToWorld, findNodeEl, getCanvasRoot, measureWorldRect, worldToClient } from './dom';
import { resolveFlowInsert } from './geometry';
import type { Axis, Point, SiblingRect } from './geometry';

export interface Placement {
  /** Pai do novo nó; `null` = não há contêiner (vira frame raiz). */
  parentId: string | null;
  /** Entra no fluxo do pai (flex), sem `position`. */
  flow: boolean;
  /** Índice de inserção quando `flow`. */
  index?: number;
  /** Posição relativa ao pai (quando não é fluxo) ou, sem pai, posição no mundo. */
  x: number;
  y: number;
  /** O pai é estático: incluir `position: relative` no mesmo apply. */
  parentNeedsRelative: boolean;
}

/** Contêiner mais profundo sob o ponto da janela que aceita filhos e não está travado/oculto. */
export function findContainerAt(
  root: HTMLElement,
  doc: Document,
  clientX: number,
  clientY: number,
): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!root.contains(el)) continue;
    const id = el.closest('[data-node-id]')?.getAttribute('data-node-id');
    const node = id ? getNode(doc, id) : undefined;
    if (!id || !node) continue;
    if (canHaveChildren(node) && !isLockedDeep(doc, id) && !isHiddenDeep(doc, id)) return id;
  }
  return null;
}

/** Eixo de empilhamento dos filhos em fluxo: flex usa `flex-direction`; block é vertical. */
export function flowAxis(parent: Node): Axis {
  return isFlex(parent) ? flexDirection(parent) : 'column';
}

/** Retângulos (mundo) dos filhos renderizados do pai, com o índice real em `children`. */
export function siblingWorldRects(root: HTMLElement, parent: Node): SiblingRect[] {
  const out: SiblingRect[] = [];
  parent.children.forEach((c, index) => {
    const rect = c.hidden ? null : measureWorldRect(root, c.id);
    if (rect) out.push({ index, rect });
  });
  return out;
}

/**
 * Decide o pai e a posição para um nó criado em `at` (mundo). `client` é o ponto da janela
 * usado para achar o contêiner (padrão: derivado de `at`).
 */
export function planPlacement(doc: Document, at: Point, client?: Point): Placement {
  const root = getCanvasRoot();
  const none: Placement = {
    parentId: null,
    flow: false,
    x: at.x,
    y: at.y,
    parentNeedsRelative: false,
  };
  if (!root) return none;
  const c = client ?? worldToClient(root, at);
  const parentId = findContainerAt(root, doc, c.x, c.y);
  const parent = parentId ? getNode(doc, parentId) : undefined;
  if (!parentId || !parent) return none;
  const pointer = client ? clientToWorld(root, client.x, client.y) : at;
  if (isFlex(parent)) {
    const { moveIndex } = resolveFlowInsert(
      siblingWorldRects(root, parent),
      pointer,
      flowAxis(parent),
    );
    return { parentId, flow: true, index: moveIndex, x: 0, y: 0, parentNeedsRelative: false };
  }
  // Origem do filho absoluto = borda de preenchimento do pai (pai posicionado ou virando relative).
  const rect = measureWorldRect(root, parentId);
  const el = findNodeEl(root, parentId);
  const ox = (rect?.x ?? 0) + (el?.clientLeft ?? 0);
  const oy = (rect?.y ?? 0) + (el?.clientTop ?? 0);
  const pos = parent.style.position;
  return {
    parentId,
    flow: false,
    x: Math.round(at.x - ox),
    y: Math.round(at.y - oy),
    parentNeedsRelative: !pos || pos === 'static',
  };
}

/** Ops de criação: `node` é um frame raiz quando `placement.parentId` é nulo. */
export function buildCreateOps(pageId: string, placement: Placement, node: Node): Op[] {
  if (!placement.parentId) return [{ type: 'createNode', pageId, node }];
  const ops: Op[] = [];
  if (placement.parentNeedsRelative) {
    ops.push({
      type: 'updateStyles',
      changes: [{ nodeId: placement.parentId, set: { position: 'relative' } }],
    });
  }
  ops.push({
    type: 'createNode',
    parentId: placement.parentId,
    node,
    ...(placement.flow && placement.index !== undefined ? { index: placement.index } : {}),
  });
  return ops;
}
