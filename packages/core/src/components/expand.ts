/**
 * Expansão de instâncias de componentes (ver `docs/COMPONENTES.md`, seção Expansão).
 *
 * `expandInstance` devolve a árvore concreta de uma instância; `expandDocument` devolve o
 * documento com todas as instâncias expandidas, com compartilhamento estrutural (mesmos objetos
 * onde não há instância) e cache. As árvores devolvidas são compartilhadas pelo cache: trate-as
 * como imutáveis (clone antes de mutar).
 */
import { cssValueProblem } from '../styles.js';
import { vectorToSvg } from '../vector/svg.js';
import type {
  ComponentDef,
  ComponentVariant,
  Document,
  Node,
  NodeOverride,
  PropDef,
  PropValue,
} from '../types.js';

/** Profundidade máxima de instâncias aninhadas na expansão. */
export const MAX_INSTANCE_DEPTH = 16;

/**
 * Máximo de nós que a expansão de uma instância pode gerar. A profundidade sozinha não limita um
 * DAG largo (C1 com 4 instâncias de C2, C2 com 4 de C3...: 4^10 nós com 10 níveis); acima disso a
 * instância vira o aviso "Componente grande demais".
 */
export const MAX_EXPANDED_NODES = 50_000;

/** Texto do contêiner de aviso (componente ausente, ciclo ou profundidade excessiva). */
export const MISSING_COMPONENT_TEXT = 'Componente ausente';

/** Texto do contêiner de aviso quando a expansão passaria de `MAX_EXPANDED_NODES`. */
export const TOO_LARGE_COMPONENT_TEXT = 'Componente grande demais';

/** Atributo de marcação dos contêineres de slot (no principal e na instância). */
export const SLOT_ATTR = 'data-slot';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

/* ---------------- ids virtuais ---------------- */

/** Id expandido de um nó vindo da árvore de um principal (`<instância>/<caminho>`). */
export function isVirtualId(id: string): boolean {
  return id.includes('/');
}

/**
 * Separa um id virtual em instância dona (primeiro segmento, nó real) e caminho de override
 * (resto). `null` se o id não é virtual.
 */
export function splitVirtualId(
  id: string,
): { instanceId: string; path: string; segments: string[] } | null {
  const i = id.indexOf('/');
  if (i <= 0 || i === id.length - 1) return null;
  const path = id.slice(i + 1);
  return { instanceId: id.slice(0, i), path, segments: path.split('/') };
}

/* ---------------- índices (cache por array de componentes) ---------------- */

const EMPTY: ComponentDef[] = [];
const byIdCache = new WeakMap<ComponentDef[], Map<string, ComponentDef>>();
const nodeOwnerCache = new WeakMap<ComponentDef[], Map<string, string>>();
const sizeCache = new WeakMap<ComponentDef[], Map<string, number>>();

function componentMap(doc: Document): Map<string, ComponentDef> {
  const list = doc.components ?? EMPTY;
  let map = byIdCache.get(list);
  if (!map) {
    map = new Map(list.map((c) => [c.id, c]));
    byIdCache.set(list, map);
  }
  return map;
}

/** Componente pelo id exato. */
export function getComponent(
  doc: Document,
  componentId: string | undefined,
): ComponentDef | undefined {
  return componentId ? componentMap(doc).get(componentId) : undefined;
}

/** Mapa id de nó → id do componente dono, para os nós das raízes dos principais. */
export function componentNodeIndex(doc: Document): Map<string, string> {
  const list = doc.components ?? EMPTY;
  let map = nodeOwnerCache.get(list);
  if (!map) {
    map = new Map();
    for (const c of list) eachNode(c.root, (n) => void map!.set(n.id, c.id));
    nodeOwnerCache.set(list, map);
  }
  return map;
}

/** Ids de todos os nós das raízes dos componentes (opcionalmente sem um componente). */
export function componentNodeIds(doc: Document, exceptComponentId?: string): string[] {
  const out: string[] = [];
  for (const c of doc.components ?? []) {
    if (c.id === exceptComponentId) continue;
    eachNode(c.root, (n) => void out.push(n.id));
  }
  return out;
}

