/**
 * Routing of ops whose targets are not real page nodes (see `docs/COMPONENTS.md`,
 * "Editing by expanded id"). Called at the start of `applyOp`:
 *
 * - virtual id (`in_x/path`): content edits become `setInstanceOverrides` on the owning
 *   instance; structure edits are rejected (except inserting into a virtual slot container,
 *   which creates the instance's real container and inserts into it);
 * - real node in a main component's root: the op is applied to a temporary document (the root
 *   as a frame of a temporary page) and becomes `updateComponent { root }`;
 * - ops with several targets owned by different owners are partitioned and applied in sequence.
 *
 * The inverse is always that of the routed ops (exact), so undo/redo work like any other op.
 */
import { deepClone } from '../clone.js';
import type { ApplyResult, Op, StyleChange } from '../ops.js';
import { normalizeStyles } from '../styles.js';
import { vectorToSvg } from '../vector/svg.js';
import type { Document, Node, NodeOverride, PropValue } from '../types.js';
import {
  SLOT_ATTR,
  componentNodeIndex,
  expandInstance,
  findInTree,
  findInstanceNode,
  getComponent,
  isVirtualId,
  splitVirtualId,
} from './expand.js';
import { documentNodeIds, normalizeOverride, normalizePropValue, slotNames } from './ops.js';

type ApplyFn = (doc: Document, op: Op) => ApplyResult;
type Result = Record<string, unknown> | undefined;

/** Id of the temporary page used to apply ops to a main component's root. */
export const COMPONENT_EDIT_PAGE_ID = 'pg__component';

function fail(message: string): never {
  throw new Error(message);
}

/* ---------------- derived ids ---------------- */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function base36(n: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out = ALPHABET[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out;
}

/**
 * Deterministic id `<prefix>` + 8 chars [0-9a-z] derived from `key` by hashing; if already in
 * `taken`, retries with a salt (the result depends only on `key` and `taken`).
 */
export function derivedNodeId(prefix: string, key: string, taken: Set<string>): string {
  for (let salt = 0; ; salt++) {
    const k = salt === 0 ? key : `${key}#${salt}`;
    const id =
      prefix +
      base36(fnv1a(k, 0x811c9dc5) % 1679616, 4) +
      base36(fnv1a(k, 0x01000193) % 1679616, 4);
    if (!taken.has(id)) return id;
  }
}

/** Id of the instance's real container for slot `slot` (deterministic; see `derivedNodeId`). */
export function slotContainerId(doc: Document, instanceId: string, slot: string): string {
  return derivedNodeId('el_', `${instanceId}\u0000slot\u0000${slot}`, documentNodeIds(doc));
}

/** Slot container as the instance stores it (`Slot <name>`, `data-slot`). */
export function slotContainerNode(id: string, slot: string, children: Node[] = []): Node {
  return {
    id,
    type: 'element',
    name: `Slot ${slot}`,
    tag: 'div',
    attrs: { [SLOT_ATTR]: slot },
    style: {},
    children,
    locked: false,
    hidden: false,
  };
}

/* ---------------- target classification ---------------- */

type Owner = { kind: 'page' } | { kind: 'component'; id: string } | { kind: 'virtual'; id: string };

function ownerKey(o: Owner): string {
  return o.kind === 'page' ? 'page' : `${o.kind}:${o.id}`;
}

function classify(index: Map<string, string> | undefined, id: string): Owner {
  if (isVirtualId(id)) {
    const s = splitVirtualId(id);
    if (!s) fail(`Node "${id}" not found`);
    return { kind: 'virtual', id: s.instanceId };
  }
  const cid = index?.get(id);
  return cid ? { kind: 'component', id: cid } : { kind: 'page' };
}

/**
 * Likely targets of an op the router does not know, by the usual field names (`nodeId`,
 * `nodeIds`, `parentId`, `changes[].nodeId`): only used to reject with a clear message.
 */
function guessTargetIds(op: Op): string[] {
  const o = op as unknown as Record<string, unknown>;
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v) out.push(v);
  };
  add(o.nodeId);
  add(o.parentId);
  if (Array.isArray(o.nodeIds)) o.nodeIds.forEach(add);
  if (Array.isArray(o.changes)) {
    for (const ch of o.changes) add((ch as { nodeId?: unknown } | null)?.nodeId);
  }
  return out;
}

