/** "Simplificar importação": aplica o plano de `planCleanup` numa única entrada de histórico. */
import { planCleanup } from '@mockup/snapshot-core';
import { daemon } from '../client/daemon';
import { canHaveChildren, getNode } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';

/** O nó pode ser simplificado (tem filhos)? */
export function canSimplify(nodeId: string | undefined): boolean {
  const doc = useDoc.getState().doc;
  const node = doc && nodeId ? getNode(doc, nodeId) : undefined;
  return !!node && canHaveChildren(node) && node.children.length > 0;
}

export function cleanupSummary(p: { removed: number; unwrapped: number; fluid: number }): string {
  if (!p.removed && !p.unwrapped && !p.fluid) return 'Nada a simplificar';
  return `Simplificado: ${p.removed} wrappers removidos, ${p.unwrapped} desembrulhados, ${p.fluid} tamanhos fluidos`;
}

/** Roda a limpeza no nó. Erros (inclusive do `planCleanup`) viram toast. */
export async function simplifyImport(nodeId: string): Promise<void> {
  const doc = useDoc.getState().doc;
  if (!doc) return;
  try {
    const plan = planCleanup(doc, nodeId);
    if (plan.ops.length > 0) await daemon.apply(plan.ops);
    ui.toast(cleanupSummary(plan));
  } catch (e) {
    ui.toast(
      `Não foi possível simplificar: ${e instanceof Error ? e.message : String(e)}`,
      'error',
    );
  }
}