function eachNode(
  node: Node,
  visit: (n: Node, parent: Node | null) => void,
  parent: Node | null = null,
): void {
  visit(node, parent);
  for (const c of node.children) eachNode(c, visit, node);
}

/**
 * Nós que a expansão de uma instância do componente gera (limite superior: conta o conteúdo
 * padrão dos slots e também os contêineres de slot das instâncias aninhadas; ciclos e
 * componentes ausentes contam 1, como o aviso). Memoizado por array de componentes, então é
 * linear no tamanho da biblioteca mesmo num DAG exponencial.
 */
export function expandedSize(doc: Document, componentId: string): number {
  const list = doc.components ?? EMPTY;
  let memo = sizeCache.get(list);
  if (!memo) {
    memo = new Map();
    sizeCache.set(list, memo);
  }
  const visiting = new Set<string>();
  const size = (id: string): number => {
    const hit = memo!.get(id);
    if (hit !== undefined) return hit;
    const def = getComponent(doc, id);
    if (!def || visiting.has(id)) return 1;
    visiting.add(id);
    let total = 0;
    eachNode(def.root, (n) => {
      total += n.type === 'instance' && n.componentId ? size(n.componentId) : 1;
    });
    visiting.delete(id);
    memo!.set(id, total);
    return total;
  };
  return size(componentId);
}

/** Busca por id numa árvore (pré-ordem). */
export function findInTree(root: Node, id: string): Node | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findInTree(c, id);
    if (f) return f;
  }
  return undefined;
}

/**
 * Componente por referência: id exato, `kit/Nome` (ex. `shadcn-like/Button`) ou nome sem
 * diferenciar maiúsculas.
 */
export function findComponent(doc: Document, ref: string): ComponentDef | undefined {
  const list = doc.components ?? [];
  const byId = getComponent(doc, ref);
  if (byId) return byId;
  const r = ref.trim();
  const slash = r.lastIndexOf('/');
  if (slash > 0) {
    const kit = r.slice(0, slash).toLowerCase();
    const name = r.slice(slash + 1).toLowerCase();
    const hit = list.find((c) => c.kit?.toLowerCase() === kit && c.name.toLowerCase() === name);
    if (hit) return hit;
  }
  const lower = r.toLowerCase();
  return list.find((c) => c.name.toLowerCase() === lower);
}

/** Localização de um nó real dentro da raiz de um principal. */
export interface ComponentNodePath {
  component: ComponentDef;
  node: Node;
  /** Pai imediato; `null` para a raiz do principal. */
  parent: Node | null;
  /** Índice em `parent.children` (0 na raiz). */
  index: number;
  /** Ancestrais, da raiz do principal até o pai imediato. */
  ancestors: Node[];
}

/** Acha um nó real dentro de `components[].root` (ou `undefined`). */
export function findComponentNode(doc: Document, nodeId: string): ComponentNodePath | undefined {
  const cid = componentNodeIndex(doc).get(nodeId);
  const component = getComponent(doc, cid);
  if (!component) return undefined;
  const search = (
    node: Node,
    parent: Node | null,
    index: number,
    ancestors: Node[],
  ): ComponentNodePath | undefined => {
    if (node.id === nodeId) return { component, node, parent, index, ancestors };
    for (let i = 0; i < node.children.length; i++) {
      const f = search(node.children[i], node, i, [...ancestors, node]);
      if (f) return f;
    }
    return undefined;
  };
  return search(component.root, null, 0, []);
}

/** Instância encontrada no documento: numa página ou dentro da raiz de outro principal. */
export interface InstanceRef {
  node: Node;
  /** Página onde a instância está (ausente quando está num principal). */
  pageId?: string;
  /** Principal que contém a instância (ausente quando está numa página). */
  ownerComponentId?: string;
}

