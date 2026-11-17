import { deepClone } from './clone.js';
import { cloneNodeWithNewIds, collectIds, findNode, findPage, walk } from './document.js';
import { parseOp } from './ops.schema.js';
import { TOKEN_NAME_RE, VOID_TAGS, attrNameProblem, nodeTagProblem, normalizeTag } from './tags.js';
import type { ApplyResult, DuplicateNodesOp, Op, StyleChange } from './ops.js';
import { cssValueProblem, isValidCssPropertyName, normalizeStyles, toKebabCase } from './styles.js';
import { normalizeTokenNames } from './schema.js';
import {
  findVarRefs,
  normalizeTokenName,
  renameTokenInClasses,
  renameTokenProblem,
  replaceVarRefs,
} from './tokens.js';
import { sanitizeSvg, setSvgRootAttrs, svgRootAttrs } from './svg.js';
import { normalizeStateKey } from './states.js';
import type { Document, Node, NodePath, Page, Theme, TokenMeta } from './types.js';

type Result = Record<string, unknown> | undefined;
interface Applied {
  inverse: Op[];
  result?: Result;
}

function fail(message: string): never {
  throw new Error(message);
}

function requireNode(doc: Document, id: string): NodePath {
  const path = findNode(doc, id);
  if (!path) fail(`Nó "${id}" não encontrado`);
  return path;
}

function requirePage(doc: Document, id: string): Page {
  const page = findPage(doc, id);
  if (!page) fail(`Página "${id}" não encontrada`);
  return page;
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || index === null) return length;
  if (!Number.isFinite(index)) fail(`Índice inválido: ${String(index)}`);
  return Math.max(0, Math.min(length, Math.floor(index)));
}

function containerArray(path: NodePath): Node[] {
  return path.parent ? path.parent.children : path.page.frames;
}

function assertCanHaveChildren(parent: Node): void {
  if (
    parent.type === 'text' ||
    parent.type === 'image' ||
    parent.type === 'svg' ||
    VOID_TAGS.has(parent.tag)
  ) {
    fail(`O nó "${parent.id}" (${parent.tag}, tipo ${parent.type}) não pode ter filhos`);
  }
}

function normalizeTree(node: Node): Node {
  node.attrs = { ...(node.attrs ?? {}) };
  node.style = normalizeStyles(node.style ?? {});
  node.children = node.children ?? [];
  node.locked = node.locked ?? false;
  node.hidden = node.hidden ?? false;
  node.children.forEach(normalizeTree);
  return node;
}

/** Garante que os ids da subárvore são únicos entre si e em relação ao documento. */
function assertFreshIds(doc: Document, nodes: Node[]): void {
  const existing = new Set(collectIds(doc));
  const seen = new Set<string>();
  for (const root of nodes) {
    walk(root, (n) => {
      if (existing.has(n.id)) fail(`Já existe um nó com id "${n.id}"`);
      if (seen.has(n.id)) fail(`Id duplicado "${n.id}" na subárvore`);
      seen.add(n.id);
    });
  }
}

function resolveContainer(
  d: Document,
  parentId: string | null | undefined,
  pageId: string | undefined,
): Node[] {
  if (parentId) {
    const parent = requireNode(d, parentId).node;
    assertCanHaveChildren(parent);
    return parent.children;
  }
  if (!pageId) fail('Frame raiz exige "pageId" (e parentId nulo)');
  return requirePage(d, pageId).frames;
}

/* ---------------- createNode ---------------- */

function doCreateNode(d: Document, op: Extract<Op, { type: 'createNode' }>): Applied {
  const node = normalizeTree(deepClone(op.node));
  assertFreshIds(d, [node]);
  const arr = resolveContainer(d, op.parentId, op.pageId);
  arr.splice(clampIndex(op.index, arr.length), 0, node);
  return { inverse: [{ type: 'deleteNodes', nodeIds: [node.id] }], result: { nodeIds: [node.id] } };
}

/* ---------------- deleteNodes ---------------- */

function doDeleteNodes(d: Document, op: Extract<Op, { type: 'deleteNodes' }>): Applied {
  const ids = unique(op.nodeIds);
  const idSet = new Set(ids);
  const paths = ids.map((id) => requireNode(d, id));
  const top = paths.filter((p) => !p.ancestors.some((a) => idSet.has(a.id)));
  // Ordem crescente de índice garante restauração correta por pai.
  const ordered = [...top].sort((a, b) => a.index - b.index);
  const inverse: Op[] = ordered.map((p) =>
    p.parent
      ? { type: 'createNode', parentId: p.parent.id, node: p.node, index: p.index }
      : { type: 'createNode', parentId: null, pageId: p.page.id, node: p.node, index: p.index },
  );
  for (const p of top) {
    const arr = containerArray(p);
    arr.splice(arr.indexOf(p.node), 1);
  }
  return { inverse };
}

