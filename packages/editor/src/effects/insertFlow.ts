/** Effect insertion into the document: resolves the target, applies the ops in a single apply and selects. */
import { getEffect, presetParams, resolveEffectParams } from '@mockup/core';
import { daemon } from '../client/daemon';
import { isLockedDeep } from '../model/tree';
import { currentPageId } from '../state/hooks';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { buildEffectInsertOps, resolveEffectTarget } from './insert';

/** Inserts the effect (optional `preset`) as the target background or, with `asLayer`, as a child layer. */
export async function insertEffect(
  kind: string,
  preset?: string,
  opts: { asLayer?: boolean } = {},
): Promise<string | null> {
  const doc = useDoc.getState().doc;
  if (!doc) {
    ui.toast('No document open', 'error');
    return null;
  }
  const targetId = resolveEffectTarget(doc, useUi.getState().selection, currentPageId());
  if (!targetId) {
    ui.toast('Create a frame before inserting an effect.', 'error');
    return null;
  }
  if (isLockedDeep(doc, targetId)) {
    ui.toast('The target is locked.', 'error');
    return null;
  }
  if (!getEffect(kind)) {
    ui.toast(`Unknown effect: ${kind}`, 'error');
    return null;
  }
  const params = (preset ? presetParams(kind, preset) : undefined) ?? resolveEffectParams(kind);
  const plan = buildEffectInsertOps(doc, targetId, kind, params, opts);
  if (!plan) return null;
  const ack = await daemon.applySafe(plan.ops);
  if (!ack) {
    ui.toast('Could not insert the effect.', 'error');
    return null;
  }
  ui.select([plan.nodeId]);
  return plan.nodeId;
}
