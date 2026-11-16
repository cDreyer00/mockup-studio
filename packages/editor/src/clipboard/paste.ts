/**
 * Lógica pura do clipboard: serialização com marcador, detecção de HTML, alvo da colagem e
 * preparação dos nós (ids novos, conversão frame ↔ elemento, posições).
 */
import { cloneNodeWithNewIds, nodesToHtml } from '@mockup/core';
import type { Document, Node } from '@mockup/core';
import { POSITION_STYLE_KEYS, isLeafNode, makeLeafFrame } from '../model/factory';
import {
  canHaveChildren,
  getEntry,
  getNode,
  isAbsolute,
  isFlex,
  isLockedDeep,
  pxValue,
  sortByDocumentOrder,
} from '../model/tree';

/* ------------------------------------------------------------------ */
/* serialização                                                       */
/* ------------------------------------------------------------------ */

const MARKER_RE = /<!--mockup-studio:([\w-]+)-->/;

export function makeMarker(token: string): string {
  return `<!--mockup-studio:${token}-->`;
}

/** Extrai o token do marcador de uma string do clipboard (ou `null`). */
export function extractMarker(text: string | null | undefined): string | null {
  return text ? (MARKER_RE.exec(text)?.[1] ?? null) : null;
}

/** HTML escrito no clipboard: marcador + markup dos nós (CSS inline). */
export function serializeNodes(nodes: Node[], token: string): string {
  return makeMarker(token) + nodesToHtml(nodes, { mode: 'inline', indent: false }).html;
}

const KNOWN_TAGS =
  'div|section|article|header|footer|nav|main|aside|p|span|a|button|h[1-6]|ul|ol|li|img|svg|form|input|label|table|figure|html|body|style';

/** O texto parece HTML (começa com `<` e tem tag de fechamento ou tag conhecida)? */
export function looksLikeHtml(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (!t.startsWith('<')) return false;
  if (t.startsWith('<!--') && MARKER_RE.test(t)) return true;
  return new RegExp(`</[a-z][\\w-]*\\s*>|<(?:${KNOWN_TAGS})(?:[\\s>/])`, 'i').test(t);
}

export type PasteKind = 'internal' | 'images' | 'html' | 'text' | 'none';

/** Decide como interpretar o conteúdo colado. */
export function classifyPaste(
  data: { html: string; text: string; imageCount: number },
  internalToken: string | null,
): PasteKind {
  const token = extractMarker(data.html) ?? extractMarker(data.text);
  if (token && internalToken && token === internalToken) return 'internal';
  if (data.imageCount > 0) return 'images';
  if (looksLikeHtml(data.html) || looksLikeHtml(data.text)) return 'html';
  if (data.text.length > 0) return 'text';
  return 'none';
}

/* ------------------------------------------------------------------ */
/* alvo                                                               */
/* ------------------------------------------------------------------ */

export interface PasteTarget {
  /** Pai de destino; `null` = raiz da página. */
  parentId: string | null;
  parent: Node | null;
  pageId: string;
  /** Índice de inserção; ausente = ao final. */
  index?: number;
}

/**
 * Onde colar: 1 nó que aceita filhos → dentro dele, ao final; nó folha (ou vários) → depois
 * dele no mesmo pai; sem seleção → raiz da página.
 */
export function resolvePasteTarget(
  doc: Document,
  selection: readonly string[],
  pageId: string | null,
): PasteTarget | null {
  const entries = selection.map((id) => getEntry(doc, id)).filter((e) => !!e);
  const fallbackPage = (pageId && doc.pages.find((p) => p.id === pageId)) || doc.pages[0];
  if (entries.length === 0) {
    return fallbackPage ? { parentId: null, parent: null, pageId: fallbackPage.id } : null;
  }
  let target: PasteTarget;
  if (entries.length === 1 && canHaveChildren(entries[0]!.node)) {
    const e = entries[0]!;
    target = { parentId: e.node.id, parent: e.node, pageId: e.pageId };
  } else {
    const lastId = sortByDocumentOrder(
      doc,
      entries.map((e) => e!.node.id),
    ).at(-1)!;
    const last = getEntry(doc, lastId)!;
    target = {
      parentId: last.parentId,
      parent: last.parentId ? (getNode(doc, last.parentId) ?? null) : null,
      pageId: last.pageId,
      index: last.index + 1,
    };
  }
  // Nada entra em nó travado (nem em descendente dele): sobe até o primeiro pai livre, colando
  // logo depois do travado; acima do frame raiz, a colagem vai para a raiz da página.
  while (target.parentId && isLockedDeep(doc, target.parentId)) {
    const locked = getEntry(doc, target.parentId)!;
    target = locked.parentId
      ? {
          parentId: locked.parentId,
          parent: getNode(doc, locked.parentId) ?? null,
          pageId: locked.pageId,
          index: locked.index + 1,
        }
      : { parentId: null, parent: null, pageId: locked.pageId };
  }
  return target;
}

