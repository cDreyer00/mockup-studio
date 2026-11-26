/**
 * Primitive component ops (see `docs/COMPONENTS.md`, Ops section) and the validations shared
 * with `apply.ts` (document-wide unique ids, instance children).
 *
 * Handlers receive the mutable clone of the document (like those in `apply.ts`) and return the
 * exact inverse. Every change to `doc.components` swaps the array for a new one: the indexes in
 * `expand.ts` are cached by array identity.
 */
import type { z } from 'zod';
import { deepClone } from '../clone.js';
import { collectIds, findNode, walk } from '../document.js';
import type {
  AddComponentOp,
  DeleteComponentOp,
  Op,
  ReplaceNodeOp,
  SetInstanceOverridesOp,
  SetInstancePropsOp,
  UpdateComponentOp,
} from '../ops.js';
import { effectKinds, getEffect } from '../effects/catalog.js';
import { EffectSpecSchema, EmbedSpecSchema, VideoSpecSchema } from '../media.js';
import {
  DataSchema,
  DataSourceSchema,
  EMPTY_VARIANT_MESSAGE,
  hasVariantCondition,
} from '../schema.js';
import { normalizeAnimations, normalizeTransition } from '../motion/normalize.js';
import { VectorSchema } from '../vector/schema.js';
import { normalizeStateKey } from '../states.js';
import { isValidCssPropertyName, normalizeStyles, toKebabCase } from '../styles.js';
import { sanitizeSvg } from '../svg.js';
import { attrNameProblem } from '../tags.js';
import type { ComponentDef, Document, Node, NodeOverride, PropValue } from '../types.js';
import {
  SLOT_ATTR,
  componentNodeIds,
  findComponentCycle,
  getComponent,
  listInstances,
} from './expand.js';

export interface ComponentApplied {
  inverse: Op[];
  result?: Record<string, unknown>;
}

function fail(message: string): never {
  throw new Error(message);
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || index === null) return length;
  if (!Number.isFinite(index)) fail(`Invalid index: ${String(index)}`);
  return Math.max(0, Math.min(length, Math.floor(index)));
}

/* ---------------- shared validations ---------------- */

/** Ids of all nodes in the document: pages and component roots (optionally excluding one). */
export function documentNodeIds(doc: Document, exceptComponentId?: string): Set<string> {
  return new Set([...collectIds(doc), ...componentNodeIds(doc, exceptComponentId)]);
}

/**
 * Ensures the subtree ids are unique among themselves and across the whole document (pages and
 * component roots). `ignore`: ids that leave the document in the same op (e.g. the subtree
 * swapped by `replaceNode`).
 */
export function assertFreshNodeIds(
  doc: Document,
  nodes: Node[],
  opts: { exceptComponentId?: string; ignore?: Set<string> } = {},
): void {
  const existing = documentNodeIds(doc, opts.exceptComponentId);
  const seen = new Set<string>();
  for (const root of nodes) {
    walk(root, (n) => {
      if (existing.has(n.id) && !opts.ignore?.has(n.id))
        fail(`A node with id "${n.id}" already exists`);
      if (seen.has(n.id)) fail(`Duplicate id "${n.id}" in the subtree`);
      seen.add(n.id);
    });
  }
}

/** Names of the component's `slot` props. */
export function slotNames(def: ComponentDef): string[] {
  return def.props.filter((p) => p.type === 'slot').map((p) => p.name);
}

/**
 * An instance only accepts slot containers as children: an `element` whose `data-slot` equals a
 * `slot` prop of the component, one per slot. `incoming`: nodes about to enter (those already
 * children of the instance, in a reorder, do not count as repeats); `replacing`: the child being
 * replaced.
 */
