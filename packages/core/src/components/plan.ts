/**
 * Component planners (see `docs/COMPONENTS.md`, Ops section): pure functions that read the
 * document and return the primitive ops (applied by the caller as a single history entry).
 */
import { deepClone } from '../clone.js';
import { findNode, walk } from '../document.js';
import { ID_PREFIX, newComponentId, newNodeId } from '../ids.js';
import type { Op } from '../ops.js';
import { PROP_NAME_RE } from '../schema.js';
import { normalizeStyles, toKebabCase } from '../styles.js';
import type {
  ComponentDef,
  ComponentVariant,
  Document,
  Node,
  NodeOverride,
  PropDef,
  PropValue,
  Theme,
} from '../types.js';
import {
  SLOT_ATTR,
  applyOverride,
  componentDependencies,
  expandInstance,
  findComponent,
  findInTree,
  getComponent,
  isVirtualId,
  mergeOverride,
  placeholderNames,
} from './expand.js';
import { documentNodeIds, normalizePropValue, slotNames } from './ops.js';
import { componentNodeById, derivedNodeId, isComponentNodeId, slotContainerNode } from './route.js';

function fail(message: string): never {
  throw new Error(message);
}

/** Name free among `taken` (case-insensitive): `Name`, `Name 2`, `Name 3`... */
export function uniqueComponentName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const name = base.trim() || 'Component';
  if (!set.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
}

function otherNames(doc: Document, exceptId?: string): string[] {
  return (doc.components ?? []).filter((c) => c.id !== exceptId).map((c) => c.name);
}

/** Real instance (page or main component root) by id; rejects virtual ids. */
function requireRealInstance(doc: Document, nodeId: string, action: string): Node {
  if (isVirtualId(nodeId)) {
    fail(
      `Node "${nodeId}" is internal to another instance: cannot ${action} (edit the main component or detach the outer instance)`,
    );
  }
  const node = findNode(doc, nodeId)?.node ?? componentNodeById(doc, nodeId);
  if (!node) fail(`Node "${nodeId}" not found`);
  if (node.type !== 'instance') fail(`Node "${nodeId}" is not a component instance`);
  return node;
}

function requireDef(doc: Document, inst: Node): ComponentDef {
  const def = getComponent(doc, inst.componentId);
  if (!def) fail(`Component "${inst.componentId ?? ''}" of instance "${inst.id}" does not exist`);
  return def;
}

/* ---------------- createComponent ---------------- */

/**
 * Properties that position the node in its parent: they leave the main component's root and stay
 * in the instance's style (each instance is positioned where it sits).
 */
const PLACEMENT_RE =
  /^(position|top|right|bottom|left|inset(-.+)?|z-index|margin(-.+)?|flex|flex-grow|flex-shrink|flex-basis|align-self|justify-self|place-self|order|grid-area|grid-column(-.+)?|grid-row(-.+)?)$/;

export function isPlacementProperty(prop: string): boolean {
  return PLACEMENT_RE.test(prop);
}

/** Target of `bind`: the node's text, an attribute (`attr:href`) or a style property (`style:color`). */
export type PropBindTarget = 'text' | `attr:${string}` | `style:${string}`;

/** Prop in the input of `createComponentOps`: `bind` replaces the node's current value with `{{name}}`. */
export interface PropInput extends PropDef {
  bind?: { nodeId: string; target: PropBindTarget };
}

export interface CreateComponentOptions {
  name?: string;
  description?: string;
  /** Declared props; undeclared ones are inferred (`{{name}}` → string, `data-slot` → slot). */
  props?: PropInput[];
  componentId?: string;
  instanceId?: string;
}

function cleanPropDef(p: PropDef): PropDef {
  const out: PropDef = { name: p.name.trim(), type: p.type };
  if (p.default !== undefined && p.type !== 'slot') out.default = p.default;
  if (p.options !== undefined) out.options = [...p.options];
  if (p.description !== undefined) out.description = p.description;
  return out;
}

