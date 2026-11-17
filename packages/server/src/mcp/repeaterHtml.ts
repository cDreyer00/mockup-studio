/**
 * Ida e volta de repetidores pelo HTML do MCP: `get_html` marca cada repetidor com
 * `data-mockup-repeat="<id>"` (e `data-repeat="<itens>"`, só informativo) e `write_html` reconhece a
 * marca e recria o repetidor com os dados e a origem do original, em vez de perdê-los.
 */
import { createRepeaterFrom, findNode, walk, type Document, type Node } from '@mockup/core';

export const REPEAT_MARK = 'data-mockup-repeat';
export const REPEAT_COUNT = 'data-repeat';

/** Cópia da árvore com a marca nos repetidores (para `nodesToHtml`). */
export function markRepeaters(node: Node): Node {
  const out: Node = {
    ...node,
    attrs: { ...node.attrs },
    children: node.children.map(markRepeaters),
  };
  if (node.type === 'repeater') {
    out.attrs[REPEAT_MARK] = node.id;
    out.attrs[REPEAT_COUNT] = String(Array.isArray(node.data) ? node.data.length : 0);
  }
  return out;
}

/**
 * Troca, nos nós vindos do HTML, os elementos com a marca por repetidores com os dados do original
 * (procurado em `doc`). A marca sai dos atributos mesmo sem original. Devolve os ids originais
 * reaproveitados.
 */
export function restoreRepeaters(
  nodes: Node[],
  doc: Document,
): { nodes: Node[]; restored: string[] } {
  const restored: string[] = [];
  const visit = (n: Node): Node => {
    const children = n.children.map(visit);
    const mark = n.attrs[REPEAT_MARK];
    if (mark === undefined && !(REPEAT_COUNT in n.attrs)) return { ...n, children };
    const attrs = { ...n.attrs };
    delete attrs[REPEAT_MARK];
    delete attrs[REPEAT_COUNT];
    const plain: Node = { ...n, attrs, children };
    const orig = mark ? findNode(doc, mark)?.node : undefined;
    if (!orig || orig.type !== 'repeater') return plain;
    restored.push(orig.id);
    return createRepeaterFrom(
      plain,
      structuredClone(Array.isArray(orig.data) ? orig.data : []),
      orig.dataSource ? structuredClone(orig.dataSource) : undefined,
    );
  };
  return { nodes: nodes.map(visit), restored };
}

/** Repetidores dentro dos nós `deletedIds` que não foram recriados (para avisar da perda). */
export function lostRepeaters(
  doc: Document,
  deletedIds: string[],
  restored: Iterable<string>,
): { id: string; count: number }[] {
  const keep = new Set(restored);
  const out: { id: string; count: number }[] = [];
  for (const id of deletedIds) {
    const n = findNode(doc, id)?.node;
    if (!n) continue;
    walk(n, (c) => {
      if (c.type === 'repeater' && !keep.has(c.id)) {
        out.push({ id: c.id, count: Array.isArray(c.data) ? c.data.length : 0 });
      }
    });
  }
  return out;
}