/**
 * Targets of the ops the router knows; `null` for the rest. A new op that targets nodes must be
 * added here (and, if it edits content, to `virtualToOverrides`); until then, targeting an
 * instance or main-component node with it fails with a clear message (see
 * `docs/COMPONENTS.md`, "Extending").
 */
function targetIds(op: Op): string[] | null {
  switch (op.type) {
    case 'createNode':
      return op.parentId ? [op.parentId] : [];
    case 'deleteNodes':
    case 'duplicateNodes':
      return op.nodeIds;
    case 'moveNodes':
      return op.parentId ? [...op.nodeIds, op.parentId] : op.nodeIds;
    case 'updateStyles':
      return [...(op.changes ?? []).map((c) => c.nodeId), ...(op.nodeIds ?? [])];
    case 'replaceNode':
      return [op.nodeId];
    case 'setText':
    case 'setAttrs':
    case 'renameNodes':
    case 'setPosition':
    case 'setNodeFlags':
    case 'setTag':
    case 'setSrc':
    case 'setSvg':
    case 'setClasses':
    case 'setStates':
    case 'setInstanceProps':
    case 'setInstanceOverrides':
    case 'setData':
    case 'setVector':
    case 'setMedia':
    case 'setMotion':
      return op.changes.map((c) => c.nodeId);
    default:
      return null;
  }
}

/* ---------------- sequential application ---------------- */

type Step = (cur: Document) => ApplyResult;

function runSteps(doc: Document, steps: Step[]): { r: ApplyResult; results: Result[] } {
  let cur = doc;
  const groups: Op[][] = [];
  const results: Result[] = [];
  for (const step of steps) {
    const r = step(cur);
    cur = r.doc;
    groups.push(r.inverse);
    results.push(r.result);
  }
  return { r: { doc: cur, inverse: groups.reverse().flat() }, results };
}

/** Merges the results of the parts (nodeIds concatenated, idMap merged). */
function mergeResults(results: Result[]): Result {
  const present = results.filter((r): r is Record<string, unknown> => !!r);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const out: Record<string, unknown> = {};
  for (const r of present) {
    for (const [k, v] of Object.entries(r)) {
      if (k === 'nodeIds' && Array.isArray(v))
        out.nodeIds = [...((out.nodeIds as unknown[]) ?? []), ...v];
      else if (k === 'idMap' && v && typeof v === 'object')
        out.idMap = { ...((out.idMap as object) ?? {}), ...v };
      else out[k] = v;
    }
  }
  return out;
}

/* ---------------- main component nodes ---------------- */

function applyInComponent(doc: Document, componentId: string, op: Op, apply: ApplyFn): ApplyResult {
  const c = getComponent(doc, componentId);
  if (!c) fail(`Component "${componentId}" not found`);
  const rootId = c.root.id;
  const rootMsg = `The root of main component "${c.name}" (${rootId})`;
  switch (op.type) {
    case 'deleteNodes':
      if (op.nodeIds.includes(rootId))
        fail(`${rootMsg} cannot be deleted: delete the component instead`);
      break;
    case 'duplicateNodes':
      if (op.nodeIds.includes(rootId)) fail(`${rootMsg} cannot be duplicated`);
      break;
    case 'moveNodes':
      if (op.nodeIds.includes(rootId)) fail(`${rootMsg} cannot be moved`);
      break;
    case 'setMotion':
      if (op.changes.some((ch) => ch.transition !== undefined))
        fail(`Slide transitions only apply to root frames (slides); ${rootMsg} is not one`);
      break;
    case 'setPosition':
      if (op.changes.some((ch) => ch.nodeId === rootId)) {
        fail(`${rootMsg} has no position (position belongs to each instance)`);
      }
      break;
    default:
      break;
  }
  const others = (doc.components ?? []).filter((x) => x.id !== componentId);
  const temp: Document = {
    ...doc,
    pages: [
      { id: COMPONENT_EDIT_PAGE_ID, name: c.name, background: '', frames: [c.root] },
      ...doc.pages.filter((p) => p.id !== COMPONENT_EDIT_PAGE_ID),
    ],
  };
  if (others.length > 0) temp.components = others;
  else delete temp.components;
  const r = apply(temp, op);
  const page = r.doc.pages[0];
  if (!page || page.id !== COMPONENT_EDIT_PAGE_ID || page.frames.length !== 1) {
    fail(`The operation would change the root of main component "${c.name}"`);
  }
  const u = apply(doc, { type: 'updateComponent', componentId, root: page.frames[0]! });
  return { doc: u.doc, inverse: u.inverse, result: r.result };
}