function bindProp(root: Node, p: PropInput): PropDef {
  const { bind, ...rest } = p;
  const def: PropDef = { ...rest };
  if (!bind) return def;
  if (def.type === 'slot')
    fail(`Prop "${def.name}" is a slot: mark the container with data-slot instead of "bind"`);
  const target = findInTree(root, bind.nodeId);
  if (!target)
    fail(`Node "${bind.nodeId}" (bind of prop "${def.name}") is not inside the component node`);
  const ph = `{{${def.name}}}`;
  let current: string | undefined;
  if (bind.target === 'text') {
    current = target.text;
    if (current === undefined)
      fail(`Node "${bind.nodeId}" has no text (bind of prop "${def.name}")`);
    target.text = ph;
  } else if (bind.target.startsWith('attr:')) {
    const attr = bind.target.slice(5).trim();
    current = target.attrs[attr];
    if (current === undefined) fail(`Node "${bind.nodeId}" has no "${attr}" attribute`);
    target.attrs = { ...target.attrs, [attr]: ph };
  } else if (bind.target.startsWith('style:')) {
    const prop = toKebabCase(bind.target.slice(6).trim());
    current = target.style[prop];
    if (current === undefined) {
      fail(
        `Node "${bind.nodeId}" has no "${prop}" in its style${isPlacementProperty(prop) && target === root ? ' (positioning properties stay on the instance)' : ''}`,
      );
    }
    target.style = { ...target.style, [prop]: ph };
  } else {
    fail(`Invalid bind target: "${String(bind.target)}" (use text, attr:<name> or style:<prop>)`);
  }
  if (def.default === undefined) {
    if (def.type === 'number' && Number.isFinite(Number(current))) def.default = Number(current);
    else if (def.type === 'boolean') def.default = current === 'true';
    else def.default = current;
  }
  return def;
}

/** Props inferred from the tree: `{{name}}` (string, default `''`) and `data-slot` (slot). */
export function inferProps(root: Node): PropDef[] {
  const strings: string[] = [];
  const slots: string[] = [];
  const visit = (n: Node, hostChild: boolean): void => {
    const values = [
      n.text ?? '',
      n.src ?? '',
      ...Object.values(n.attrs),
      ...Object.values(n.style),
      ...Object.values(n.states ?? {}).flatMap((s) => Object.values(s)),
      ...Object.values(n.props ?? {}).filter((v): v is string => typeof v === 'string'),
    ];
    for (const v of values) for (const name of placeholderNames(v)) strings.push(name);
    const slot = n.attrs[SLOT_ATTR];
    if (!hostChild && n !== root && slot && PROP_NAME_RE.test(slot)) slots.push(slot);
    for (const c of n.children) visit(c, n.type === 'instance');
  };
  visit(root, false);
  const out: PropDef[] = [];
  const seen = new Set<string>();
  for (const name of slots) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, type: 'slot' });
  }
  for (const name of strings) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, type: 'string', default: '' });
  }
  return out;
}

/**
 * Turns the node into a component: the root is a clone of the node with the same ids (without
 * `position`, without the positioning properties in its parent) and the node becomes the first
 * instance (inheriting position, name, `locked`, `hidden` and the positioning). Ops:
 * `replaceNode` (node → empty provisional node), `addComponent` and `replaceNode` (provisional →
 * instance). The root ids only become free after the first swap; the provisional node makes
 * `addComponent` happen with no instances, so the undo (reverse order: instance → provisional,
 * `deleteComponent`, provisional → node) does not need `force`.
 */
