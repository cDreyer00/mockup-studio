/**
 * Ações de vetor: texto em contornos (rota do servidor), booleanas e achatar (builders do core).
 * Cada ação aplica as ops em UMA chamada `applySafe` (= uma entrada de undo) e seleciona o resultado.
 */
import { buildBooleanOps, buildFlattenOps, findNode, isFreeNode } from '@mockup/core';
import type { BooleanOp, Box, Document, Op } from '@mockup/core';
import { findNodeEl, getCanvasRoot, measureWorldRect } from '../canvas/dom';
import { daemon } from '../client/daemon';
import { getNode, isLockedDeep, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Seleção de topo sem nós travados. */
function selectedIds(doc: Document): string[] {
  return topLevel(doc, useUi.getState().selection).filter((id) => !isLockedDeep(doc, id));
}

/** Ids dos nós svg da seleção. */
export function selectedSvgIds(doc: Document | null, selection: readonly string[]): string[] {
  if (!doc) return [];
  return topLevel(doc, selection).filter((id) => getNode(doc, id)?.type === 'svg');
}

/** Converte os nós de texto selecionados em svg (contornos) e seleciona os nós novos. */
export async function textToOutlines(): Promise<void> {
  const { doc, activeDocId } = useDoc.getState();
  if (!doc || !activeDocId) return;
  const ids = selectedIds(doc).filter((id) => getNode(doc, id)?.type === 'text');
  if (ids.length === 0) {
    ui.toast('Selecione um texto para converter em contornos', 'info');
    return;
  }
  try {
    const res = await fetch(`/api/docs/${encodeURIComponent(activeDocId)}/text-to-outlines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeIds: ids }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      nodeIds?: string[];
      notes?: string[];
      error?: string;
    };
    if (!res.ok || !body.nodeIds) {
      ui.toast(body.error ?? `Falha ao converter em contornos (${res.status})`, 'error');
      return;
    }
    ui.select(body.nodeIds);
    if (body.notes && body.notes.length > 0) ui.toast(body.notes.join(' '), 'info');
  } catch (e) {
    ui.toast(errorText(e), 'error');
  }
}

/**
 * Caixas medidas no DOM dos nós em fluxo (não raiz e sem position absolute/fixed), em px do mundo,
 * relativas ao padding box do pai (retângulo do filho − do pai − borda do pai). Os livres seguem
 * o estilo e ficam de fora; sem canvas ou elemento, o core recusa o nó com mensagem clara.
 */
export function measureFlowBoxes(doc: Document, ids: readonly string[]): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  const root = getCanvasRoot();
  if (!root) return boxes;
  for (const id of ids) {
    const found = findNode(doc, id);
    if (!found?.parent || isFreeNode(found.node, false)) continue;
    const rect = measureWorldRect(root, id);
    const parentRect = measureWorldRect(root, found.parent.id);
    const parentEl = findNodeEl(root, found.parent.id);
    if (!rect || !parentRect) continue;
    boxes[id] = {
      x: rect.x - parentRect.x - (parentEl?.clientLeft ?? 0),
      y: rect.y - parentRect.y - (parentEl?.clientTop ?? 0),
      width: rect.w,
      height: rect.h,
    };
  }
  return boxes;
}

async function applyBuilt(
  build: (
    doc: Document,
    ids: string[],
    boxes: Record<string, Box>,
  ) => { ops: Op[]; nodeId: string },
  minNodes: number,
  hint: string,
): Promise<void> {
  const doc = useDoc.getState().doc;
  if (!doc) return;
  const ids = selectedSvgIds(doc, selectedIds(doc));
  if (ids.length < minNodes) {
    ui.toast(hint, 'info');
    return;
  }
  try {
    const { ops, nodeId } = build(doc, ids, measureFlowBoxes(doc, ids));
    const ack = await daemon.applySafe(ops);
    if (ack) ui.select([nodeId]);
  } catch (e) {
    ui.toast(errorText(e), 'error');
  }
}

/** União, subtração, interseção ou exclusão entre os svg selecionados (2 ou mais). */
export function booleanOp(op: BooleanOp): Promise<void> {
  return applyBuilt(
    (doc, ids, boxes) => buildBooleanOps(doc, ids, op, { boxes }),
    2,
    'Selecione 2 ou mais vetores para combinar',
  );
}

/** Achatar: junta os paths do svg selecionado, ou dos vários svg selecionados, num só nó. */
export function flatten(): Promise<void> {
  return applyBuilt(
    (doc, ids, boxes) => buildFlattenOps(doc, ids, { boxes }),
    1,
    'Selecione um vetor para achatar',
  );
}