/* ---------------- virtual ids ---------------- */

interface VirtualCtx {
  owner: Node;
  ownerId: string;
  componentName: string;
  byId: Map<string, Node>;
}

function virtualCtx(doc: Document, instanceId: string): VirtualCtx {
  const owner = findInstanceNode(doc, instanceId);
  if (!owner) fail(`Node "${instanceId}" not found or is not an instance`);
  const def = getComponent(doc, owner.componentId);
  if (!def)
    fail(`Component "${owner.componentId ?? ''}" of instance "${instanceId}" does not exist`);
  const byId = new Map<string, Node>();
  const visit = (n: Node): void => {
    byId.set(n.id, n);
    n.children.forEach(visit);
  };
  visit(expandInstance(doc, owner));
  return { owner, ownerId: instanceId, componentName: def.name, byId };
}

function structureMessage(id: string, ctx: { ownerId: string; componentName?: string }): string {
  const comp = ctx.componentName ? ` (component "${ctx.componentName}")` : '';
  return `Node "${id}" is internal to instance "${ctx.ownerId}"${comp}: edit the main component or detach the instance`;
}

function refuseStructure(doc: Document, id: string): never {
  const s = splitVirtualId(id);
  const owner = s ? findInstanceNode(doc, s.instanceId) : undefined;
  const name = getComponent(doc, owner?.componentId)?.name;
  fail(structureMessage(id, { ownerId: s?.instanceId ?? id, componentName: name }));
}

function splitSet(
  set: Record<string, string> | undefined,
  unset: string[] | undefined,
): { set: Record<string, string>; unset: string[] } {
  const keep: Record<string, string> = {};
  const remove: string[] = [...(unset ?? [])];
  for (const [k, v] of Object.entries(set ?? {})) {
    if (v === undefined || v === null || String(v).trim() === '') remove.push(k);
    else keep[k] = v;
  }
  const u = normalizeOverride({ unsetStyle: remove }).unsetStyle ?? [];
  return { set: normalizeStyles(keep), unset: u };
}

function isEmptyOverride(ov: NodeOverride): boolean {
  return Object.entries(ov).every(
    ([k, v]) =>
      v === undefined ||
      // `data: []` (repeater with no items) and `animations: []` (none) are values, not absences
      (k !== 'data' && k !== 'animations' && Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0),
  );
}