export function createComponentOps(
  doc: Document,
  nodeId: string,
  opts: CreateComponentOptions = {},
): { ops: Op[]; componentId: string; instanceId: string } {
  if (isVirtualId(nodeId)) {
    fail(
      `Node "${nodeId}" is internal to an instance: detach the instance or edit the main component`,
    );
  }
  if (isComponentNodeId(doc, nodeId)) {
    fail(`Node "${nodeId}" is inside a main component: create the component from page nodes`);
  }
  const path = findNode(doc, nodeId);
  if (!path) fail(`Node "${nodeId}" not found`);
  const node = path.node;
  if (!path.parent || node.type === 'frame') {
    fail(`Node "${nodeId}" is a root frame: create the component from a node inside the frame`);
  }
  if (node.type === 'instance') fail(`Node "${nodeId}" is already a component instance`);

  const componentId = opts.componentId ?? newComponentId();
  if (getComponent(doc, componentId)) fail(`A component with id "${componentId}" already exists`);
  const instanceId = opts.instanceId ?? newNodeId('instance');
  const name = uniqueComponentName(opts.name ?? node.name, otherNames(doc));

  const root = deepClone(node);
  delete root.position;
  root.hidden = false;
  root.locked = false;
  const instStyle: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.style)) {
    if (!isPlacementProperty(k)) continue;
    instStyle[k] = v;
    delete root.style[k];
  }
  const instStates: Record<string, Record<string, string>> = {};
  for (const [key, st] of Object.entries(root.states ?? {})) {
    for (const [k, v] of Object.entries(st)) {
      if (!isPlacementProperty(k)) continue;
      (instStates[key] ??= {})[k] = v;
      delete st[k];
    }
    if (Object.keys(st).length === 0) delete root.states![key];
  }
  if (root.states && Object.keys(root.states).length === 0) delete root.states;

  const props: PropDef[] = [];
  for (const p of opts.props ?? []) {
    if (!PROP_NAME_RE.test(p.name.trim())) fail(`Invalid prop name: "${p.name}"`);
    if (props.some((x) => x.name === p.name.trim())) fail(`Duplicate prop: "${p.name}"`);
    props.push(cleanPropDef(bindProp(root, { ...p, name: p.name.trim() })));
  }
  for (const p of inferProps(root)) if (!props.some((x) => x.name === p.name)) props.push(p);

  const component: ComponentDef = { id: componentId, name, props, root, variants: [] };
  if (opts.description) component.description = opts.description;

  const instance: Node = {
    id: instanceId,
    type: 'instance',
    name: node.name,
    tag: root.tag,
    attrs: {},
    style: instStyle,
    children: [],
    locked: node.locked,
    hidden: node.hidden,
    componentId,
  };
  if (node.position) instance.position = { ...node.position };
  if (Object.keys(instStates).length > 0) instance.states = instStates;
  const taken = documentNodeIds(doc);
  taken.add(instanceId);
  const freshElementId = (): string => {
    let id = newNodeId('element');
    while (taken.has(id)) id = newNodeId('element');
    taken.add(id);
    return id;
  };
  for (const slot of slotNames(component)) {
    instance.children.push(slotContainerNode(freshElementId(), slot));
  }
  const stub: Node = {
    id: freshElementId(),
    type: 'element',
    name: node.name,
    tag: 'div',
    attrs: {},
    style: {},
    children: [],
    locked: node.locked,
    hidden: node.hidden,
  };
  return {
    ops: [
      { type: 'replaceNode', nodeId, node: stub },
      { type: 'addComponent', component },
      { type: 'replaceNode', nodeId: stub.id, node: instance },
    ],
    componentId,
    instanceId,
  };
}

/* ---------------- instances ---------------- */

export interface InstanceOptions {
  props?: Record<string, PropValue>;
  /** Content per slot (goes in the `data-slot` containers; omitted slots use the default). */
  slots?: Record<string, Node[]>;
  name?: string;
  style?: Record<string, string>;
  id?: string;
}

/**
 * Instance node ready for `createNode`: validated props (those equal to the default are omitted)
 * and one container per `slot` prop (`{ type:'element', tag:'div', name:'Slot <name>', attrs:{'data-slot'} }`).
 * `componentId` also accepts the name or `kit/Name`.
 */