/* ---------------- moveNodes ---------------- */

function doMoveNodes(d: Document, op: Extract<Op, { type: 'moveNodes' }>): Applied {
  const ids = unique(op.nodeIds);
  const idSet = new Set(ids);
  const paths = ids.map((id) => requireNode(d, id));

  let targetArr: Node[] | undefined;
  if (op.parentId !== undefined) {
    if (op.parentId) {
      const tp = requireNode(d, op.parentId);
      if ([...tp.ancestors, tp.node].some((n) => idSet.has(n.id))) {
        fail(`Não é possível mover "${tp.node.id}" para dentro de si mesmo ou de um descendente`);
      }
      assertCanHaveChildren(tp.node);
      targetArr = tp.node.children;
    } else {
      if (!op.pageId) fail('Mover para a raiz exige "pageId"');
      targetArr = requirePage(d, op.pageId).frames;
    }
  }

  // Registra as origens antes de remover.
  interface Origin {
    parentId: string | null;
    pageId: string;
    childIds: string[];
  }
  const origins = new Map<string, Origin>();
  const info = paths.map((p) => {
    const arr = containerArray(p);
    const key = `${p.page.id}|${p.parent?.id ?? ''}`;
    if (!origins.has(key)) {
      origins.set(key, {
        parentId: p.parent?.id ?? null,
        pageId: p.page.id,
        childIds: arr.map((n) => n.id),
      });
    }
    return { node: p.node, arr };
  });

  for (const { node, arr } of info) arr.splice(arr.indexOf(node), 1);

  const counters = new Map<Node[], number>();
  for (const { node, arr } of info) {
    const dest = targetArr ?? arr;
    const k = counters.get(dest) ?? 0;
    counters.set(dest, k + 1);
    const at = op.index === undefined ? dest.length : clampIndex(op.index + k, dest.length);
    dest.splice(at, 0, node);
  }

  // Inverso: por contêiner de origem, reposiciona todos os filhos originais (devolve os nós
  // movidos e restaura a ordem exata dos irmãos).
  const inverse: Op[] = [];
  for (const o of origins.values()) {
    const base = o.parentId ? { parentId: o.parentId } : { parentId: null, pageId: o.pageId };
    inverse.push({ type: 'moveNodes', nodeIds: o.childIds, index: 0, ...base });
  }
  return { inverse };
}

/* ---------------- updateStyles ---------------- */

function splitSet(
  set: Record<string, string> | undefined,
  unset: string[] | undefined,
): { set: Record<string, string>; unset: string[] } {
  const keep: Record<string, string> = {};
  const remove: string[] = [];
  // Valor vazio em `set` equivale a remover a propriedade.
  for (const [k, v] of Object.entries(set ?? {})) {
    if (v === undefined || v === null || String(v).trim() === '') remove.push(k);
    else keep[k] = v;
  }
  const norm = (k: string): string => {
    const key = toKebabCase(k.trim());
    if (!isValidCssPropertyName(key)) fail(`Nome de propriedade CSS inválido: "${k}"`);
    return key;
  };
  return {
    set: normalizeStyles(keep),
    unset: unique([...remove, ...(unset ?? [])].map(norm)),
  };
}

function doUpdateStyles(d: Document, op: Extract<Op, { type: 'updateStyles' }>): Applied {
  if (!op.changes && !op.nodeIds) fail('updateStyles exige "changes" ou "nodeIds"');
  const changes: StyleChange[] = [...(op.changes ?? [])];
  for (const nodeId of op.nodeIds ?? []) {
    changes.push({ nodeId, set: op.styles, unset: op.unset });
  }
  const inv: StyleChange[] = [];
  for (const ch of changes) {
    const node = requireNode(d, ch.nodeId).node;
    const { set, unset } = splitSet(ch.set, ch.unset);
    const prevSet: Record<string, string> = {};
    const prevUnset: string[] = [];
    for (const k of unique([...unset, ...Object.keys(set)])) {
      if (k in node.style) prevSet[k] = node.style[k];
      else prevUnset.push(k);
    }
    for (const k of unset) delete node.style[k];
    Object.assign(node.style, set);
    inv.push({ nodeId: ch.nodeId, set: prevSet, unset: prevUnset });
  }
  return { inverse: [{ type: 'updateStyles', changes: inv.reverse() }] };
}