export function assertInstanceChildren(
  doc: Document,
  inst: Node,
  incoming: Node[],
  replacing?: Node,
): void {
  const def = getComponent(doc, inst.componentId);
  const slots = def ? slotNames(def) : undefined;
  const entering = new Set(incoming);
  const used = new Set<string>();
  for (const c of inst.children) {
    if (entering.has(c) || c === replacing) continue;
    const s = c.attrs?.[SLOT_ATTR];
    if (s) used.add(s);
  }
  for (const n of incoming) {
    const s = n.type === 'element' ? n.attrs?.[SLOT_ATTR] : undefined;
    if (!s || (slots && !slots.includes(s))) {
      const list =
        slots && slots.length > 0 ? ` (${slots.join(', ')})` : ' (the component has no slots)';
      fail(
        `Instance "${inst.id}" only accepts slot containers as children${list}: insert inside a slot`,
      );
    }
    if (used.has(s)) fail(`Instance "${inst.id}" already has a container for slot "${s}"`);
    used.add(s);
  }
}

/**
 * Component rules for nodes inserted into `parent` (createNode, moveNodes): an instance parent
 * only receives slot containers, and instances inside the inserted subtrees also only have slot
 * containers as children.
 */
export function assertComponentInsertion(
  doc: Document,
  parent: Node | null,
  incoming: Node[],
): void {
  if (parent?.type === 'instance') assertInstanceChildren(doc, parent, incoming);
  for (const root of incoming) {
    walk(root, (n) => {
      if (n.type === 'instance' && n.children.length > 0) {
        assertInstanceChildren(doc, n, n.children);
      }
    });
  }
}

/** Validates `animations`/`slideTransition` of a node entering the document (throws on invalid input). */
export function normalizeNodeMotion(node: Node): void {
  if (node.animations !== undefined) {
    const list = normalizeAnimations(node.animations, `animations of "${node.id}"`);
    if (list) node.animations = list;
    else delete node.animations;
  }
  if (node.slideTransition !== undefined)
    node.slideTransition = normalizeTransition(node.slideTransition, `transition of "${node.id}"`);
}

function normalizeTree(node: Node): Node {
  node.attrs = { ...(node.attrs ?? {}) };
  node.style = normalizeStyles(node.style ?? {});
  normalizeNodeMotion(node);
  node.children = node.children ?? [];
  node.locked = node.locked ?? false;
  node.hidden = node.hidden ?? false;
  node.children.forEach(normalizeTree);
  return node;
}

function assertRootShape(root: Node): void {
  if (root.type === 'frame') fail('The component root cannot be a frame');
  if (root.type === 'instance') fail('The component root cannot be an instance');
}

/** Rejects a variant with no condition (an empty `when` would always match and the React export drops it). */
function assertVariants(c: ComponentDef): void {
  c.variants.forEach((v, i) => {
    if (!hasVariantCondition(v)) {
      fail(`Component "${c.name}", variant ${i + 1}: ${EMPTY_VARIANT_MESSAGE}`);
    }
  });
}

function assertUniqueName(list: ComponentDef[], name: string, selfId?: string): void {
  const key = name.trim().toLowerCase();
  if (!key) fail('Component has no name');
  const other = list.find((c) => c.id !== selfId && c.name.trim().toLowerCase() === key);
  if (other) fail(`A component named "${other.name}" already exists (${other.id})`);
}

function assertNoCycle(doc: Document, componentId: string): void {
  const cycle = findComponentCycle(doc, componentId);
  if (!cycle) return;
  const names = cycle.map((id) => getComponent(doc, id)?.name ?? id);
  fail(`Component cycle: ${names.join(' → ')} (a component cannot contain itself)`);
}

function requireComponentIndex(doc: Document, componentId: string): number {
  const i = (doc.components ?? []).findIndex((c) => c.id === componentId);
  if (i < 0) fail(`Component "${componentId}" not found`);
  return i;
}

/** Page instance node (those in main components are routed by `route.ts`). */
function requireInstance(doc: Document, nodeId: string): Node {
  const path = findNode(doc, nodeId);
  if (!path) fail(`Node "${nodeId}" not found`);
  if (path.node.type !== 'instance') fail(`Node "${nodeId}" is not a component instance`);
  return path.node;
}

