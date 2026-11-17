/** Operações de estilo neutras (sem componentes): contexto de trava, leitura de valor comum e aplicação de ops. */
import { createContext } from 'react';
import type { Node, Op } from '@mockup/core';
import { daemon } from '../client/daemon';
import { ui } from '../state/uiStore';

export const LockedContext = createContext(false);

/* ------------------------------ leitura de valores ------------------------------ */

/**
 * Valor comum: o valor, se todos iguais (`undefined` se todos sem valor); `null` se misto.
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

/* ------------------------------ aplicação de ops ------------------------------ */

export type StyleDelta = { set?: Record<string, string>; unset?: string[] };

/** Aplica ops numa única chamada e descarta a prévia depois do ack. */
export async function runOps(ops: Op[]): Promise<void> {
  if (ops.length) await daemon.applySafe(ops);
  ui.clearPreview();
}

/** Aplica estilos a todos os nós; `fn` pode devolver deltas distintos por nó. */
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

/** Define (ou remove, se vazio) uma propriedade em todos os nós. */
export function commitStyle(nodes: readonly Node[], prop: string, value: string): Promise<void> {
  const v = value.trim();
  return commitStyles(nodes, () => (v === '' ? { unset: [prop] } : { set: { [prop]: v } }));
}

/** Prévia transitória de estilos por nó. */
export function previewStyles(
  nodes: readonly Node[],
  fn: (node: Node) => Record<string, string>,
): void {
  ui.setPreview(Object.fromEntries(nodes.map((n) => [n.id, { style: fn(n) }])));
}