/* ---------------- setText / setAttrs / rename / position / flags ---------------- */

function doSetText(d: Document, op: Extract<Op, { type: 'setText' }>): Applied {
  const inv: { nodeId: string; text: string | null }[] = [];
  for (const ch of op.changes) {
    const node = requireNode(d, ch.nodeId).node;
    inv.push({ nodeId: ch.nodeId, text: node.text ?? null });
    if (ch.text === null) delete node.text;
    else node.text = ch.text;
  }
  return { inverse: [{ type: 'setText', changes: inv.reverse() }] };
}

function doSetAttrs(d: Document, op: Extract<Op, { type: 'setAttrs' }>): Applied {
  const inv: { nodeId: string; set: Record<string, string>; unset: string[] }[] = [];
  for (const ch of op.changes) {
    const node = requireNode(d, ch.nodeId).node;
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(ch.set ?? {})) {
      const key = k.trim();
      if (key === 'style') fail('O atributo "style" não é permitido em attrs; use updateStyles');
      if (key === 'class') fail('O atributo "class" não é permitido em attrs; use updateStyles');
      if (!key) fail('Nome de atributo vazio');
      const problem = attrNameProblem(key);
      if (problem) fail(problem);
      set[key] = String(v);
    }
    const unset = unique((ch.unset ?? []).map((k) => k.trim()));
    const prevSet: Record<string, string> = {};
    const prevUnset: string[] = [];
    // Nó svg: os atributos valem para o `<svg>` raiz do markup (é o que export e render usam).
    // Sem markup, a gravação vai para `node.attrs`, então é dele que vem o valor anterior.
    const target = node.type === 'svg' && node.svg ? svgRootAttrs(node.svg) : node.attrs;
    for (const k of unique([...unset, ...Object.keys(set)])) {
      if (k in target) prevSet[k] = target[k]!;
      else prevUnset.push(k);
    }
    if (node.type === 'svg' && node.svg) node.svg = setSvgRootAttrs(node.svg, set, unset);
    else {
      for (const k of unset) delete node.attrs[k];
      Object.assign(node.attrs, set);
    }
    inv.push({ nodeId: ch.nodeId, set: prevSet, unset: prevUnset });
  }
  return { inverse: [{ type: 'setAttrs', changes: inv.reverse() }] };
}

function doRename(d: Document, op: Extract<Op, { type: 'renameNodes' }>): Applied {
  const inv: { nodeId: string; name: string }[] = [];
  for (const ch of op.changes) {
    const node = requireNode(d, ch.nodeId).node;
    inv.push({ nodeId: ch.nodeId, name: node.name });
    node.name = ch.name;
  }
  return { inverse: [{ type: 'renameNodes', changes: inv.reverse() }] };
}

function doSetPosition(d: Document, op: Extract<Op, { type: 'setPosition' }>): Applied {
  const inv: { nodeId: string; position: { x: number; y: number } | null }[] = [];
  for (const ch of op.changes) {
    const node = requireNode(d, ch.nodeId).node;
    let next: { x: number; y: number } | null = null;
    if (ch.position !== null) {
      const { x, y } = ch.position ?? { x: NaN, y: NaN };
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        fail(`Posição inválida para o nó "${ch.nodeId}": x e y devem ser números`);
      }
      next = { x, y };
    }
    inv.push({ nodeId: ch.nodeId, position: node.position ? { ...node.position } : null });
    if (next) node.position = next;
    else delete node.position;
  }
  return { inverse: [{ type: 'setPosition', changes: inv.reverse() }] };
}

function doSetFlags(d: Document, op: Extract<Op, { type: 'setNodeFlags' }>): Applied {
  const inv: { nodeId: string; locked?: boolean; hidden?: boolean }[] = [];
  for (const ch of op.changes) {
    const node = requireNode(d, ch.nodeId).node;
    const prev: { nodeId: string; locked?: boolean; hidden?: boolean } = { nodeId: ch.nodeId };
    if (ch.locked !== undefined) {
      prev.locked = node.locked;
      node.locked = ch.locked;
    }
    if (ch.hidden !== undefined) {
      prev.hidden = node.hidden;
      node.hidden = ch.hidden;
    }
    inv.push(prev);
  }
  return { inverse: [{ type: 'setNodeFlags', changes: inv.reverse() }] };
}

