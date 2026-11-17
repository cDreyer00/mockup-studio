import { newDocumentId, newNodeId, newPageId } from './ids.js';
import { normalizeStyles } from './styles.js';
import { normalizeTag } from './tags.js';
import type { Document, Node, NodePath, NodeType, Page, Position } from './types.js';
import { DOCUMENT_VERSION } from './types.js';

const NAME_TEXT_MAX = 32;

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function createDocument(name: string, opts: { id?: string } = {}): Document {
  const now = new Date().toISOString();
  return {
    version: DOCUMENT_VERSION,
    id: opts.id ?? newDocumentId(),
    name,
    pages: [createPage('Página 1')],
    tokens: {},
    fonts: [],
    meta: { createdAt: now, updatedAt: now },
  };
}

export function createPage(name: string, opts: { id?: string; background?: string } = {}): Page {
  return {
    id: opts.id ?? newPageId(),
    name,
    frames: [],
    background: opts.background ?? '#1e1e1e',
  };
}

function inferType(init: Partial<Node> & { tag: string }): NodeType {
  if (init.type) return init.type;
  if (init.tag === 'img') return 'image';
  if (init.tag === 'svg') return 'svg';
  if (init.text !== undefined && !(init.children && init.children.length > 0)) return 'text';
  return 'element';
}

export function createNode(init: Partial<Node> & { tag: string }): Node {
  const tag = normalizeTag(init.tag);
  init = { ...init, tag };
  const type = inferType(init);
  const text = init.text;
  const name =
    init.name ?? (type === 'text' && text ? truncate(text, NAME_TEXT_MAX) : capitalize(tag));
  const node: Node = {
    id: init.id ?? newNodeId(type),
    type,
    name,
    tag,
    attrs: { ...(init.attrs ?? {}) },
    style: normalizeStyles(init.style ?? {}),
    children: init.children ?? [],
    locked: init.locked ?? false,
    hidden: init.hidden ?? false,
  };
  if (text !== undefined) node.text = text;
  if (init.src !== undefined) node.src = init.src;
  if (init.svg !== undefined) node.svg = init.svg;
  if (init.position !== undefined) node.position = init.position;
  if (init.data !== undefined) node.data = init.data;
  if (init.dataSource !== undefined) node.dataSource = init.dataSource;
  return node;
}

export function createNodeFromTag(
  tag: string,
  opts: {
    name?: string;
    styles?: Record<string, string>;
    text?: string;
    attrs?: Record<string, string>;
    children?: Node[];
    src?: string;
    svg?: string;
    isRoot?: boolean;
    position?: Position;
  } = {},
): Node {
  tag = normalizeTag(tag);
  const hasChildren = (opts.children?.length ?? 0) > 0;
  let type: NodeType;
  if (opts.isRoot) type = 'frame';
  else if (tag === 'img') type = 'image';
  else if (tag === 'svg') type = 'svg';
  else if (opts.text !== undefined && !hasChildren) type = 'text';
  else type = 'element';
  return createNode({
    tag,
    type,
    name: opts.name,
    style: opts.styles ?? {},
    text: opts.text,
    attrs: opts.attrs,
    children: opts.children,
    src: opts.src,
    svg: opts.svg,
    position: opts.position,
  });
}

function findIn(
  list: Node[],
  id: string,
  page: Page,
  parent: Node | null,
  ancestors: Node[],
): NodePath | undefined {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.id === id) return { node, page, parent, index: i, ancestors };
    if (node.children.length > 0) {
      const found = findIn(node.children, id, page, node, [...ancestors, node]);
      if (found) return found;
    }
  }
  return undefined;
}

export function findNode(doc: Document, id: string): NodePath | undefined {
  for (const page of doc.pages) {
    const found = findIn(page.frames, id, page, null, []);
    if (found) return found;
  }
  return undefined;
}

export function findPage(doc: Document, pageId: string): Page | undefined {
  return doc.pages.find((p) => p.id === pageId);
}

export function getPageOfNode(doc: Document, nodeId: string): Page | undefined {
  return findNode(doc, nodeId)?.page;
}

/** Frame raiz que contém o nó (o próprio nó se for frame raiz). */
export function getFrameOf(doc: Document, nodeId: string): Node | undefined {
  const path = findNode(doc, nodeId);
  if (!path) return undefined;
  return path.ancestors[0] ?? path.node;
}

type WalkVisitor = (node: Node, parent: Node | null, depth: number) => void | false;

function walkNode(node: Node, parent: Node | null, depth: number, visit: WalkVisitor): void {
  if (visit(node, parent, depth) === false) return;
  for (const child of node.children) walkNode(child, node, depth + 1, visit);
}

/** Percurso em pré-ordem; retornar `false` pula os filhos do nó. */
export function walk(root: Node | Node[] | Page | Document, visit: WalkVisitor): void {
  if (Array.isArray(root)) {
    for (const n of root) walkNode(n, null, 0, visit);
  } else if ('pages' in root) {
    for (const page of root.pages) for (const f of page.frames) walkNode(f, null, 0, visit);
  } else if ('frames' in root) {
    for (const f of root.frames) walkNode(f, null, 0, visit);
  } else {
    walkNode(root, null, 0, visit);
  }
}

export function collectIds(root: Node | Node[] | Page | Document): string[] {
  const ids: string[] = [];
  walk(root, (n) => {
    ids.push(n.id);
  });
  return ids;
}

/** Clona o nó gerando ids novos (ou reutilizando os de `idMap`). */
export function cloneNodeWithNewIds(
  node: Node,
  idMap: Record<string, string> = {},
): { node: Node; idMap: Record<string, string> } {
  const clone = (n: Node): Node => {
    let id = idMap[n.id];
    if (!id) {
      id = newNodeId(n.type);
      idMap[n.id] = id;
    }
    const copy: Node = {
      ...n,
      id,
      attrs: { ...n.attrs },
      style: { ...n.style },
      children: n.children.map(clone),
    };
    if (n.position) copy.position = { ...n.position };
    return copy;
  };
  return { node: clone(node), idMap };
}