/** Converts the virtual part of an op (all targets owned by the same instance) into overrides. */
function virtualToOverrides(doc: Document, instanceId: string, op: Op): Op {
  const ctx = virtualCtx(doc, instanceId);
  const map: Record<string, NodeOverride> = deepClone(ctx.owner.overrides ?? {});
  const prefix = `${instanceId}/`;
  const target = (nodeId: string): { node: Node; path: string } => {
    const node = ctx.byId.get(nodeId);
    if (!node || !nodeId.startsWith(prefix)) fail(`Node "${nodeId}" not found`);
    const path = nodeId.slice(prefix.length);
    if (path.split('/').pop() === '__missing')
      fail(`Node "${nodeId}" is a missing-component warning`);
    return { node, path };
  };
  const edit = (path: string): NodeOverride => (map[path] ??= {});

  switch (op.type) {
    case 'updateStyles': {
      const changes: StyleChange[] = [...(op.changes ?? [])];
      for (const nodeId of op.nodeIds ?? [])
        changes.push({ nodeId, set: op.styles, unset: op.unset });
      for (const ch of changes) {
        const { path } = target(ch.nodeId);
        const { set, unset } = splitSet(ch.set, ch.unset);
        const ov = edit(path);
        const style = { ...(ov.style ?? {}) };
        const unsetStyle = new Set(ov.unsetStyle ?? []);
        for (const k of unset) {
          delete style[k];
          unsetStyle.add(k);
        }
        for (const [k, v] of Object.entries(set)) {
          style[k] = v;
          unsetStyle.delete(k);
        }
        ov.style = style;
        ov.unsetStyle = [...unsetStyle];
      }
      break;
    }
    case 'setText':
      for (const ch of op.changes) {
        const ov = edit(target(ch.nodeId).path);
        if (ch.text === null) delete ov.text;
        else ov.text = ch.text;
      }
      break;
    case 'setAttrs':
      for (const ch of op.changes) {
        const ov = edit(target(ch.nodeId).path);
        const attrs = { ...(ov.attrs ?? {}) };
        for (const k of ch.unset ?? []) delete attrs[k.trim()];
        Object.assign(attrs, normalizeOverride({ attrs: ch.set ?? {} }).attrs ?? {});
        ov.attrs = attrs;
      }
      break;
    case 'setNodeFlags':
      for (const ch of op.changes) {
        const { path } = target(ch.nodeId);
        if (ch.locked !== undefined) {
          fail(
            `Node "${ch.nodeId}" is internal to instance "${instanceId}": "locked" does not apply (only "hidden")`,
          );
        }
        if (ch.hidden !== undefined) edit(path).hidden = ch.hidden;
      }
      break;
    case 'setClasses':
      for (const ch of op.changes) {
        const ov = edit(target(ch.nodeId).path);
        const next = normalizeOverride({ classes: ch.classes ?? '' }).classes;
        if (next) ov.classes = next;
        else delete ov.classes;
      }
      break;
    case 'setStates':
      for (const ch of op.changes) {
        const ov = edit(target(ch.nodeId).path);
        const next = ch.states
          ? normalizeOverride({ states: ch.states }, `"${ch.nodeId}"`).states
          : undefined;
        if (next) ov.states = next;
        else delete ov.states;
      }
      break;
    case 'setSrc':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        if (node.type !== 'image') fail(`Node "${ch.nodeId}" is not an image`);
        edit(path).src = ch.src;
      }
      break;
    case 'setSvg':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        if (node.type !== 'svg') fail(`Node "${ch.nodeId}" is not an SVG`);
        const ov = edit(path);
        ov.svg = normalizeOverride({ svg: ch.svg }, `"${ch.nodeId}"`).svg;
        if (ch.attrs)
          ov.attrs = {
            ...(ov.attrs ?? {}),
            ...(normalizeOverride({ attrs: ch.attrs }).attrs ?? {}),
          };
      }
      break;
    case 'setVector':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        if (node.type !== 'svg') fail(`Node "${ch.nodeId}" is not an svg`);
        const ov = edit(path);
        if (ch.vector) {
          const n = normalizeOverride(
            { vector: ch.vector, ...(ch.svg ? { svg: ch.svg } : {}) },
            `"${ch.nodeId}"`,
          );
          ov.vector = n.vector;
          ov.svg = n.svg ?? vectorToSvg(n.vector!);
        } else {
          delete ov.vector;
          if (ch.svg) ov.svg = normalizeOverride({ svg: ch.svg }, `"${ch.nodeId}"`).svg;
          else delete ov.svg;
        }
      }
      break;
    case 'setMedia':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        const given = (['effect', 'video', 'embed'] as const).filter((k) => ch[k] !== undefined);
        if (given.length !== 1)
          fail(`setMedia on "${ch.nodeId}": provide exactly one of effect, video or embed`);
        const field = given[0]!;
        if (node.type !== field)
          fail(`Node "${ch.nodeId}" is ${node.type}; ${field} only applies to ${field} nodes`);
        Object.assign(edit(path), normalizeOverride({ [field]: ch[field] }, `"${ch.nodeId}"`));
      }
      break;
    case 'setMotion':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        if (ch.animations === undefined && ch.transition === undefined)
          fail(`setMotion on "${ch.nodeId}": provide animations and/or transition`);
        if (ch.transition !== undefined)
          fail(`Slide transitions only apply to root frames (slides); "${ch.nodeId}" is not one`);
        if (ch.animations === undefined) continue;
        const list = normalizeOverride(
          { animations: ch.animations ?? [] },
          `setMotion on "${ch.nodeId}"`,
        ).animations!;
        if (list.some((a) => a.split === 'words' || a.split === 'chars') && node.type !== 'text')
          fail(
            `setMotion on "${ch.nodeId}": split "words" and "chars" only apply to text nodes (this one is ${node.type})`,
          );
        edit(path).animations = list;
      }
      break;
    case 'setData':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        if (node.type !== 'repeater') fail(`Node "${ch.nodeId}" is not a repeater`);
        const ov = edit(path);
        if (ch.data === null) delete ov.data;
        else if (ch.data !== undefined)
          ov.data = normalizeOverride({ data: ch.data }, `"${ch.nodeId}"`).data;
        if (ch.source === null) delete ov.dataSource;
        else if (ch.source !== undefined)
          ov.dataSource = normalizeOverride({ dataSource: ch.source }, `"${ch.nodeId}"`).dataSource;
      }
      break;
    case 'setInstanceProps':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        const def = getComponent(doc, node.componentId);
        if (!node.componentId) fail(`Node "${ch.nodeId}" is not a component instance`);
        const ov = edit(path);
        const props: Record<string, PropValue> = { ...(ov.props ?? {}) };
        for (const k of ch.unset ?? []) delete props[k];
        for (const [k, v] of Object.entries(ch.set ?? {}))
          props[k] = def ? normalizePropValue(def, k, v) : v;
        ov.props = props;
      }
      break;
    case 'setInstanceOverrides':
      for (const ch of op.changes) {
        const { node, path } = target(ch.nodeId);
        const def = getComponent(doc, node.componentId);
        if (!node.componentId || !def) fail(`Node "${ch.nodeId}" is not a component instance`);
        for (const k of Object.keys(map)) if (k.startsWith(`${path}/`)) delete map[k];
        for (const [k, ov] of Object.entries(ch.overrides ?? {})) {
          map[`${path}/${k === '' ? def.root.id : k}`] = ov;
        }
      }
      break;
    default: {
      const first = targetIds(op)?.find(isVirtualId) ?? instanceId;
      fail(structureMessage(first, { ownerId: instanceId, componentName: ctx.componentName }));
    }
  }
  for (const [k, ov] of Object.entries(map)) if (isEmptyOverride(ov)) delete map[k];
  return {
    type: 'setInstanceOverrides',
    changes: [{ nodeId: instanceId, overrides: Object.keys(map).length > 0 ? map : null }],
  };
}