function doSetTag(d: Document, op: Extract<Op, { type: 'setTag' }>): Applied {
  const inv: { nodeId: string; tag: string }[] = [];
  for (const ch of op.changes) {
    const node = requireNode(d, ch.nodeId).node;
    const tag = normalizeTag(ch.tag);
    const problem = nodeTagProblem(node, tag);
    if (problem) fail(problem);
    inv.push({ nodeId: ch.nodeId, tag: node.tag });
    node.tag = tag;
  }
  return { inverse: [{ type: 'setTag', changes: inv.reverse() }] };
}

/* ---------------- duplicateNodes ---------------- */

function doDuplicate(d: Document, op: DuplicateNodesOp): Applied {
  const idMap: Record<string, string> = { ...(op.idMap ?? {}) };
  const newRootIds: string[] = [];
  const clones: Node[] = [];
  const insertions: { path: NodePath; clone: Node }[] = [];
  const ids = unique(op.nodeIds);
  const idSet = new Set(ids);
  const paths = ids.map((id) => requireNode(d, id));
  // Só os nós de topo: ancestral e descendente na mesma chamada duplicariam o descendente duas vezes.
  const top = paths.filter((p) => !p.ancestors.some((a) => idSet.has(a.id)));
  for (const path of top) {
    const { node: clone } = cloneNodeWithNewIds(path.node, idMap);
    if (!path.parent && clone.position) {
      clone.position = { x: clone.position.x + 40, y: clone.position.y };
    }
    clones.push(clone);
    newRootIds.push(clone.id);
    insertions.push({ path, clone });
  }
  assertFreshIds(d, clones);
  for (const { path, clone } of insertions) {
    const arr = containerArray(path);
    arr.splice(arr.indexOf(path.node) + 1, 0, clone);
  }
  const full: DuplicateNodesOp = {
    type: 'duplicateNodes',
    nodeIds: top.map((p) => p.node.id),
    idMap,
  };
  return {
    inverse: [{ type: 'deleteNodes', nodeIds: newRootIds }],
    result: { idMap, nodeIds: newRootIds, op: full },
  };
}

/* ---------------- páginas ---------------- */

function doCreatePage(d: Document, op: Extract<Op, { type: 'createPage' }>): Applied {
  if (findPage(d, op.pageId)) fail(`Já existe uma página com id "${op.pageId}"`);
  const frames = (op.frames ?? []).map((f) => normalizeTree(deepClone(f)));
  assertFreshIds(d, frames);
  const page: Page = {
    id: op.pageId,
    name: op.name,
    background: op.background ?? '#1e1e1e',
    frames,
  };
  d.pages.splice(clampIndex(op.index, d.pages.length), 0, page);
  return {
    inverse: [{ type: 'deletePage', pageId: op.pageId }],
    result: { pageId: op.pageId },
  };
}

function doDeletePage(d: Document, op: Extract<Op, { type: 'deletePage' }>): Applied {
  const page = requirePage(d, op.pageId);
  if (d.pages.length <= 1) fail('Não é possível excluir a última página do documento');
  const index = d.pages.indexOf(page);
  d.pages.splice(index, 1);
  return {
    inverse: [
      {
        type: 'createPage',
        pageId: page.id,
        name: page.name,
        index,
        background: page.background,
        frames: page.frames,
      },
    ],
  };
}

function doRenamePage(d: Document, op: Extract<Op, { type: 'renamePage' }>): Applied {
  const page = requirePage(d, op.pageId);
  const prev = page.name;
  page.name = op.name;
  return { inverse: [{ type: 'renamePage', pageId: op.pageId, name: prev }] };
}

function checkTokenValues(set: Record<string, string>): void {
  for (const [k, v] of Object.entries(set)) {
    if (!TOKEN_NAME_RE.test(k)) fail(`Nome de token inválido: "${k}" (use o formato --nome)`);
    const problem = cssValueProblem(v);
    if (problem) fail(`Valor inválido para o token "${k}": ${problem}`);
  }
}

/** Aplica set/unset num mapa e devolve o par (set, unset) que desfaz. */
function patchMap<T>(
  target: Record<string, T>,
  set: Record<string, T>,
  unset: string[],
): { prevSet: Record<string, T>; prevUnset: string[] } {
  const prevSet: Record<string, T> = {};
  const prevUnset: string[] = [];
  for (const k of unique([...unset, ...Object.keys(set)])) {
    if (k in target) prevSet[k] = target[k]!;
    else prevUnset.push(k);
  }
  for (const k of unset) delete target[k];
  Object.assign(target, set);
  return { prevSet, prevUnset };
}

