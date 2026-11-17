/** Montagem pura das ops que inserem um efeito (como fundo ou como camada). Sem DOM nem daemon. */
import { EFFECT_BACKGROUND_STYLE, createEffectNode, getEffect } from '@mockup/core';
import type { Document, MediaParamValue, Node, Op } from '@mockup/core';
import { getFrameOf, getNode } from '../model/tree';

export interface EffectInsertOptions {
  /** Camada filha comum (100% x 240px, no fluxo) em vez de fundo do pai. */
  asLayer?: boolean;
}

export interface EffectInsertPlan {
  ops: Op[];
  /** Id do nó effect criado. */
  nodeId: string;
  /** Pai que recebe o efeito. */
  parentId: string;
}

/** Estilo de uma camada de efeito comum. */
export const EFFECT_LAYER_STYLE: Readonly<Record<string, string>> = {
  width: '100%',
  height: '240px',
  display: 'block',
};

/**
 * Pai do efeito: o primeiro selecionado se for frame/elemento; senão o frame dele; sem seleção,
 * o primeiro frame da página `pageId` (ou da primeira página).
 */
export function resolveEffectTarget(
  doc: Document,
  selection: readonly string[],
  pageId: string | null,
): string | null {
  for (const id of selection) {
    const node = getNode(doc, id);
    if (!node) continue;
    if (node.type === 'frame' || node.type === 'element') return node.id;
    const frame = getFrameOf(doc, id);
    if (frame) return frame.id;
  }
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  return page?.frames[0]?.id ?? null;
}

/**
 * Ops para inserir um efeito em `targetId`: um `createNode` (índice 0 no fundo) e, quando faltarem,
 * `position: relative` e `isolation: isolate` no pai, tudo no mesmo apply. `null` se o alvo não existe.
 */
export function buildEffectInsertOps(
  doc: Document,
  targetId: string,
  kind: string,
  params: Record<string, MediaParamValue>,
  opts: EffectInsertOptions = {},
): EffectInsertPlan | null {
  const parent = getNode(doc, targetId);
  if (!parent) return null;
  const name = getEffect(kind)?.label ?? 'Efeito';
  const styles = opts.asLayer ? EFFECT_LAYER_STYLE : EFFECT_BACKGROUND_STYLE;
  const node: Node = createEffectNode(kind, params, { name, styles: { ...styles } });
  const ops: Op[] = [];
  if (!opts.asLayer) {
    const set: Record<string, string> = {};
    const pos = parent.style.position;
    if (!pos || pos === 'static') set.position = 'relative';
    if (parent.style.isolation !== 'isolate') set.isolation = 'isolate';
    if (Object.keys(set).length)
      ops.push({ type: 'updateStyles', changes: [{ nodeId: targetId, set }] });
  }
  ops.push({
    type: 'createNode',
    parentId: targetId,
    node,
    ...(opts.asLayer ? {} : { index: 0 }),
  });
  return { ops, nodeId: node.id, parentId: targetId };
}