export function instanceNodeFor(
  doc: Document,
  componentId: string,
  opts: InstanceOptions = {},
): Node {
  const def = getComponent(doc, componentId) ?? findComponent(doc, componentId);
  if (!def) fail(`Component "${componentId}" not found`);
  const props: Record<string, PropValue> = {};
  for (const [k, v] of Object.entries(opts.props ?? {})) {
    const value = normalizePropValue(def, k, v);
    const p = def.props.find((x) => x.name === k);
    if (p?.default !== undefined && String(p.default) === String(value)) continue;
    props[k] = value;
  }
  const slots = slotNames(def);
  for (const k of Object.keys(opts.slots ?? {})) {
    if (!slots.includes(k)) {
      fail(
        `Component "${def.name}" has no slot "${k}"${slots.length > 0 ? ` (slots: ${slots.join(', ')})` : ''}`,
      );
    }
  }
  const taken = documentNodeIds(doc);
  const node: Node = {
    id: opts.id ?? newNodeId('instance'),
    type: 'instance',
    name: opts.name ?? def.name,
    tag: def.root.tag,
    attrs: {},
    style: normalizeStyles(opts.style ?? {}),
    children: slots.map((slot) => {
      let id = newNodeId('element');
      while (taken.has(id)) id = newNodeId('element');
      taken.add(id);
      return slotContainerNode(id, slot, deepClone(opts.slots?.[slot] ?? []));
    }),
    locked: false,
    hidden: false,
    componentId: def.id,
  };
  if (Object.keys(props).length > 0) node.props = props;
  return node;
}

/**
 * Detaches the instance: `replaceNode` with the concrete tree. Nodes coming from the main
 * component (virtual ids) and the root get new real ids (type prefix); slot containers and
 * content keep their ids; nested instances remain instances, with the inherited overrides.
 */
export function detachInstanceOps(doc: Document, nodeId: string): Op[] {
  const inst = requireRealInstance(doc, nodeId, 'detach');
  requireDef(doc, inst);
  const tree = deepClone(expandInstance(doc, inst, { deep: false }));
  const taken = documentNodeIds(doc);
  const fresh = (n: Node): string => {
    let id = newNodeId(n.type);
    while (taken.has(id)) id = newNodeId(n.type);
    taken.add(id);
    return id;
  };
  walk(tree, (n) => {
    if (n === tree || isVirtualId(n.id)) n.id = fresh(n);
  });
  delete tree.componentId;
  delete tree.props;
  delete tree.overrides;
  return [{ type: 'replaceNode', nodeId, node: tree }];
}

/**
 * Writes the instance's overrides into the main component (main-component nodes and the
 * overrides of instances nested in it) and clears the instance's own. Overrides of nodes that no
 * longer exist are ignored. The main component's variants still apply on top of what was written.
 */
export function pushOverridesToMainOps(doc: Document, nodeId: string): Op[] {
  const inst = requireRealInstance(doc, nodeId, 'push to the main component');
  const def = requireDef(doc, inst);
  const overrides = inst.overrides ?? {};
  if (Object.keys(overrides).length === 0) return [];
  const root = deepClone(def.root);
  for (const [path, ov] of Object.entries(overrides)) {
    const key = path === '' ? root.id : path;
    const i = key.indexOf('/');
    if (i < 0) {
      const target = findInTree(root, key);
      if (target) applyOverride(target, ov);
      continue;
    }
    const nested = findInTree(root, key.slice(0, i));
    if (nested?.type !== 'instance') continue;
    const rest = key.slice(i + 1);
    const map: Record<string, NodeOverride> = { ...(nested.overrides ?? {}) };
    map[rest] = map[rest] ? mergeOverride(map[rest], ov) : ov;
    nested.overrides = map;
  }
  return [
    { type: 'updateComponent', componentId: def.id, root },
    { type: 'setInstanceOverrides', changes: [{ nodeId, overrides: null }] },
  ];
}