/**
 * Virtual slot container: id `<instance>/<main component node>` where the node is the
 * `data-slot` container of a slot prop of the component (and not the container of a nested
 * instance).
 */
function virtualSlot(
  doc: Document,
  id: string,
): { instanceId: string; slot: string; existing?: string } | undefined {
  const s = splitVirtualId(id);
  if (!s || s.segments.length !== 1) return undefined;
  const owner = findInstanceNode(doc, s.instanceId);
  const def = getComponent(doc, owner?.componentId);
  if (!owner || !def) return undefined;
  let parent: Node | null = null;
  const find = (n: Node, p: Node | null): Node | undefined => {
    if (n.id === s.path) {
      parent = p;
      return n;
    }
    for (const c of n.children) {
      const f = find(c, n);
      if (f) return f;
    }
    return undefined;
  };
  const main = find(def.root, null);
  const slot = main?.attrs[SLOT_ATTR];
  if (!main || !slot || main === def.root || !slotNames(def).includes(slot)) return undefined;
  if ((parent as Node | null)?.type === 'instance') return undefined;
  const existing = owner.children.find((c) => c.attrs?.[SLOT_ATTR] === slot);
  return { instanceId: s.instanceId, slot, ...(existing && { existing: existing.id }) };
}

/** Ensures the slot's real container and returns the step that creates it (or none) and its id. */
function ensureSlotContainer(
  doc: Document,
  parentId: string,
  apply: ApplyFn,
): { steps: Step[]; containerId: string } {
  const slot = virtualSlot(doc, parentId);
  if (!slot) {
    const s = splitVirtualId(parentId);
    const owner = s ? findInstanceNode(doc, s.instanceId) : undefined;
    const name = getComponent(doc, owner?.componentId)?.name;
    fail(
      `${structureMessage(parentId, { ownerId: s?.instanceId ?? parentId, componentName: name })} (only slots accept content: insert inside a slot)`,
    );
  }
  if (slot.existing) return { steps: [], containerId: slot.existing };
  const containerId = slotContainerId(doc, slot.instanceId, slot.slot);
  const node = slotContainerNode(containerId, slot.slot);
  return {
    steps: [(cur) => apply(cur, { type: 'createNode', parentId: slot.instanceId, node })],
    containerId,
  };
}