/** Instâncias do componente nas páginas e nas raízes dos outros principais. */
export function listInstances(doc: Document, componentId: string): InstanceRef[] {
  const out: InstanceRef[] = [];
  for (const page of doc.pages) {
    for (const f of page.frames) {
      eachNode(f, (n) => {
        if (n.type === 'instance' && n.componentId === componentId)
          out.push({ node: n, pageId: page.id });
      });
    }
  }
  for (const c of doc.components ?? []) {
    eachNode(c.root, (n) => {
      if (n.type === 'instance' && n.componentId === componentId) {
        out.push({ node: n, ownerComponentId: c.id });
      }
    });
  }
  return out;
}

/** Nó instância real (página ou principal) pelo id. */
export function findInstanceNode(doc: Document, nodeId: string): Node | undefined {
  for (const page of doc.pages) {
    for (const f of page.frames) {
      const n = findInTree(f, nodeId);
      if (n) return n.type === 'instance' ? n : undefined;
    }
  }
  const p = findComponentNode(doc, nodeId);
  return p?.node.type === 'instance' ? p.node : undefined;
}

/* ---------------- props, placeholders e overrides ---------------- */

function fallbackDefault(p: PropDef): PropValue | undefined {
  switch (p.type) {
    case 'slot':
      return undefined;
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return p.options?.[0] ?? '';
    default:
      return '';
  }
}

/**
 * Props efetivas: padrões do componente (sem padrão: `''`, `0`, `false` ou a primeira opção do
 * enum) com os valores da instância por cima. Slots não entram.
 */
export function resolveProps(
  def: ComponentDef,
  props?: Record<string, PropValue>,
): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  const slots = new Set<string>();
  for (const p of def.props) {
    if (p.type === 'slot') {
      slots.add(p.name);
      continue;
    }
    const v = p.default ?? fallbackDefault(p);
    if (v !== undefined) out[p.name] = v;
  }
  for (const [k, v] of Object.entries(props ?? {})) if (!slots.has(k)) out[k] = v;
  return out;
}

/** Substitui `{{prop}}` pelo valor (como string); placeholders desconhecidos ficam. */
export function substitutePlaceholders(value: string, props: Record<string, PropValue>): string {
  if (!value.includes('{{')) return value;
  return value.replace(PLACEHOLDER_RE, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(props, name) ? String(props[name]) : m,
  );
}

/** Nomes dos placeholders `{{nome}}` presentes no texto, na ordem. */
export function placeholderNames(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

function substStyle(
  style: Record<string, string>,
  props: Record<string, PropValue>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(style)) {
    const nv = substitutePlaceholders(v, props);
    // O valor final precisa continuar seguro (a prop pode trazer qualquer texto).
    if (nv === v || (nv.trim() !== '' && cssValueProblem(nv) === null)) out[k] = nv;
  }
  return out;
}

function substStates(
  states: Record<string, Record<string, string>>,
  props: Record<string, PropValue>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [k, st] of Object.entries(states)) out[k] = substStyle(st, props);
  return out;
}

function substAttrs(
  attrs: Record<string, string>,
  props: Record<string, PropValue>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = substitutePlaceholders(v, props);
  return out;
}

function substPropValues(
  p: Record<string, PropValue>,
  props: Record<string, PropValue>,
): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [k, v] of Object.entries(p))
    out[k] = typeof v === 'string' ? substitutePlaceholders(v, props) : v;
  return out;
}

function substNode(n: Node, props: Record<string, PropValue>): void {
  if (n.text !== undefined) n.text = substitutePlaceholders(n.text, props);
  if (n.src !== undefined) n.src = substitutePlaceholders(n.src, props);
  n.attrs = substAttrs(n.attrs, props);
  n.style = substStyle(n.style, props);
  if (n.states) n.states = substStates(n.states, props);
  if (n.type === 'instance') {
    if (n.props) n.props = substPropValues(n.props, props);
    if (n.overrides) {
      const ovs: Record<string, NodeOverride> = {};
      for (const [k, ov] of Object.entries(n.overrides)) ovs[k] = substOverride(ov, props);
      n.overrides = ovs;
    }
  }
}