/* ---------------- props and overrides ---------------- */

/** Validates/converts a prop value by the type declared on the component. */
export function normalizePropValue(def: ComponentDef, name: string, value: PropValue): PropValue {
  const p = def.props.find((x) => x.name === name);
  if (!p) {
    const names = def.props.filter((x) => x.type !== 'slot').map((x) => x.name);
    fail(
      `Component "${def.name}" has no prop "${name}"${names.length > 0 ? ` (props: ${names.join(', ')})` : ''}`,
    );
  }
  switch (p.type) {
    case 'slot':
      return fail(
        `"${name}" is a slot: its content goes in the instance's data-slot="${name}" container`,
      );
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (String(value).trim() === '' || !Number.isFinite(n)) {
        fail(`Prop "${name}" is numeric (received ${JSON.stringify(value)})`);
      }
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return fail(`Prop "${name}" is boolean (received ${JSON.stringify(value)})`);
    case 'enum': {
      const s = String(value);
      if (p.options && p.options.length > 0 && !p.options.includes(s)) {
        fail(
          `Invalid value for "${name}": ${JSON.stringify(s)} (options: ${p.options.join(', ')})`,
        );
      }
      return s;
    }
    default:
      return String(value);
  }
}

/** Override path: `''` (root) or ids separated by `/`, with no empty segments. */
export function assertOverridePath(path: string): void {
  if (path === '') return;
  if (path.split('/').some((s) => s.trim() === '')) fail(`Invalid override path: "${path}"`);
}

function normalizeStatesStrict(
  states: Record<string, Record<string, string>>,
  where: string,
): Record<string, Record<string, string>> {
  const next: Record<string, Record<string, string>> = {};
  for (const [rawKey, styles] of Object.entries(states)) {
    const key = normalizeStateKey(rawKey);
    if (!key) fail(`Invalid state "${rawKey}" in ${where}`);
    const clean = normalizeStyles(styles);
    if (Object.keys(clean).length > 0) next[key] = { ...(next[key] ?? {}), ...clean };
  }
  return next;
}

