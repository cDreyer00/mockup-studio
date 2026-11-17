/** Neutral style operations (no components): lock context, common-value reading and op application. */
import { createContext } from 'react';
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { ui } from '../state/uiStore';

export const LockedContext = createContext(false);

/* ------------------------------ value reading ------------------------------ */

/**
 * Common value: the value, if all are equal (`undefined` if none has a value); `null` if mixed.
 */
export function common<T>(
  items: readonly T[],
  get: (item: T) => string | undefined,
): string | undefined | null {
  if (items.length === 0) return undefined;
  const first = get(items[0]!);
  for (let i = 1; i < items.length; i++) if (get(items[i]!) !== first) return null;
  return first;
}

export const styleOf = (prop: string) => (n: Node) => n.style[prop];

/* ------------------------------ op application ------------------------------ */

export type StyleDelta = { set?: Record<string, string>; unset?: string[] };

/** Applies ops in a single call and discards the preview after the ack. */
export async function runOps(ops: Op[]): Promise<void> {
  if (ops.length) await daemon.applySafe(ops);
  ui.clearPreview();
}

/** Applies styles to all nodes; `fn` can return different deltas per node. */
export function commitStyles(
  nodes: readonly Node[],
  fn: (node: Node) => StyleDelta | null,
): Promise<void> {
  const changes: { nodeId: string; set?: Record<string, string>; unset?: string[] }[] = [];
  for (const node of nodes) {
    const d = fn(node);
    if (!d) continue;
    const set = d.set && Object.keys(d.set).length ? d.set : undefined;
    const unset = d.unset?.length ? d.unset : undefined;
    if (!set && !unset) continue;
    changes.push({ nodeId: node.id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) });
  }
  return runOps(changes.length ? [{ type: 'updateStyles', changes }] : []);
}

/** Sets (or removes, if empty) a property on all nodes. */
export function commitStyle(nodes: readonly Node[], prop: string, value: string): Promise<void> {
  const v = value.trim();
  return commitStyles(nodes, () => (v === '' ? { unset: [prop] } : { set: { [prop]: v } }));
}

/** Transient style preview per node. */
export function previewStyles(
  nodes: readonly Node[],
  fn: (node: Node) => Record<string, string>,
): void {
  ui.setPreview(Object.fromEntries(nodes.map((n) => [n.id, { style: fn(n) }])));
}
