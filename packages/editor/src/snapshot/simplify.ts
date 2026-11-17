/** "Simplify import": applies the `planCleanup` plan in a single history entry. */
import { planCleanup } from '@mockup/snapshot-core';
import { daemon } from '../client/daemon';
import { canHaveChildren, getNode } from '../model/tree';
import { useDoc } from '../state/docStore';
import { ui } from '../state/uiStore';

/** Can the node be simplified (does it have children)? */
export function canSimplify(nodeId: string | undefined): boolean {
  const doc = useDoc.getState().doc;
  const node = doc && nodeId ? getNode(doc, nodeId) : undefined;
  return !!node && canHaveChildren(node) && node.children.length > 0;
}

export function cleanupSummary(p: { removed: number; unwrapped: number; fluid: number }): string {
  if (!p.removed && !p.unwrapped && !p.fluid) return 'Nothing to simplify';
  return `Simplified: ${p.removed} wrappers removed, ${p.unwrapped} unwrapped, ${p.fluid} fluid sizes`;
}

/** Runs the cleanup on the node. Errors (including from `planCleanup`) become a toast. */
export async function simplifyImport(nodeId: string): Promise<void> {
  const doc = useDoc.getState().doc;
  if (!doc) return;
  try {
    const plan = planCleanup(doc, nodeId);
    if (plan.ops.length > 0) await daemon.apply(plan.ops);
    ui.toast(cleanupSummary(plan));
  } catch (e) {
    ui.toast(`Could not simplify: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
}