/** Normalizes an override (strict: throws on an unsafe value); empty fields are dropped. */
export function normalizeOverride(ov: NodeOverride, where = 'override'): NodeOverride {
  const out: NodeOverride = {};
  if (ov.style) {
    const st = normalizeStyles(ov.style);
    if (Object.keys(st).length > 0) out.style = st;
  }
  if (ov.unsetStyle) {
    const u = unique(
      ov.unsetStyle.map((k) => {
        const key = toKebabCase(k.trim());
        if (!isValidCssPropertyName(key)) fail(`Invalid CSS property name: "${k}"`);
        return key;
      }),
    );
    if (u.length > 0) out.unsetStyle = u;
  }
  if (ov.text !== undefined) out.text = ov.text;
  if (ov.attrs) {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(ov.attrs)) {
      const key = k.trim();
      if (key === 'style' || key === 'class')
        fail(`The "${key}" attribute is not allowed in attrs`);
      const problem = attrNameProblem(key);
      if (problem) fail(problem);
      attrs[key] = String(v);
    }
    if (Object.keys(attrs).length > 0) out.attrs = attrs;
  }
  if (ov.hidden !== undefined) out.hidden = ov.hidden;
  if (ov.classes !== undefined) {
    const c = ov.classes.trim().replace(/\s+/g, ' ');
    if (/[<{};"`]/.test(c)) fail(`Invalid classes in ${where}: ${c}`);
    if (c) out.classes = c;
  }
  if (ov.states) {
    const st = normalizeStatesStrict(ov.states, where);
    if (Object.keys(st).length > 0) out.states = st;
  }
  // `[]` is kept: "this instance has no animations".
  if (ov.animations !== undefined)
    out.animations = normalizeAnimations(ov.animations, `animations in ${where}`) ?? [];
  if (ov.src !== undefined) out.src = ov.src;
  if (ov.svg !== undefined) {
    const svg = sanitizeSvg(ov.svg);
    if (!svg) fail(`The svg in ${where} does not contain a valid <svg>`);
    out.svg = svg;
  }
  if (ov.props && Object.keys(ov.props).length > 0) out.props = { ...ov.props };
  if (ov.vector !== undefined) out.vector = strict(VectorSchema, ov.vector, 'vector', where);
  if (ov.effect !== undefined) {
    const effect = strict(EffectSpecSchema, ov.effect, 'effect', where);
    if (!getEffect(effect.kind)) {
      const kinds = effectKinds();
      fail(
        `Unknown effect "${effect.kind}" in ${where}. Valid: ${kinds.slice(0, 8).join(', ')}${kinds.length > 8 ? '… (see list_effects)' : ''}`,
      );
    }
    out.effect = effect;
  }
  if (ov.video !== undefined) out.video = strict(VideoSpecSchema, ov.video, 'video', where);
  if (ov.embed !== undefined) out.embed = strict(EmbedSpecSchema, ov.embed, 'embed', where);
  if (ov.data !== undefined) out.data = strict(DataSchema, ov.data, 'data', where);
  if (ov.dataSource !== undefined) {
    out.dataSource = strict(DataSourceSchema, ov.dataSource, 'dataSource', where);
  }
  return out;
}

/** Validates `value` with the node field's schema (the same as the ops); throws with readable messages. */
function strict<T>(schema: z.ZodType<T, unknown>, value: unknown, field: string, where: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => {
    const path = i.path.map(String).join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
  fail(`Invalid ${field} in ${where}: ${issues.join('; ')}`);
}

/** Normalizes a path → override map; empty overrides are dropped; `null` when empty. */
export function normalizeOverridesMap(
  map: Record<string, NodeOverride>,
): Record<string, NodeOverride> | null {
  const out: Record<string, NodeOverride> = {};
  for (const [path, ov] of Object.entries(map)) {
    assertOverridePath(path);
    const n = normalizeOverride(ov, `override "${path}"`);
    if (Object.keys(n).length > 0) out[path] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* ---------------- handlers ---------------- */

export function doAddComponent(d: Document, op: AddComponentOp): ComponentApplied {
  const c = deepClone(op.component);
  normalizeTree(c.root);
  delete c.root.position;
  assertRootShape(c.root);
  assertVariants(c);
  const list = d.components ?? [];
  if (list.some((x) => x.id === c.id)) fail(`A component with id "${c.id}" already exists`);
  assertUniqueName(list, c.name);
  assertFreshNodeIds(d, [c.root]);
  const index = clampIndex(op.index, list.length);
  const next = [...list];
  next.splice(index, 0, c);
  d.components = next;
  assertNoCycle(d, c.id);
  // The inverse only needs `force` if instances of this id already existed (they become
  // main-less again on undo). `createComponentOps` swaps the node for a provisional one before
  // `addComponent`, so the common case undoes without `force`.
  const orphans = listInstances(d, c.id).length > 0;
  return {
    inverse: [{ type: 'deleteComponent', componentId: c.id, ...(orphans && { force: true }) }],
    result: { componentId: c.id },
  };
}

export function doDeleteComponent(d: Document, op: DeleteComponentOp): ComponentApplied {
  const list = d.components ?? [];
  const index = requireComponentIndex(d, op.componentId);
  const c = list[index]!;
  if (!op.force) {
    const n = listInstances(d, c.id).length;
    if (n > 0) {
      fail(
        `Component "${c.name}" has ${n} ${n === 1 ? 'instance' : 'instances'}: detach or remove them before deleting`,
      );
    }
  }
  const next = list.filter((_, i) => i !== index);
  if (next.length > 0) d.components = next;
  else delete d.components;
  return { inverse: [{ type: 'addComponent', component: c, index }] };
}

export function doUpdateComponent(d: Document, op: UpdateComponentOp): ComponentApplied {
  const list = d.components ?? [];
  const index = requireComponentIndex(d, op.componentId);
  const prev = list[index]!;
  const c: ComponentDef = { ...prev };
  const inv: UpdateComponentOp = { type: 'updateComponent', componentId: prev.id };
  if (op.name !== undefined) {
    const name = op.name.trim();
    assertUniqueName(list, name, prev.id);
    inv.name = prev.name;
    c.name = name;
  }
  if (op.description !== undefined) {
    inv.description = prev.description ?? null;
    if (op.description === null) delete c.description;
    else c.description = op.description;
  }
  if (op.kit !== undefined) {
    inv.kit = prev.kit ?? null;
    if (op.kit === null) delete c.kit;
    else c.kit = op.kit;
  }
  if (op.props !== undefined) {
    inv.props = prev.props;
    c.props = deepClone(op.props);
  }
  if (op.variants !== undefined) {
    inv.variants = prev.variants;
    c.variants = deepClone(op.variants);
    assertVariants(c);
  }
  if (op.root !== undefined) {
    const root = normalizeTree(deepClone(op.root));
    delete root.position;
    assertRootShape(root);
    assertFreshNodeIds(d, [root], { exceptComponentId: prev.id });
    inv.root = prev.root;
    c.root = root;
  }
  d.components = list.map((x, i) => (i === index ? c : x));
  if (op.root !== undefined) assertNoCycle(d, c.id);
  return { inverse: [inv] };
}

export function doReplaceNode(d: Document, op: ReplaceNodeOp): ComponentApplied {
  const path = findNode(d, op.nodeId);
  if (!path) fail(`Node "${op.nodeId}" not found`);
  const node = normalizeTree(deepClone(op.node));
  assertFreshNodeIds(d, [node], { ignore: new Set(collectIds(path.node)) });
  if (path.parent?.type === 'instance') assertInstanceChildren(d, path.parent, [node], path.node);
  assertComponentInsertion(d, null, [node]);
  const arr = path.parent ? path.parent.children : path.page.frames;
  arr[path.index] = node;
  return {
    inverse: [{ type: 'replaceNode', nodeId: node.id, node: path.node }],
    result: { nodeId: node.id },
  };
}

export function doSetInstanceProps(d: Document, op: SetInstancePropsOp): ComponentApplied {
  const inv: { nodeId: string; set: Record<string, PropValue>; unset: string[] }[] = [];
  for (const ch of op.changes) {
    const node = requireInstance(d, ch.nodeId);
    const def = getComponent(d, node.componentId);
    const props: Record<string, PropValue> = { ...(node.props ?? {}) };
    const set: Record<string, PropValue> = {};
    for (const [k, v] of Object.entries(ch.set ?? {}))
      set[k] = def ? normalizePropValue(def, k, v) : v;
    const unset = unique(ch.unset ?? []);
    const prevSet: Record<string, PropValue> = {};
    const prevUnset: string[] = [];
    for (const k of unique([...unset, ...Object.keys(set)])) {
      if (k in props) prevSet[k] = props[k]!;
      else prevUnset.push(k);
    }
    for (const k of unset) delete props[k];
    Object.assign(props, set);
    if (Object.keys(props).length > 0) node.props = props;
    else delete node.props;
    inv.push({ nodeId: ch.nodeId, set: prevSet, unset: prevUnset });
  }
  return { inverse: [{ type: 'setInstanceProps', changes: inv.reverse() }] };
}

export function doSetInstanceOverrides(d: Document, op: SetInstanceOverridesOp): ComponentApplied {
  const inv: { nodeId: string; overrides: Record<string, NodeOverride> | null }[] = [];
  for (const ch of op.changes) {
    const node = requireInstance(d, ch.nodeId);
    inv.push({ nodeId: ch.nodeId, overrides: node.overrides ?? null });
    const next = ch.overrides === null ? null : normalizeOverridesMap(ch.overrides);
    if (next) node.overrides = next;
    else delete node.overrides;
  }
  return { inverse: [{ type: 'setInstanceOverrides', changes: inv.reverse() }] };
}
