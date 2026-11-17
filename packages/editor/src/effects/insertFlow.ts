/** Inserção de efeitos no documento: resolve o alvo, aplica as ops num único apply e seleciona. */
import { getEffect, presetParams, resolveEffectParams } from '@mockup/core';
import { daemon } from '../client/daemon';
import { isLockedDeep } from '../model/tree';
import { currentPageId } from '../state/hooks';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { buildEffectInsertOps, resolveEffectTarget } from './insert';

/** Insere o efeito (`preset` opcional) como fundo do alvo ou, com `asLayer`, como camada filha. */
export async function insertEffect(
  kind: string,
  preset?: string,
  opts: { asLayer?: boolean } = {},
): Promise<string | null> {
  const doc = useDoc.getState().doc;
  if (!doc) {
    ui.toast('Nenhum documento aberto', 'error');
    return null;
  }
  const targetId = resolveEffectTarget(doc, useUi.getState().selection, currentPageId());
  if (!targetId) {
    ui.toast('Crie um frame antes de inserir um efeito.', 'error');
    return null;
  }
  if (isLockedDeep(doc, targetId)) {
    ui.toast('O destino está travado.', 'error');
    return null;
  }
  if (!getEffect(kind)) {
    ui.toast(`Efeito desconhecido: ${kind}`, 'error');
    return null;
  }
  const params = (preset ? presetParams(kind, preset) : undefined) ?? resolveEffectParams(kind);
  const plan = buildEffectInsertOps(doc, targetId, kind, params, opts);
  if (!plan) return null;
  const ack = await daemon.applySafe(plan.ops);
  if (!ack) {
    ui.toast('Não foi possível inserir o efeito.', 'error');
    return null;
  }
  ui.select([plan.nodeId]);
  return plan.nodeId;
}
