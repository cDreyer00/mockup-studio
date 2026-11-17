/**
 * `renameToken` in components: `var(--x)` references (and local declarations of the variable) in the
 * roots of main components, in variants and in instance overrides. Called by
 * `doRenameToken` (apply.ts), which handles the pages and the tokens.
 */
import { deepClone } from '../clone.js';
import { walk } from '../document.js';
import type { Op, UpdateComponentOp } from '../ops.js';
import { findVarRefs, renameTokenInClasses, replaceVarRefs } from '../tokens.js';
import type { ComponentDef, Document, Node, NodeOverride } from '../types.js';

interface Counter {
  refs: number;
}

function renameStyle(
  style: Record<string, string>,
  from: string,
  to: string,
  count: Counter,
): Record<string, string> | null {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(style)) {
    const key = k === from ? to : k;
    const value = replaceVarRefs(v, from, to);
    if (key !== k || value !== v) changed = true;
    if (value !== v) count.refs++;
    out[key] = value;
  }
  return changed ? out : null;
}

function renameStates(
  states: Record<string, Record<string, string>>,
  from: string,
  to: string,
  count: Counter,
): Record<string, Record<string, string>> | null {
  let changed = false;
  const out: Record<string, Record<string, string>> = {};
  for (const [k, st] of Object.entries(states)) {
    const r = renameStyle(st, from, to, count);
    if (r) changed = true;
    out[k] = r ?? st;
  }
  return changed ? out : null;
}

function renameAttrs(
  attrs: Record<string, string>,
  from: string,
  to: string,
  count: Counter,
): Record<string, string> | null {
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const value = replaceVarRefs(v, from, to);
    if (value !== v) {
      changed = true;
      count.refs++;
    }
    out[k] = value;
  }
  return changed ? out : null;
}

function renameSvg(svg: string, from: string, to: string, count: Counter): string | null {
  const next = replaceVarRefs(svg, from, to);
  if (next === svg) return null;
  count.refs += findVarRefs(svg).filter((r) => r.name === from).length;
  return next;
}

function renameClasses(classes: string, from: string, to: string, count: Counter): string | null {
  const r = renameTokenInClasses(classes, from, to);
  if (r.changed === 0) return null;
  count.refs += r.changed;
  return r.classes;
}

/** Renames in the override (mutating); `true` if it changed. */
function renameInOverride(ov: NodeOverride, from: string, to: string, count: Counter): boolean {
  let changed = false;
  if (ov.style) {
    const r = renameStyle(ov.style, from, to, count);
    if (r) [ov.style, changed] = [r, true];
  }
  if (ov.unsetStyle?.includes(from)) {
    ov.unsetStyle = ov.unsetStyle.map((k) => (k === from ? to : k));
    changed = true;
  }
  if (ov.states) {
    const r = renameStates(ov.states, from, to, count);
    if (r) [ov.states, changed] = [r, true];
  }
  if (ov.attrs) {
    const r = renameAttrs(ov.attrs, from, to, count);
    if (r) [ov.attrs, changed] = [r, true];
  }
  if (ov.svg) {
    const r = renameSvg(ov.svg, from, to, count);
    if (r !== null) [ov.svg, changed] = [r, true];
  }
  if (ov.classes) {
    const r = renameClasses(ov.classes, from, to, count);
    if (r !== null) [ov.classes, changed] = [r, true];
  }
  return changed;
}

function renameInOverrides(
  map: Record<string, NodeOverride>,
  from: string,
  to: string,
  count: Counter,
): boolean {
  let changed = false;
  for (const ov of Object.values(map)) if (renameInOverride(ov, from, to, count)) changed = true;
  return changed;
}

/** Renames on the node (mutating, without descending into children); `true` if it changed. */
function renameInNode(node: Node, from: string, to: string, count: Counter): boolean {
  let changed = false;
  const st = renameStyle(node.style, from, to, count);
  if (st) [node.style, changed] = [st, true];
  if (node.states) {
    const r = renameStates(node.states, from, to, count);
    if (r) [node.states, changed] = [r, true];
  }
  const attrs = renameAttrs(node.attrs, from, to, count);
  if (attrs) [node.attrs, changed] = [attrs, true];
  if (node.type === 'svg' && node.svg) {
    const r = renameSvg(node.svg, from, to, count);
    if (r !== null) [node.svg, changed] = [r, true];
  }
  if (node.classes) {
    const r = renameClasses(node.classes, from, to, count);
    if (r !== null) [node.classes, changed] = [r, true];
  }
  if (node.overrides && renameInOverrides(node.overrides, from, to, count)) changed = true;
  return changed;
}

/**
 * Applies the rename (mutating `d`) to the component roots/variants and to the overrides of
 * page instances. Returns the inverses (`updateComponent` with the previous root/variants,
 * `setInstanceOverrides` with the previous map), the ids of touched nodes and replaced references.
 */
export function renameTokenInComponents(
  d: Document,
  from: string,
  to: string,
): { inverse: Op[]; nodeIds: string[]; references: number } {
  const count: Counter = { refs: 0 };
  const inverse: Op[] = [];
  const nodeIds: string[] = [];
  if (d.components && d.components.length > 0) {
    let any = false;
    const next = d.components.map((c): ComponentDef => {
      const prevRoot = c.root;
      const prevVariants = c.variants;
      const root = deepClone(c.root);
      const variants = deepClone(c.variants);
      let changed = false as boolean;
      walk(root, (n) => {
        if (renameInNode(n, from, to, count)) {
          changed = true;
          nodeIds.push(n.id);
        }
      });
      let variantsChanged = false;
      for (const v of variants) {
        if (renameInOverrides(v.overrides, from, to, count)) variantsChanged = true;
      }
      if (!changed && !variantsChanged) return c;
      any = true;
      const inv: UpdateComponentOp = { type: 'updateComponent', componentId: c.id };
      if (changed) inv.root = prevRoot;
      if (variantsChanged) inv.variants = prevVariants;
      inverse.push(inv);
      return {
        ...c,
        root: changed ? root : prevRoot,
        variants: variantsChanged ? variants : prevVariants,
      };
    });
    if (any) d.components = next;
  }
  const overridesInv: { nodeId: string; overrides: Record<string, NodeOverride> }[] = [];
  for (const page of d.pages) {
    walk(page, (n) => {
      if (n.type !== 'instance' || !n.overrides) return;
      const prev = n.overrides;
      const nextMap = deepClone(prev);
      if (renameInOverrides(nextMap, from, to, count)) {
        overridesInv.push({ nodeId: n.id, overrides: prev });
        n.overrides = nextMap;
        nodeIds.push(n.id);
      }
    });
  }
  if (overridesInv.length > 0)
    inverse.push({ type: 'setInstanceOverrides', changes: overridesInv });
  return { inverse, nodeIds, references: count.refs };
}