/** Remove `tokenMeta`/`themes` vazios: documentos sem temas continuam sem os campos. */
function tidyTokenFields(d: Document): void {
  if (d.tokenMeta && Object.keys(d.tokenMeta).length === 0) delete d.tokenMeta;
  if (d.themes && d.themes.length === 0) delete d.themes;
}

function requireTheme(d: Document, name: string): Theme {
  const theme = d.themes?.find((t) => t.name === name);
  if (!theme) fail(`Tema "${name}" não encontrado`);
  return theme;
}

function doSetTokens(d: Document, op: Extract<Op, { type: 'setTokens' }>): Applied {
  const set = normalizeTokenNames(op.set ?? {});
  const unset = (op.unset ?? []).map(normalizeTokenName);
  checkTokenValues(set);
  const target = op.theme === undefined ? d.tokens : requireTheme(d, op.theme).overrides;
  const { prevSet, prevUnset } = patchMap(target, set, unset);
  const inv: Op = { type: 'setTokens', set: prevSet, unset: prevUnset };
  if (op.theme !== undefined) inv.theme = op.theme;
  return { inverse: [inv] };
}

function doSetTokenMeta(d: Document, op: Extract<Op, { type: 'setTokenMeta' }>): Applied {
  const set = normalizeTokenNames(op.set ?? {});
  const unset = (op.unset ?? []).map(normalizeTokenName);
  for (const k of Object.keys(set)) {
    if (!TOKEN_NAME_RE.test(k)) fail(`Nome de token inválido: "${k}" (use o formato --nome)`);
  }
  const meta: Record<string, TokenMeta> = (d.tokenMeta ??= {});
  const clean: Record<string, TokenMeta> = {};
  const drop = [...unset];
  for (const [k, m] of Object.entries(set)) {
    const entry: TokenMeta = {};
    if (m.group) entry.group = m.group;
    if (m.description) entry.description = m.description;
    if (entry.group || entry.description) clean[k] = entry;
    else drop.push(k);
  }
  const { prevSet, prevUnset } = patchMap(meta, clean, unique(drop));
  tidyTokenFields(d);
  return { inverse: [{ type: 'setTokenMeta', set: prevSet, unset: prevUnset }] };
}

function doSetThemes(d: Document, op: Extract<Op, { type: 'setThemes' }>): Applied {
  const prev = deepClone(d.themes ?? []);
  d.themes = op.themes.map((t) => ({ name: t.name, overrides: normalizeTokenNames(t.overrides) }));
  for (const t of d.themes) checkTokenValues(t.overrides);
  tidyTokenFields(d);
  return { inverse: [{ type: 'setThemes', themes: prev }] };
}

function snapshotTokens(d: Document): Extract<Op, { type: 'replaceTokens' }> {
  return {
    type: 'replaceTokens',
    tokens: deepClone(d.tokens),
    tokenMeta: deepClone(d.tokenMeta ?? {}),
    themes: deepClone(d.themes ?? []),
  };
}

function doReplaceTokens(d: Document, op: Extract<Op, { type: 'replaceTokens' }>): Applied {
  const inverse = snapshotTokens(d);
  const tokens = normalizeTokenNames(op.tokens);
  checkTokenValues(tokens);
  const themes = (op.themes ?? []).map((t) => ({
    name: t.name,
    overrides: normalizeTokenNames(t.overrides),
  }));
  for (const t of themes) checkTokenValues(t.overrides);
  d.tokens = tokens;
  d.tokenMeta = deepClone(normalizeTokenNames(op.tokenMeta ?? {}));
  d.themes = themes;
  tidyTokenFields(d);
  return { inverse: [inverse] };
}

/** Troca a chave `from` por `to` mantendo a ordem das chaves. */
function renameKey<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[k === from ? to : k] = v;
  return out;
}