function substOverride(ov: NodeOverride, props: Record<string, PropValue>): NodeOverride {
  const out: NodeOverride = { ...ov };
  if (ov.style) out.style = substStyle(ov.style, props);
  if (ov.text !== undefined) out.text = substitutePlaceholders(ov.text, props);
  if (ov.attrs) out.attrs = substAttrs(ov.attrs, props);
  if (ov.states) out.states = substStates(ov.states, props);
  if (ov.src !== undefined) out.src = substitutePlaceholders(ov.src, props);
  if (ov.props) out.props = substPropValues(ov.props, props);
  return out;
}

function mergeStates(
  base: Record<string, Record<string, string>> | undefined,
  extra: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(base ?? {})) out[k] = { ...v };
  for (const [k, v] of Object.entries(extra)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}

/**
 * Aplica uma sobrescrita ao nó (mutando). `unsetStyle` remove antes de mesclar `style`; `src`
 * só vale em imagem, `svg`/`vector` em nó svg, `effect`/`video`/`embed` no nó do mesmo tipo,
 * `data`/`dataSource` em repetidor e `props` em instância. Os objetos das sobrescritas são
 * compartilhados com a árvore expandida (imutável, como o resto do cache).
 */
export function applyOverride(n: Node, ov: NodeOverride): void {
  if (ov.unsetStyle || ov.style) {
    const style = { ...n.style };
    for (const k of ov.unsetStyle ?? []) delete style[k];
    Object.assign(style, ov.style ?? {});
    n.style = style;
  }
  if (ov.text !== undefined) n.text = ov.text;
  if (ov.attrs) n.attrs = { ...n.attrs, ...ov.attrs };
  if (ov.hidden !== undefined) n.hidden = ov.hidden;
  if (ov.classes !== undefined) n.classes = ov.classes;
  if (ov.states) n.states = mergeStates(n.states, ov.states);
  if (ov.src !== undefined && n.type === 'image') n.src = ov.src;
  if (n.type === 'svg') {
    if (ov.vector) {
      n.vector = ov.vector;
      n.svg = ov.svg ?? vectorToSvg(ov.vector);
    } else if (ov.svg !== undefined) {
      // markup sobrescrito sem vetor: o vetor do principal não descreve mais o desenho
      n.svg = ov.svg;
      delete n.vector;
    }
  }
  if (ov.effect && n.type === 'effect') n.effect = ov.effect;
  if (ov.video && n.type === 'video') n.video = ov.video;
  if (ov.embed && n.type === 'embed') n.embed = ov.embed;
  if (n.type === 'repeater') {
    if (ov.data) n.data = ov.data;
    if (ov.dataSource) n.dataSource = ov.dataSource;
  }
  if (ov.props && n.type === 'instance') n.props = { ...(n.props ?? {}), ...ov.props };
}

/** Sobrescrita equivalente a aplicar `a` e depois `b`. */
export function mergeOverride(a: NodeOverride, b: NodeOverride): NodeOverride {
  const out: NodeOverride = { ...a, ...b };
  if (a.style || b.style || b.unsetStyle) {
    const style: Record<string, string> = { ...(a.style ?? {}) };
    for (const k of b.unsetStyle ?? []) delete style[k];
    Object.assign(style, b.style ?? {});
    if (Object.keys(style).length > 0) out.style = style;
    else delete out.style;
  }
  if (a.unsetStyle || b.unsetStyle) {
    out.unsetStyle = [...new Set([...(a.unsetStyle ?? []), ...(b.unsetStyle ?? [])])];
  }
  if (a.attrs || b.attrs) out.attrs = { ...(a.attrs ?? {}), ...(b.attrs ?? {}) };
  if (a.states || b.states) out.states = mergeStates(a.states, b.states ?? {});
  if (a.props || b.props) out.props = { ...(a.props ?? {}), ...(b.props ?? {}) };
  // vetor e markup andam juntos: um `svg` posterior sem vetor descarta o vetor anterior
  if (b.svg !== undefined && !b.vector) delete out.vector;
  return out;
}

