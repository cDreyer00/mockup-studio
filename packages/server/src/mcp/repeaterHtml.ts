/**
 * Round trip of repeaters through the MCP HTML: `get_html` marks each repeater with
 * `data-mockup-repeat="<id>"` (and `data-repeat="<items>"`, informational only) and `write_html`
 * recognizes the mark and recreates the repeater with the original's data and source, instead of losing them.
 */
import { createRepeaterFrom, findNode, walk, type Document, type Node } from '@mockup/core';

export const REPEAT_MARK = 'data-mockup-repeat';
export const REPEAT_COUNT = 'data-repeat';

/** Copy of the tree with the mark on repeaters (for `nodesToHtml`). */
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
 * Replaces, in the nodes coming from the HTML, the marked elements with repeaters carrying the
 * original's data (looked up in `doc`). The mark is removed from the attributes even without an
 * original. Returns the original ids that were reused.
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

/** Repeaters inside the `deletedIds` nodes that were not recreated (to warn about the loss). */
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