/** Removes the instance's overrides (for a nested instance, use its virtual id). */
export function resetInstanceOps(doc: Document, nodeId: string): Op[] {
  if (!isVirtualId(nodeId)) requireRealInstance(doc, nodeId, 'reset');
  return [{ type: 'setInstanceOverrides', changes: [{ nodeId, overrides: null }] }];
}

/* ---------------- importKit ---------------- */

/**
 * Status of each kit component in the document:
 * - `added`: did not exist (by kit id) and was added;
 * - `updated`: existed with the same `kit` and was overwritten by the kit's (only without `onlyMissing`);
 * - `unchanged`: already equal to the kit's;
 * - `diverged`: exists with the same `kit` but differs from the kit (user edits) and was kept
 *   (`onlyMissing`).
 */
export type ImportKitStatus = 'added' | 'updated' | 'unchanged' | 'diverged';

export interface ImportKitResult {
  ops: Op[];
  components: { id: string; name: string; status: ImportKitStatus }[];
  /** Components with a kit component's id but another origin (different `kit`): never touched. */
  skipped: { id: string; name: string; kit?: string }[];
  tokensAdded: string[];
}

export interface ImportKitOptions {
  /**
   * Only adds the missing components (by kit id, which is stable: renaming does not count as
   * missing); never updates existing ones (those that differ are reported as `diverged`). Missing
   * tokens are still created.
   */
  onlyMissing?: boolean;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Kit components with their dependencies (instances of other kit components) first. */
function topoOrder(list: ComponentDef[]): ComponentDef[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const out: ComponentDef[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (c: ComponentDef): void => {
    if (state.get(c.id)) return;
    state.set(c.id, 'visiting');
    for (const dep of componentDependencies(c.root)) {
      const d = byId.get(dep);
      if (d && !state.get(d.id)) visit(d);
    }
    state.set(c.id, 'done');
    out.push(c);
  };
  list.forEach(visit);
  return out;
}

/**
 * Imports the components of a kit (a `*.mockup.json` document with `components`):
 * - new id: `addComponent` (dependencies first), with `kit` filled in and a unique name;
 * - same id already in the document with `kit === kitName`: `unchanged` if equal; if it differs,
 *   `updated` (`updateComponent`) or, with `onlyMissing`, `diverged` (kept as is);
 * - same id with another `kit` (or none): never touched (`skipped`);
 * - node ids that collide with nodes of another owner get derived ids (deterministic, so
 *   importing again changes nothing), remapping the variant and override keys;
 * - missing tokens (with metadata) and the theme overrides (e.g. `dark`) of those tokens.
 */
export function importKitOps(
  doc: Document,
  kit: Document,
  kitName: string,
  opts: ImportKitOptions = {},
): ImportKitResult {
  const ops: Op[] = [];

  // Missing tokens, their metadata and theme overrides (like planShadcnTokens).
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(kit.tokens)) if (!(k in doc.tokens)) set[k] = v;
  const tokensAdded = Object.keys(set);
  if (tokensAdded.length > 0) {
    ops.push({ type: 'setTokens', set });
    const meta: Record<string, { group?: string; description?: string }> = {};
    for (const k of tokensAdded) {
      const m = kit.tokenMeta?.[k];
      if (m && (m.group || m.description) && !doc.tokenMeta?.[k]) meta[k] = { ...m };
    }
    if (Object.keys(meta).length > 0) ops.push({ type: 'setTokenMeta', set: meta });
    const themes: Theme[] = (doc.themes ?? []).map((t) => ({
      ...t,
      overrides: { ...t.overrides },
    }));
    let changedTheme = false;
    for (const kt of kit.themes ?? []) {
      const add = tokensAdded.filter((k) => k in kt.overrides);
      if (add.length === 0) continue;
      let t = themes.find((x) => x.name === kt.name);
      if (!t) {
        t = { name: kt.name, overrides: {} };
        themes.push(t);
      }
      for (const k of add) {
        if (k in t.overrides) continue;
        t.overrides[k] = kt.overrides[k]!;
        changedTheme = true;
      }
    }
    if (changedTheme) ops.push({ type: 'setThemes', themes });
  }

  // Components.
  const kitList = kit.components ?? [];
  const kitById = new Map(kitList.map((c) => [c.id, c]));
  const remaps = new Map<string, Map<string, string>>();
  const assigned = new Set<string>();
  const names = new Map<string, string>(
    (doc.components ?? []).map((c) => [c.id, c.name] as [string, string]),
  );
  const components: ImportKitResult['components'] = [];
  const skipped: ImportKitResult['skipped'] = [];

  /** Override path relative to component `cid` with the ids remapped. */
  const remapPath = (path: string, cid: string): string => {
    if (path === '') return path;
    let cur: string | undefined = cid;
    return path
      .split('/')
      .map((seg) => {
        const out = (cur && remaps.get(cur)?.get(seg)) ?? seg;
        const kc = cur ? kitById.get(cur) : undefined;
        const n = kc ? findInTree(kc.root, seg) : undefined;
        cur = n?.type === 'instance' ? n.componentId : undefined;
        return out;
      })
      .join('/');
  };
  const remapOverrides = (
    map: Record<string, NodeOverride>,
    cid: string,
  ): Record<string, NodeOverride> => {
    const out: Record<string, NodeOverride> = {};
    for (const [k, v] of Object.entries(map)) out[remapPath(k, cid)] = v;
    return out;
  };

  for (const kc of topoOrder(kitList)) {
    const existing = getComponent(doc, kc.id);
    const taken = documentNodeIds(doc, kc.id);
    for (const id of assigned) taken.add(id);
    const remap = new Map<string, string>();
    walk(kc.root, (n) => {
      if (!taken.has(n.id)) return;
      const id = derivedNodeId(ID_PREFIX[n.type], `${kc.id}/${n.id}`, taken);
      remap.set(n.id, id);
      taken.add(id);
    });
    remaps.set(kc.id, remap);

    const root = deepClone(kc.root);
    delete root.position;
    walk(root, (n) => {
      const orig = n.id;
      n.id = remap.get(orig) ?? orig;
      assigned.add(n.id);
      if (n.type === 'instance' && n.overrides && n.componentId) {
        n.overrides = remapOverrides(n.overrides, n.componentId);
      }
    });
    const variants: ComponentVariant[] = kc.variants.map((v) => ({
      when: { ...v.when },
      overrides: remapOverrides(deepClone(v.overrides), kc.id),
    }));
    if (existing && existing.kit !== kitName) {
      skipped.push({
        id: existing.id,
        name: existing.name,
        ...(existing.kit !== undefined && { kit: existing.kit }),
      });
      continue;
    }
    const takenNames = [...names].filter(([id]) => id !== kc.id).map(([, n]) => n);
    const name = uniqueComponentName(kc.name, takenNames);
    const desired: ComponentDef = {
      id: kc.id,
      name,
      kit: kitName,
      props: deepClone(kc.props),
      root,
      variants,
    };
    if (kc.description !== undefined) desired.description = kc.description;

    if (!existing) {
      names.set(kc.id, name);
      ops.push({ type: 'addComponent', component: desired });
      components.push({ id: kc.id, name, status: 'added' });
    } else if (stableStringify(existing) === stableStringify(desired)) {
      components.push({ id: kc.id, name, status: 'unchanged' });
    } else if (opts.onlyMissing) {
      // User edits to the main component (including renames) are preserved.
      components.push({ id: kc.id, name: existing.name, status: 'diverged' });
    } else {
      names.set(kc.id, name);
      ops.push({
        type: 'updateComponent',
        componentId: kc.id,
        name,
        description: desired.description ?? null,
        kit: kitName,
        props: desired.props,
        variants: desired.variants,
        root: desired.root,
      });
      components.push({ id: kc.id, name, status: 'updated' });
    }
  }
  return { ops, components, skipped, tokensAdded };
}