/** Variante sem condição (`when` vazio, recusada pelo schema e pelas ops) nunca se aplica. */
function variantMatches(v: ComponentVariant, props: Record<string, PropValue>): boolean {
  const when = Object.entries(v.when);
  return when.length > 0 && when.every(([k, val]) => String(props[k]) === String(val));
}

/* ---------------- expansão ---------------- */

export interface ExpandOptions {
  /** `false` mantém as instâncias aninhadas como instâncias (overrides herdados mesclados). Padrão `true`. */
  deep?: boolean;
  /** Recebe os avisos (componente ausente, ciclo, profundidade, tamanho). Desliga o cache. */
  warnings?: string[];
}

interface Ctx {
  doc: Document;
  stack: string[];
  deep: boolean;
  warnings?: string[];
}

function copyNode(m: Node): Node {
  const out: Node = { ...m, attrs: { ...m.attrs }, style: { ...m.style }, children: [] };
  if (m.states) out.states = mergeStates(m.states, {});
  if (m.props) out.props = { ...m.props };
  if (m.position) out.position = { ...m.position };
  return out;
}

function placeholder(
  ctx: Ctx,
  inst: Node,
  rootId: string,
  reason: string,
  text = MISSING_COMPONENT_TEXT,
): Node {
  ctx.warnings?.push(`${inst.id}: ${reason}`);
  const node: Node = {
    id: rootId,
    type: 'element',
    name: inst.name,
    tag: 'div',
    attrs: { 'data-missing-component': inst.componentId ?? '', title: reason },
    style: {
      ...inst.style,
      border: '1px dashed #e17055',
      padding: '8px',
      color: '#e17055',
      'font-size': '12px',
      'font-family': 'sans-serif',
    },
    children: [
      {
        id: `${rootId}/__missing`,
        type: 'text',
        name: 'Aviso',
        tag: 'span',
        attrs: {},
        style: {},
        text,
        children: [],
        locked: true,
        hidden: false,
      },
    ],
    locked: inst.locked,
    hidden: inst.hidden,
  };
  if (inst.componentId) node.componentId = inst.componentId;
  if (inst.position) node.position = { ...inst.position };
  return node;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function mapSame<T>(list: T[], fn: (t: T) => T): T[] {
  let changed = false;
  const out = list.map((t) => {
    const r = fn(t);
    if (r !== t) changed = true;
    return r;
  });
  return changed ? out : list;
}

/**
 * Expande `inst` com id de raiz `rootId`. `slotChild` materializa o conteúdo de slot (filhos
 * dos contêineres da instância), que pertence ao contexto de fora.
 */
function expandInst(ctx: Ctx, inst: Node, rootId: string, slotChild: (n: Node) => Node): Node {
  const def = getComponent(ctx.doc, inst.componentId);
  if (!def)
    return placeholder(ctx, inst, rootId, `componente "${inst.componentId ?? ''}" não encontrado`);
  if (ctx.stack.includes(def.id)) {
    return placeholder(
      ctx,
      inst,
      rootId,
      `ciclo de componentes (${[...ctx.stack, def.id].join(' → ')})`,
    );
  }
  if (ctx.stack.length >= MAX_INSTANCE_DEPTH) {
    return placeholder(
      ctx,
      inst,
      rootId,
      `profundidade de instâncias maior que ${MAX_INSTANCE_DEPTH}`,
    );
  }
  if (ctx.deep) {
    const size = expandedSize(ctx.doc, def.id);
    if (size > MAX_EXPANDED_NODES) {
      return placeholder(
        ctx,
        inst,
        rootId,
        `componente "${def.name}" grande demais (${size > 1e9 ? 'mais de 1 bilhão de' : `cerca de ${size}`} nós expandidos; limite ${MAX_EXPANDED_NODES})`,
        TOO_LARGE_COMPONENT_TEXT,
      );
    }
  }
  const inner: Ctx = { ...ctx, stack: [...ctx.stack, def.id] };
  const props = resolveProps(def, inst.props);
  const rootKey = def.root.id;

  // Overrides locais (nós deste principal) e aninhados (repassados às instâncias aninhadas).
  const local = new Map<string, NodeOverride[]>();
  const nested = new Map<string, [string, NodeOverride][]>();
  const add = (rawKey: string, ov: NodeOverride): void => {
    const key = rawKey === '' ? rootKey : rawKey;
    const i = key.indexOf('/');
    if (i < 0) push(local, key, ov);
    else push(nested, key.slice(0, i), [key.slice(i + 1), ov]);
  };
  for (const v of def.variants) {
    if (!variantMatches(v, props)) continue;
    for (const [k, ov] of Object.entries(v.overrides)) add(k, substOverride(ov, props));
  }
  for (const [k, ov] of Object.entries(inst.overrides ?? {})) add(k, ov);

  const slotNames = new Set(def.props.filter((p) => p.type === 'slot').map((p) => p.name));
  const containers = new Map<string, Node>();
  for (const c of inst.children) {
    const s = c.attrs?.[SLOT_ATTR];
    if (s && slotNames.has(s) && !containers.has(s)) containers.set(s, c);
  }

  // Slots já renderizados: um contêiner do principal por slot (repetições usam o padrão).
  const usedSlots = new Set<string>();
  /** `hostChild`: filho direto de uma instância aninhada (contêiner de slot dela, não deste). */
  const build = (m: Node, isRoot: boolean, hostChild = false): Node => {
    const out = copyNode(m);
    out.id = isRoot ? rootId : `${rootId}/${m.id}`;
    substNode(out, props);
    for (const ov of local.get(m.id) ?? []) applyOverride(out, ov);
    const slot = isRoot || hostChild ? undefined : m.attrs[SLOT_ATTR];
    const isSlot = slot !== undefined && slotNames.has(slot) && !usedSlots.has(slot);
    if (isSlot) usedSlots.add(slot);
    const c = isSlot ? containers.get(slot) : undefined;
    if (c) {
      // Contêiner de slot: id do contêiner real da instância e o estilo dele por cima.
      out.id = c.id;
      out.style = { ...out.style, ...c.style };
      out.attrs = { ...out.attrs, ...c.attrs };
      if (c.states) out.states = mergeStates(out.states, c.states);
      if (c.classes) out.classes = c.classes;
      if (c.hidden) out.hidden = true;
      if (c.locked) out.locked = true;
    }
    out.children =
      c && c.children.length > 0
        ? c.children.map(slotChild)
        : m.children.map((ch) => build(ch, false, m.type === 'instance'));
    if (m.type === 'instance') {
      const pairs = nested.get(m.id);
      if (pairs) {
        const merged: Record<string, NodeOverride> = { ...(out.overrides ?? {}) };
        for (const [k, ov] of pairs) merged[k] = merged[k] ? mergeOverride(merged[k], ov) : ov;
        out.overrides = merged;
      }
      return ctx.deep ? expandInst(inner, out, out.id, (n) => n) : out;
    }
    return out;
  };

  const root = build(def.root, true);
  // Raiz: estilo/atributos/estados/classes da instância por cima; posição, nome e flags dela.
  root.id = rootId;
  root.style = { ...root.style, ...inst.style };
  root.attrs = { ...root.attrs, ...inst.attrs };
  if (inst.states) root.states = mergeStates(root.states, inst.states);
  if (inst.classes) root.classes = inst.classes;
  root.name = inst.name;
  root.locked = inst.locked;
  root.hidden = inst.hidden || root.hidden;
  if (inst.position) root.position = { ...inst.position };
  else delete root.position;
  root.componentId = def.id;
  if (inst.props && Object.keys(inst.props).length > 0) root.props = { ...inst.props };
  else delete root.props;
  delete root.overrides;
  return root;
}

// Cache por instância: objeto do nó → (array de componentes → árvore expandida).
const instanceCache = new WeakMap<Node, WeakMap<ComponentDef[], Node>>();

function cachedExpand(ctx: Ctx, inst: Node): Node {
  const list = ctx.doc.components ?? EMPTY;
  let byList = instanceCache.get(inst);
  const hit = byList?.get(list);
  if (hit) return hit;
  const out = expandInst(ctx, inst, inst.id, (n) => expandTree(ctx, n));
  if (!byList) {
    byList = new WeakMap();
    instanceCache.set(inst, byList);
  }
  byList.set(list, out);
  return out;
}

function expandTree(ctx: Ctx, n: Node): Node {
  if (n.type === 'instance') {
    if (ctx.deep) {
      if (ctx.stack.length === 0 && !ctx.warnings) return cachedExpand(ctx, n);
      return expandInst(ctx, n, n.id, (ch) => expandTree(ctx, ch));
    }
  }
  if (n.children.length === 0) return n;
  const kids = mapSame(n.children, (ch) => expandTree(ctx, ch));
  return kids === n.children ? n : { ...n, children: kids };
}

function makeCtx(doc: Document, opts: ExpandOptions = {}): Ctx {
  const ctx: Ctx = { doc, stack: [], deep: opts.deep !== false };
  if (opts.warnings) ctx.warnings = opts.warnings;
  return ctx;
}

/**
 * Árvore concreta da instância: raiz com o id da instância (tipo da raiz do principal, com
 * `componentId`/`props` como marcador), nós do principal com ids virtuais `<instância>/<caminho>`,
 * contêineres e conteúdo de slot com os ids reais.
 */
export function expandInstance(doc: Document, instance: Node, opts: ExpandOptions = {}): Node {
  const ctx = makeCtx(doc, opts);
  if (instance.type !== 'instance') return expandTree(ctx, instance);
  if (ctx.deep && !ctx.warnings) return cachedExpand(ctx, instance);
  return expandInst(ctx, instance, instance.id, (ch) => expandTree(ctx, ch));
}

/** Expande as instâncias da subárvore (mesmo objeto quando não há instância). */
export function expandNodeTree(doc: Document, node: Node, opts: ExpandOptions = {}): Node {
  return expandTree(makeCtx(doc, opts), node);
}

const docCache = new WeakMap<Document, Document>();

/**
 * Documento com todas as instâncias das páginas expandidas. Páginas e nós sem instância são os
 * mesmos objetos; sem instâncias devolve o próprio `doc`. Cache por documento.
 */
export function expandDocument(doc: Document): Document {
  const hit = docCache.get(doc);
  if (hit) return hit;
  const ctx = makeCtx(doc);
  let changed = false;
  const pages = doc.pages.map((p) => {
    const frames = mapSame(p.frames, (f) => expandTree(ctx, f));
    if (frames === p.frames) return p;
    changed = true;
    return { ...p, frames };
  });
  const out = changed ? { ...doc, pages } : doc;
  docCache.set(doc, out);
  return out;
}

/** Componentes usados diretamente pela árvore (ids das instâncias). */
export function componentDependencies(root: Node): string[] {
  const out = new Set<string>();
  eachNode(root, (n) => {
    if (n.type === 'instance' && n.componentId) out.add(n.componentId);
  });
  return [...out];
}

/** Caminho de um ciclo que passa por `componentId` (ex. `[A, B, A]`) ou `null`. */
export function findComponentCycle(doc: Document, componentId: string): string[] | null {
  const visit = (id: string, path: string[]): string[] | null => {
    const def = getComponent(doc, id);
    if (!def) return null;
    for (const dep of componentDependencies(def.root)) {
      if (dep === componentId) return [...path, dep];
      if (path.includes(dep)) continue;
      const r = visit(dep, [...path, dep]);
      if (r) return r;
    }
    return null;
  };
  return visit(componentId, [componentId]);
}