/* ---------------- routing ---------------- */

interface Group<T> {
  owner: Owner;
  items: T[];
}

function groupBy<T>(items: T[], ownerOf: (t: T) => Owner): Group<T>[] {
  const map = new Map<string, Group<T>>();
  for (const it of items) {
    const o = ownerOf(it);
    const k = ownerKey(o);
    let g = map.get(k);
    if (!g) {
      g = { owner: o, items: [] };
      map.set(k, g);
    }
    g.items.push(it);
  }
  return [...map.values()];
}

function applyGroup(cur: Document, owner: Owner, op: Op, apply: ApplyFn): ApplyResult {
  if (owner.kind === 'page') return apply(cur, op);
  if (owner.kind === 'component') return applyInComponent(cur, owner.id, op, apply);
  return apply(cur, virtualToOverrides(cur, owner.id, op));
}

function withChanges(op: Op, changes: unknown[]): Op {
  return { ...op, changes } as unknown as Op;
}

/** Op outside `targetIds` targeting an instance or main-component node. */
function refuseUnrouted(type: string, owners: Owner[]): never {
  if (owners.some((o) => o.kind === 'virtual')) {
    fail(
      `Operation "${type}" is not supported on instance nodes; use set_instance_override or detach the instance (detach_instance)`,
    );
  }
  fail(
    `Operation "${type}" is not supported on main component nodes; edit the main component with update_component_html or update_component`,
  );
}

/**
 * Routes the op if any target is a virtual id or a main-component node; `null` when all targets
 * are page nodes (the normal path of `applyOp`). Cheap without components: it only looks for `/`.
 */