/* ------------------------------------------------------------------ */
/* preparação                                                         */
/* ------------------------------------------------------------------ */

export interface PasteOptions {
  /** Centro da tela em coordenadas do mundo (colagem na raiz). */
  center: { x: number; y: number };
  /** Quantas vezes este mesmo conteúdo já foi colado (desloca +40 / +16 por vez). */
  pasteCount?: number;
  /** Mede o nó original (id) em px; usado quando faltam width/height. */
  measure?: (id: string) => { w: number; h: number } | null;
}

const DEFAULT_PASTE_SIZE = { w: 400, h: 300 };

const px = (n: number): string => `${Math.round(n)}px`;

function sizeOf(node: Node, measure?: PasteOptions['measure']): { w: number; h: number } {
  const m = measure?.(node.id);
  return {
    w: pxValue(node.style.width) ?? m?.w ?? DEFAULT_PASTE_SIZE.w,
    h: pxValue(node.style.height) ?? m?.h ?? DEFAULT_PASTE_SIZE.h,
  };
}

/**
 * Clona os nós com ids novos e os adapta ao destino. Na raiz viram frames (nós folha — texto,
 * imagem, svg — são embrulhados num frame novo); dentro de um nó, frames viram elementos.
 */
export function prepareNodesForPaste(
  nodes: readonly Node[],
  target: Pick<PasteTarget, 'parentId' | 'parent'>,
  opts: PasteOptions,
): Node[] {
  const count = opts.pasteCount ?? 0;
  if (target.parentId === null) return prepareForRoot(nodes, opts, count);

  const parentFlex = isFlex(target.parent);
  return nodes.map((original) => {
    const base: Node = { ...original, type: original.type === 'frame' ? 'element' : original.type };
    const { node } = cloneNodeWithNewIds(base);
    delete node.position;
    if (original.type === 'frame') {
      node.style = { ...node.style };
      for (const k of ['left', 'top', 'right', 'bottom']) delete node.style[k];
      if (node.style.position === 'absolute' || node.style.position === 'fixed') {
        delete node.style.position;
      }
    }
    if (!parentFlex && isAbsolute(node)) {
      const shift = 16 * (count + 1);
      const left = pxValue(node.style.left);
      const top = pxValue(node.style.top);
      if (left !== undefined) node.style.left = px(left + shift);
      if (top !== undefined) node.style.top = px(top + shift);
    }
    return node;
  });
}

function prepareForRoot(nodes: readonly Node[], opts: PasteOptions, count: number): Node[] {
  interface Item {
    node: Node;
    w: number;
    h: number;
    relX: number;
    relY: number;
  }
  const items: Item[] = [];
  let cursorX = 0;
  const first = nodes[0]?.position;
  for (const original of nodes) {
    const { w, h } = sizeOf(original, opts.measure);
    let node: Node;
    let width = w;
    let height = h;
    if (isLeafNode(original)) {
      const child = cloneNodeWithNewIds(original).node;
      delete child.position;
      for (const k of POSITION_STYLE_KEYS) delete child.style[k];
      node = makeLeafFrame(original, 0, 0, w, h, DEFAULT_PASTE_SIZE);
      node.children = [child];
      width = pxValue(node.style.width)!;
      height = pxValue(node.style.height)!;
    } else {
      node = cloneNodeWithNewIds({ ...original, type: 'frame' }).node;
      node.style = { ...node.style, width: px(w), height: px(h) };
      for (const k of ['left', 'top', 'right', 'bottom']) delete node.style[k];
      node.style.position = 'relative';
    }
    let relX = cursorX;
    let relY = 0;
    if (first && original.position) {
      relX = original.position.x - first.x;
      relY = original.position.y - first.y;
    }
    items.push({ node, w: width, h: height, relX, relY });
    cursorX += width + 40;
  }
  if (items.length === 0) return [];
  const minX = Math.min(...items.map((i) => i.relX));
  const minY = Math.min(...items.map((i) => i.relY));
  const maxX = Math.max(...items.map((i) => i.relX + i.w));
  const maxY = Math.max(...items.map((i) => i.relY + i.h));
  const originX = opts.center.x - (maxX - minX) / 2 - minX + 40 * count;
  const originY = opts.center.y - (maxY - minY) / 2 - minY + 40 * count;
  return items.map((i) => {
    i.node.position = { x: Math.round(originX + i.relX), y: Math.round(originY + i.relY) };
    return i.node;
  });
}