function doRenameToken(d: Document, op: Extract<Op, { type: 'renameToken' }>): Applied {
  const from = normalizeTokenName(op.from);
  const to = normalizeTokenName(op.to);
  const problem = renameTokenProblem(d, from, to);
  if (problem) fail(problem);
  const inverse: Op[] = [snapshotTokens(d)];

  const renameValues = (map: Record<string, string>): Record<string, string> => {
    const out = renameKey(map, from, to);
    for (const k of Object.keys(out)) out[k] = replaceVarRefs(out[k]!, from, to);
    return out;
  };
  d.tokens = renameValues(d.tokens);
  if (d.tokenMeta) d.tokenMeta = renameKey(d.tokenMeta, from, to);
  for (const t of d.themes ?? []) t.overrides = renameValues(t.overrides);

  // Estilos dos nós: referências var() e declarações locais da própria variável.
  // Também valores de `attrs` (ex.: `fill="var(--x)"`) e o markup de nós svg. O undo de attrs usa
  // `setAttrs` (nós comuns) ou `setSvg` com `attrs` (nó svg com markup, onde `setAttrs` mexeria no
  // `<svg>` raiz e não em `node.attrs`), restaurando markup e attrs juntos.
  const styleInv: StyleChange[] = [];
  const statesInv: { nodeId: string; states: Record<string, Record<string, string>> }[] = [];
  const attrsInv: { nodeId: string; set: Record<string, string>; unset: string[] }[] = [];
  const svgInv: { nodeId: string; svg: string; attrs?: Record<string, string> }[] = [];
  const classesInv: { nodeId: string; classes: string | null }[] = [];
  const touched = new Set<string>();
  let refs = 0;
  for (const page of d.pages) {
    walk(page, (node) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(node.style)) {
        const key = k === from ? to : k;
        const value = replaceVarRefs(v, from, to);
        if (key !== k || value !== v) changed = true;
        if (value !== v) refs++;
        next[key] = value;
      }
      if (changed) {
        const set: Record<string, string> = {};
        const unset: string[] = [];
        for (const [k, v] of Object.entries(node.style)) if (next[k] !== v) set[k] = v;
        for (const k of Object.keys(next)) if (!(k in node.style)) unset.push(k);
        styleInv.push({ nodeId: node.id, set, unset });
        node.style = next;
        touched.add(node.id);
      }

      if (node.states) {
        let statesChanged = false;
        const nextStates: Record<string, Record<string, string>> = {};
        for (const [key, st] of Object.entries(node.states)) {
          const ns: Record<string, string> = {};
          for (const [k, v] of Object.entries(st)) {
            const nk = k === from ? to : k;
            const nv = replaceVarRefs(v, from, to);
            if (nk !== k || nv !== v) statesChanged = true;
            if (nv !== v) refs++;
            ns[nk] = nv;
          }
          nextStates[key] = ns;
        }
        if (statesChanged) {
          statesInv.push({ nodeId: node.id, states: deepClone(node.states) });
          node.states = nextStates;
          touched.add(node.id);
        }
      }

      const prevAttrs = node.attrs ?? {};
      const nextAttrs: Record<string, string> = {};
      const prevAttrValues: Record<string, string> = {};
      for (const [k, v] of Object.entries(prevAttrs)) {
        const value = k === 'style' || k === 'class' ? v : replaceVarRefs(v, from, to);
        if (value !== v) {
          refs++;
          prevAttrValues[k] = v;
        }
        nextAttrs[k] = value;
      }
      const attrsChanged = Object.keys(prevAttrValues).length > 0;
      const prevSvg = node.type === 'svg' ? (node.svg ?? '') : '';
      const nextSvg = prevSvg ? replaceVarRefs(prevSvg, from, to) : prevSvg;
      const svgChanged = nextSvg !== prevSvg;
      if (svgChanged) {
        refs += findVarRefs(prevSvg).filter((r) => r.name === from).length;
        node.svg = nextSvg;
      }
      if (attrsChanged) node.attrs = nextAttrs;
      if (svgChanged) {
        svgInv.push(
          attrsChanged
            ? { nodeId: node.id, svg: prevSvg, attrs: prevAttrs }
            : { nodeId: node.id, svg: prevSvg },
        );
      } else if (attrsChanged) {
        if (prevSvg) svgInv.push({ nodeId: node.id, svg: prevSvg, attrs: prevAttrs });
        else attrsInv.push({ nodeId: node.id, set: prevAttrValues, unset: [] });
      }
      if (attrsChanged || svgChanged) touched.add(node.id);

      // Dica de classes Tailwind do nó: acompanha o rename (nome curto do tema e formas var()).
      if (node.classes) {
        const r = renameTokenInClasses(node.classes, from, to);
        if (r.changed > 0) {
          classesInv.push({ nodeId: node.id, classes: node.classes });
          node.classes = r.classes;
          refs += r.changed;
          touched.add(node.id);
        }
      }
    });
  }
  if (classesInv.length > 0) inverse.push({ type: 'setClasses', changes: classesInv });
  if (styleInv.length > 0) inverse.push({ type: 'updateStyles', changes: styleInv });
  if (statesInv.length > 0) inverse.push({ type: 'setStates', changes: statesInv });
  if (attrsInv.length > 0) inverse.push({ type: 'setAttrs', changes: attrsInv });
  if (svgInv.length > 0) inverse.push({ type: 'setSvg', changes: svgInv });
  return { inverse, result: { from, to, nodes: touched.size, references: refs } };
}

