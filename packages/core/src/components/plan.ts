/**
 * Planejadores de componentes (ver `docs/COMPONENTES.md`, seção Ops): funções puras que leem o
 * documento e devolvem as ops primitivas (aplicadas pelo chamador como uma entrada de histórico).
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

/** Nome livre entre `taken` (sem diferenciar maiúsculas): `Nome`, `Nome 2`, `Nome 3`... */
export function uniqueComponentName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const name = base.trim() || 'Componente';
  if (!set.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
}

function otherNames(doc: Document, exceptId?: string): string[] {
  return (doc.components ?? []).filter((c) => c.id !== exceptId).map((c) => c.name);
}

/** Instância real (página ou raiz de um principal) pelo id; recusa ids virtuais. */
function requireRealInstance(doc: Document, nodeId: string, action: string): Node {
  if (isVirtualId(nodeId)) {
    fail(
      `O nó "${nodeId}" é interno de outra instância: não dá para ${action} (edite o principal ou destaque a instância de fora)`,
    );
  }
  const node = findNode(doc, nodeId)?.node ?? componentNodeById(doc, nodeId);
  if (!node) fail(`Nó "${nodeId}" não encontrado`);
  if (node.type !== 'instance') fail(`O nó "${nodeId}" não é uma instância de componente`);
  return node;
}

function requireDef(doc: Document, inst: Node): ComponentDef {
  const def = getComponent(doc, inst.componentId);
  if (!def) fail(`O componente "${inst.componentId ?? ''}" da instância "${inst.id}" não existe`);
  return def;
}

/* ---------------- createComponent ---------------- */

/**
 * Propriedades que posicionam o nó no pai: saem da raiz do principal e ficam no estilo da
 * instância (cada instância se posiciona onde está).
 */
const PLACEMENT_RE =
  /^(position|top|right|bottom|left|inset(-.+)?|z-index|margin(-.+)?|flex|flex-grow|flex-shrink|flex-basis|align-self|justify-self|place-self|order|grid-area|grid-column(-.+)?|grid-row(-.+)?)$/;

export function isPlacementProperty(prop: string): boolean {
  return PLACEMENT_RE.test(prop);
}

/** Alvo de `bind`: o texto do nó, um atributo (`attr:href`) ou uma propriedade de estilo (`style:color`). */
export type PropBindTarget = 'text' | `attr:${string}` | `style:${string}`;

/** Prop na entrada de `createComponentOps`: `bind` troca o valor atual do nó por `{{nome}}`. */
export interface PropInput extends PropDef {
  bind?: { nodeId: string; target: PropBindTarget };
}

export interface CreateComponentOptions {
  name?: string;
  description?: string;
  /** Props declaradas; as não declaradas são inferidas (`{{nome}}` → string, `data-slot` → slot). */
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
    fail(`A prop "${def.name}" é um slot: marque o contêiner com data-slot em vez de "bind"`);
  const target = findInTree(root, bind.nodeId);
  if (!target)
    fail(`O nó "${bind.nodeId}" (bind da prop "${def.name}") não está no nó do componente`);
  const ph = `{{${def.name}}}`;
  let current: string | undefined;
  if (bind.target === 'text') {
    current = target.text;
    if (current === undefined)
      fail(`O nó "${bind.nodeId}" não tem texto (bind da prop "${def.name}")`);
    target.text = ph;
  } else if (bind.target.startsWith('attr:')) {
    const attr = bind.target.slice(5).trim();
    current = target.attrs[attr];
    if (current === undefined) fail(`O nó "${bind.nodeId}" não tem o atributo "${attr}"`);
    target.attrs = { ...target.attrs, [attr]: ph };
  } else if (bind.target.startsWith('style:')) {
    const prop = toKebabCase(bind.target.slice(6).trim());
    current = target.style[prop];
    if (current === undefined) {
      fail(
        `O nó "${bind.nodeId}" não tem "${prop}" no estilo${isPlacementProperty(prop) && target === root ? ' (propriedades de posicionamento ficam na instância)' : ''}`,
      );
    }
    target.style = { ...target.style, [prop]: ph };
  } else {
    fail(`Alvo de bind inválido: "${String(bind.target)}" (use text, attr:<nome> ou style:<prop>)`);
  }
  if (def.default === undefined) {
    if (def.type === 'number' && Number.isFinite(Number(current))) def.default = Number(current);
    else if (def.type === 'boolean') def.default = current === 'true';
    else def.default = current;
  }
  return def;
}

/** Props inferidas da árvore: `{{nome}}` (string, padrão `''`) e `data-slot` (slot). */
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
 * Transforma o nó num componente: a raiz é o clone do nó com os mesmos ids (sem `position`,
 * sem as propriedades de posicionamento no pai) e o nó vira a primeira instância (herda
 * posição, nome, `locked`, `hidden` e o posicionamento). Ops: `replaceNode` (nó → instância)
 * e `addComponent` (nessa ordem: os ids da raiz só ficam livres depois da troca).
 */