export function routeComponentOp(doc: Document, op: Op, apply: ApplyFn): ApplyResult | null {
  const listed = targetIds(op);
  const ids = listed ?? guessTargetIds(op);
  if (ids.length === 0) return null;
  const hasComponents = !!doc.components && doc.components.length > 0;
  if (!hasComponents && !ids.some(isVirtualId)) return null;
  const index = hasComponents ? componentNodeIndex(doc) : undefined;
  const ownerOf = (id: string): Owner => classify(index, id);
  if (ids.every((id) => ownerOf(id).kind === 'page')) return null;
  if (!listed) refuseUnrouted(op.type, ids.map(ownerOf));

  switch (op.type) {
    case 'createNode': {
      const owner = ownerOf(op.parentId!);
      if (owner.kind === 'component') return applyInComponent(doc, owner.id, op, apply);
      const { steps, containerId } = ensureSlotContainer(doc, op.parentId!, apply);
      const { r, results } = runSteps(doc, [
        ...steps,
        (cur) => apply(cur, { ...op, parentId: containerId }),
      ]);
      return {
        ...r,
        result: { ...(results[results.length - 1] ?? {}), slotContainerId: containerId },
      };
    }
    case 'moveNodes': {
      for (const id of op.nodeIds) if (ownerOf(id).kind === 'virtual') refuseStructure(doc, id);
      if (op.parentId && ownerOf(op.parentId).kind === 'virtual') {
        const { steps, containerId } = ensureSlotContainer(doc, op.parentId, apply);
        const { r } = runSteps(doc, [
          ...steps,
          (cur) => apply(cur, { ...op, parentId: containerId }),
        ]);
        return r;
      }
      if (op.parentId !== undefined) {
        const dest = op.parentId ? ownerKey(ownerOf(op.parentId)) : 'page';
        if (op.nodeIds.some((id) => ownerKey(ownerOf(id)) !== dest)) {
          fail(
            'Cannot move nodes between a main component and a page (or between main components)',
          );
        }
        const owner = op.parentId ? ownerOf(op.parentId) : ({ kind: 'page' } as Owner);
        return applyGroup(doc, owner, op, apply);
      }
      const groups = groupBy(op.nodeIds, ownerOf);
      const { r, results } = runSteps(
        doc,
        groups.map((g) => (cur) => applyGroup(cur, g.owner, { ...op, nodeIds: g.items }, apply)),
      );
      return { ...r, result: mergeResults(results) };
    }
    case 'deleteNodes':
    case 'duplicateNodes': {
      for (const id of op.nodeIds) if (ownerOf(id).kind === 'virtual') refuseStructure(doc, id);
      const groups = groupBy(op.nodeIds, ownerOf);
      if (groups.length === 1) return applyGroup(doc, groups[0]!.owner, op, apply);
      const { r, results } = runSteps(
        doc,
        groups.map((g) => (cur) => applyGroup(cur, g.owner, { ...op, nodeIds: g.items }, apply)),
      );
      const result = mergeResults(results);
      if (op.type === 'duplicateNodes' && result) {
        result.op = { type: 'duplicateNodes', nodeIds: op.nodeIds, idMap: result.idMap ?? {} };
      }
      return { ...r, result };
    }
    case 'replaceNode': {
      const owner = ownerOf(op.nodeId);
      if (owner.kind === 'virtual') refuseStructure(doc, op.nodeId);
      return applyGroup(doc, owner, op, apply);
    }
    case 'updateStyles': {
      const changes: StyleChange[] = [...(op.changes ?? [])];
      for (const nodeId of op.nodeIds ?? [])
        changes.push({ nodeId, set: op.styles, unset: op.unset });
      const groups = groupBy(changes, (c) => ownerOf(c.nodeId));
      const { r, results } = runSteps(
        doc,
        groups.map(
          (g) => (cur) =>
            applyGroup(cur, g.owner, { type: 'updateStyles', changes: g.items }, apply),
        ),
      );
      return { ...r, result: mergeResults(results) };
    }
    default: {
      if (!('changes' in op) || !Array.isArray(op.changes)) return null;
      const list = op.changes as { nodeId: string }[];
      const groups = groupBy(list, (c) => ownerOf(c.nodeId));
      const { r, results } = runSteps(
        doc,
        groups.map((g) => (cur) => applyGroup(cur, g.owner, withChanges(op, g.items), apply)),
      );
      return { ...r, result: mergeResults(results) };
    }
  }
}

/** Shortcut used by the planners: `true` if the id is a real node inside a main component. */
export function isComponentNodeId(doc: Document, id: string): boolean {
  return !!doc.components?.length && componentNodeIndex(doc).has(id);
}

/** Real node inside a main component (or `undefined`). */
export function componentNodeById(doc: Document, id: string): Node | undefined {
  const cid = doc.components?.length ? componentNodeIndex(doc).get(id) : undefined;
  const def = getComponent(doc, cid);
  return def ? findInTree(def.root, id) : undefined;
}