function doSetFonts(d: Document, op: Extract<Op, { type: 'setFonts' }>): Applied {
  const seen = new Set<string>();
  for (const f of op.fonts) {
    const key = f.family.trim().toLowerCase();
    if (!key) fail('Fonte sem nome de família');
    if (seen.has(key)) fail(`Fonte duplicada: "${f.family}"`);
    seen.add(key);
  }
  const prev = deepClone(d.fonts);
  d.fonts = deepClone(op.fonts);
  return { inverse: [{ type: 'setFonts', fonts: prev }] };
}

function doSetSrc(d: Document, op: Extract<Op, { type: 'setSrc' }>): Applied {
  const prev: { nodeId: string; src: string }[] = [];
  for (const c of op.changes) {
    const p = findNode(d, c.nodeId);
    if (!p) fail(`Nó não encontrado: "${c.nodeId}"`);
    if (p.node.type !== 'image') fail(`O nó "${c.nodeId}" não é uma imagem`);
    prev.push({ nodeId: c.nodeId, src: p.node.src ?? '' });
    p.node.src = c.src;
  }
  return { inverse: [{ type: 'setSrc', changes: prev.reverse() }] };
}

function doSetSvg(d: Document, op: Extract<Op, { type: 'setSvg' }>): Applied {
  const prev: { nodeId: string; svg: string; attrs?: Record<string, string> }[] = [];
  for (const c of op.changes) {
    const p = findNode(d, c.nodeId);
    if (!p) fail(`Nó não encontrado: "${c.nodeId}"`);
    if (p.node.type !== 'svg') fail(`O nó "${c.nodeId}" não é um SVG`);
    // Mesma sanitização aplicada ao `svg` na criação do nó (schema.ts).
    const svg = sanitizeSvg(c.svg);
    if (!svg) fail(`O markup do nó "${c.nodeId}" não contém um <svg> válido`);
    // `attrs` novos ou alterados passam pelas mesmas regras do `setAttrs` (sem on*, style e class).
    for (const [k, v] of Object.entries(c.attrs ?? {})) {
      if (p.node.attrs[k] === v) continue;
      if (k === 'style' || k === 'class') fail(`O atributo "${k}" não é permitido em attrs`);
      const problem = attrNameProblem(k);
      if (problem) fail(problem);
    }
    const entry: { nodeId: string; svg: string; attrs?: Record<string, string> } = {
      nodeId: c.nodeId,
      svg: p.node.svg ?? '',
    };
    if (c.attrs) entry.attrs = { ...p.node.attrs };
    prev.push(entry);
    p.node.svg = svg;
    if (c.attrs) p.node.attrs = { ...c.attrs };
  }
  return { inverse: [{ type: 'setSvg', changes: prev.reverse() }] };
}