export function createComponentOps(
  doc: Document,
  nodeId: string,
  opts: CreateComponentOptions = {},
): { ops: Op[]; componentId: string; instanceId: string } {
  if (isVirtualId(nodeId)) {
    fail(`O nó "${nodeId}" é interno de uma instância: destaque a instância ou edite o principal`);
  }
  if (isComponentNodeId(doc, nodeId)) {
    fail(
      `O nó "${nodeId}" está dentro de um principal: crie o componente a partir de nós das páginas`,
    );
  }
  const path = findNode(doc, nodeId);
  if (!path) fail(`Nó "${nodeId}" não encontrado`);
  const node = path.node;
  if (!path.parent || node.type === 'frame') {
    fail(`O nó "${nodeId}" é um frame raiz: crie o componente a partir de um nó dentro do frame`);
  }
  if (node.type === 'instance') fail(`O nó "${nodeId}" já é uma instância de componente`);

  const componentId = opts.componentId ?? newComponentId();
  if (getComponent(doc, componentId)) fail(`Já existe um componente com id "${componentId}"`);
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
    if (!PROP_NAME_RE.test(p.name.trim())) fail(`Nome de prop inválido: "${p.name}"`);
    if (props.some((x) => x.name === p.name.trim())) fail(`Prop duplicada: "${p.name}"`);
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
  for (const slot of slotNames(component)) {
    let id = newNodeId('element');
    while (taken.has(id)) id = newNodeId('element');
    taken.add(id);
    instance.children.push(slotContainerNode(id, slot));
  }
  return {
    ops: [
      { type: 'replaceNode', nodeId, node: instance },
      { type: 'addComponent', component },
    ],
    componentId,
    instanceId,
  };
}

/* ---------------- instâncias ---------------- */

export interface InstanceOptions {
  props?: Record<string, PropValue>;
  /** Conteúdo por slot (vai nos contêineres `data-slot`; slots omitidos usam o padrão). */
  slots?: Record<string, Node[]>;
  name?: string;
  style?: Record<string, string>;
  id?: string;
}

/**
 * Nó instância pronto para `createNode`: props validadas (as iguais ao padrão são omitidas) e um
 * contêiner por prop `slot` (`{ type:'element', tag:'div', name:'Slot <nome>', attrs:{'data-slot'} }`).
 * `componentId` aceita também o nome ou `kit/Nome`.
 */
export function instanceNodeFor(
  doc: Document,
  componentId: string,
  opts: InstanceOptions = {},
): Node {
  const def = getComponent(doc, componentId) ?? findComponent(doc, componentId);
  if (!def) fail(`Componente "${componentId}" não encontrado`);
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
        `O componente "${def.name}" não tem o slot "${k}"${slots.length > 0 ? ` (slots: ${slots.join(', ')})` : ''}`,
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
 * Destaca a instância: `replaceNode` pela árvore concreta. Nós vindos do principal (ids
 * virtuais) e a raiz ganham ids novos reais (prefixo do tipo); contêineres e conteúdo de slot
 * mantêm os ids; instâncias aninhadas continuam instâncias, com os overrides herdados.
 */
export function detachInstanceOps(doc: Document, nodeId: string): Op[] {
  const inst = requireRealInstance(doc, nodeId, 'destacar');
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
 * Grava os overrides da instância no principal (nós do principal e overrides das instâncias
 * aninhadas nele) e limpa os da instância. Overrides de nós que não existem mais são ignorados.
 * As variantes do principal continuam valendo por cima do que foi gravado.
 */
export function pushOverridesToMainOps(doc: Document, nodeId: string): Op[] {
  const inst = requireRealInstance(doc, nodeId, 'enviar ao principal');
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

/** Remove os overrides da instância (para uma instância aninhada, use o id virtual dela). */
export function resetInstanceOps(doc: Document, nodeId: string): Op[] {
  if (!isVirtualId(nodeId)) requireRealInstance(doc, nodeId, 'restaurar');
  return [{ type: 'setInstanceOverrides', changes: [{ nodeId, overrides: null }] }];
}

/* ---------------- importKit ---------------- */

export interface ImportKitResult {
  ops: Op[];
  components: { id: string; name: string; status: 'added' | 'updated' | 'unchanged' }[];
  tokensAdded: string[];
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

/** Componentes do kit com as dependências (instâncias de outros componentes do kit) antes. */
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
 * Importa os componentes de um kit (documento `*.mockup.json` com `components`):
 * - mesmo id já no documento: `updateComponent` se mudou (senão `unchanged`); id novo: `addComponent`
 *   (dependências antes), com `kit` preenchido e nome único;
 * - ids de nós que colidem com nós de outro dono ganham ids derivados (determinísticos, então
 *   importar de novo não muda nada), remapeando as chaves de variantes e overrides;
 * - tokens (com metadados) que faltam e as sobrescritas dos temas (ex. `dark`) desses tokens.
 */
export function importKitOps(doc: Document, kit: Document, kitName: string): ImportKitResult {
  const ops: Op[] = [];

  // Tokens que faltam, metadados e sobrescritas de tema deles (como planShadcnTokens).
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

  // Componentes.
  const kitList = kit.components ?? [];
  const kitById = new Map(kitList.map((c) => [c.id, c]));
  const remaps = new Map<string, Map<string, string>>();
  const assigned = new Set<string>();
  const names = new Map<string, string>(
    (doc.components ?? []).map((c) => [c.id, c.name] as [string, string]),
  );
  const components: ImportKitResult['components'] = [];

  /** Caminho de override relativo ao componente `cid` com os ids remapeados. */
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
    const takenNames = [...names].filter(([id]) => id !== kc.id).map(([, n]) => n);
    const name = uniqueComponentName(kc.name, takenNames);
    names.set(kc.id, name);
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
      ops.push({ type: 'addComponent', component: desired });
      components.push({ id: kc.id, name, status: 'added' });
    } else if (stableStringify(existing) === stableStringify(desired)) {
      components.push({ id: kc.id, name, status: 'unchanged' });
    } else {
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
  return { ops, components, tokensAdded };
}