function doSetClasses(d: Document, op: Extract<Op, { type: 'setClasses' }>): Applied {
  const prev: { nodeId: string; classes: string | null }[] = [];
  for (const c of op.changes) {
    const p = requireNode(d, c.nodeId);
    prev.push({ nodeId: c.nodeId, classes: p.node.classes ?? null });
    const next = (c.classes ?? '').trim().replace(/\s+/g, ' ');
    if (/[<{};"`]/.test(next)) fail(`Classes inválidas no nó "${c.nodeId}": ${next}`);
    if (next) p.node.classes = next;
    else delete p.node.classes;
  }
  return { inverse: [{ type: 'setClasses', changes: prev.reverse() }] };
}

function doSetStates(d: Document, op: Extract<Op, { type: 'setStates' }>): Applied {
  const prev: { nodeId: string; states: Record<string, Record<string, string>> | null }[] = [];
  for (const c of op.changes) {
    const p = requireNode(d, c.nodeId);
    prev.push({ nodeId: c.nodeId, states: p.node.states ? deepClone(p.node.states) : null });
    const next: Record<string, Record<string, string>> = {};
    for (const [rawKey, styles] of Object.entries(c.states ?? {})) {
      const key = normalizeStateKey(rawKey);
      if (!key) {
        fail(
          `Estado inválido "${rawKey}" no nó "${c.nodeId}" (use hover, focus, focus-visible, focus-within, active, disabled, dark, sm, md, lg, xl, 2xl ou combinações como "md:hover")`,
        );
      }
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(styles)) {
        const prop = toKebabCase(k.trim());
        if (!isValidCssPropertyName(prop)) fail(`Propriedade CSS inválida: "${k}"`);
        const problem = cssValueProblem(v);
        if (problem) fail(`Valor inválido em ${prop} (${key}): ${problem}`);
        if (v.trim() !== '') clean[prop] = v.trim();
      }
      if (Object.keys(clean).length > 0) {
        next[key] = { ...(next[key] ?? {}), ...normalizeStyles(clean) };
      }
    }
    if (Object.keys(next).length > 0) p.node.states = next;
    else delete p.node.states;
  }
  return { inverse: [{ type: 'setStates', changes: prev.reverse() }] };
}

function doSetCssBase(d: Document, op: Extract<Op, { type: 'setCssBase' }>): Applied {
  const prev = d.cssBase ?? 'default';
  if (op.base === 'tailwind') d.cssBase = 'tailwind';
  else delete d.cssBase;
  return { inverse: [{ type: 'setCssBase', base: prev }] };
}

/* ---------------- API pública ---------------- */

/** Aplica uma op de forma imutável e devolve o novo documento + op(s) inversa(s). */
export function applyOp(doc: Document, rawOp: Op): ApplyResult {
  const op = parseOp(rawOp);
  const d = deepClone(doc);
  let applied: Applied;
  switch (op.type) {
    case 'createNode':
      applied = doCreateNode(d, op);
      break;
    case 'deleteNodes':
      applied = doDeleteNodes(d, op);
      break;
    case 'moveNodes':
      applied = doMoveNodes(d, op);
      break;
    case 'updateStyles':
      applied = doUpdateStyles(d, op);
      break;
    case 'setText':
      applied = doSetText(d, op);
      break;
    case 'setAttrs':
      applied = doSetAttrs(d, op);
      break;
    case 'renameNodes':
      applied = doRename(d, op);
      break;
    case 'duplicateNodes':
      applied = doDuplicate(d, op);
      break;
    case 'setPosition':
      applied = doSetPosition(d, op);
      break;
    case 'createPage':
      applied = doCreatePage(d, op);
      break;
    case 'deletePage':
      applied = doDeletePage(d, op);
      break;
    case 'renamePage':
      applied = doRenamePage(d, op);
      break;
    case 'setTokens':
      applied = doSetTokens(d, op);
      break;
    case 'setTokenMeta':
      applied = doSetTokenMeta(d, op);
      break;
    case 'setThemes':
      applied = doSetThemes(d, op);
      break;
    case 'replaceTokens':
      applied = doReplaceTokens(d, op);
      break;
    case 'renameToken':
      applied = doRenameToken(d, op);
      break;
    case 'setNodeFlags':
      applied = doSetFlags(d, op);
      break;
    case 'setTag':
      applied = doSetTag(d, op);
      break;
    case 'setFonts':
      applied = doSetFonts(d, op);
      break;
    case 'setSrc':
      applied = doSetSrc(d, op);
      break;
    case 'setClasses':
      applied = doSetClasses(d, op);
      break;
    case 'setStates':
      applied = doSetStates(d, op);
      break;
    case 'setCssBase':
      applied = doSetCssBase(d, op);
      break;
    case 'setSvg':
      applied = doSetSvg(d, op);
      break;
    default:
      return fail(`Operação desconhecida: "${String((op as { type?: unknown }).type)}"`);
  }
  d.meta.updatedAt = new Date().toISOString();
  return { doc: d, inverse: applied.inverse, result: applied.result };
}

/** Aplica ops em sequência, atomicamente. `inverse` já vem na ordem para desfazer. */
export function applyOps(
  doc: Document,
  ops: Op[],
): { doc: Document; inverse: Op[]; results: Result[] } {
  let cur = doc;
  const groups: Op[][] = [];
  const results: Result[] = [];
  ops.forEach((op, i) => {
    try {
      const r = applyOp(cur, op);
      cur = r.doc;
      groups.push(r.inverse);
      results.push(r.result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Operação #${i + 1} (${op.type}) falhou: ${msg}`);
    }
  });
  return { doc: cur, inverse: groups.reverse().flat(), results };
}
