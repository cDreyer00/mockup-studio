/**
 * Builders de ops compartilhados pelo MCP e pelo editor (cada um devolve as ops de uma única
 * entrada de undo). Lançam `Error` com mensagem em português quando a entrada não serve.
 */
import { deepClone } from '../clone.js';
import { findNode } from '../document.js';
import { newNodeId } from '../ids.js';
import type { Op } from '../ops.js';
import type { Document, Node, Vector, VectorPath } from '../types.js';
import { booleanPathData } from './boolean.js';
import type { BooleanOp } from './boolean.js';
import { pathBounds, transformPathData } from './path.js';
import type { Box, Matrix } from './path.js';
import { createVectorNode } from './shapes.js';
import { ensureVector, isVectorEditable } from './svg.js';

/** `[{ type: 'setVector', changes: [{ nodeId, vector }] }]`. */
export function buildSetVectorOps(nodeId: string, vector: Vector | null): Op[] {
  return [{ type: 'setVector', changes: [{ nodeId, vector }] }];
}

function pxValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*(-?\d*\.?\d+(?:e[+-]?\d+)?)(px)?\s*$/i.exec(value);
  return m ? parseFloat(m[1]!) : null;
}

/**
 * Caixa do nó no pai, em px, lida do estilo: `left`/`top` (padrão 0) e `width`/`height` em px
 * (padrão: viewBox do vetor). `null` se width/height não forem px nem houver viewBox.
 */
export function nodeBoxInParent(node: Node): Box | null {
  const vb = ensureVector(node)?.viewBox;
  const width = pxValue(node.style.width) ?? vb?.width;
  const height = pxValue(node.style.height) ?? vb?.height;
  if (width === undefined || height === undefined) return null;
  return { x: pxValue(node.style.left) ?? 0, y: pxValue(node.style.top) ?? 0, width, height };
}

interface Source {
  node: Node;
  vector: Vector;
  box: Box;
  /** Leva coordenadas do viewBox ao espaço do pai. */
  matrix: Matrix;
}

interface Context {
  sources: Source[];
  parentId: string | null;
  pageId: string;
  index: number;
}

const label = (n: Node): string => `"${n.name ?? n.id}"`;

/** Valida e ordena (ordem no pai) os nós svg irmãos. */
function collectSources(doc: Document, nodeIds: string[], min: number): Context {
  const ids = [...new Set(nodeIds)];
  if (ids.length < min) {
    throw new Error(`Selecione pelo menos ${min} ${min === 1 ? 'nó' : 'nós'} svg`);
  }
  const found = ids.map((id) => {
    const p = findNode(doc, id);
    if (!p) throw new Error(`Nó não encontrado: "${id}"`);
    return p;
  });
  const first = found[0]!;
  for (const p of found) {
    if (p.node.type !== 'svg') throw new Error(`O nó ${label(p.node)} não é um svg`);
    if ((p.parent?.id ?? null) !== (first.parent?.id ?? null) || p.page.id !== first.page.id) {
      throw new Error('Os nós precisam ser irmãos (ter o mesmo pai)');
    }
  }
  found.sort((a, b) => a.index - b.index);
  const sources = found.map((p): Source => {
    const vector = ensureVector(p.node);
    if (!vector || !isVectorEditable(vector)) {
      throw new Error(`O nó ${label(p.node)} não tem paths editáveis`);
    }
    const box = nodeBoxInParent(p.node);
    if (!box) {
      throw new Error(`Não foi possível determinar a caixa do nó ${label(p.node)} (width/height em px)`);
    }
    const sx = vector.viewBox.width ? box.width / vector.viewBox.width : 1;
    const sy = vector.viewBox.height ? box.height / vector.viewBox.height : 1;
    return {
      node: p.node,
      vector,
      box,
      matrix: {
        a: sx,
        b: 0,
        c: 0,
        d: sy,
        e: box.x - vector.viewBox.x * sx,
        f: box.y - vector.viewBox.y * sy,
      },
    };
  });
  return {
    sources,
    parentId: first.parent?.id ?? null,
    pageId: first.page.id,
    index: found[0]!.index,
  };
}

const BOX_KEYS = ['left', 'top', 'width', 'height', 'position'];

/** Monta o nó resultado a partir de paths já no espaço do pai e emite as ops (create + delete). */
function buildResult(
  ctx: Context,
  paths: VectorPath[],
  name: string,
  id: string | undefined,
): { ops: Op[]; nodeId: string } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of paths) {
    const b = pathBounds(p.d);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  const maxStroke = Math.max(
    0,
    ...paths.map((p) => (p.stroke && p.stroke !== 'none' ? (p.strokeWidth ?? 0) : 0)),
  );
  const pad = maxStroke / 2;
  const x = minX - pad;
  const y = minY - pad;
  const width = maxX - minX + 2 * pad;
  const height = maxY - minY + 2 * pad;
  const move: Matrix = { a: 1, b: 0, c: 0, d: 1, e: -x, f: -y };
  const vector: Vector = {
    viewBox: { x: 0, y: 0, width, height },
    paths: paths.map((p, i) => ({ ...p, id: `p${i + 1}`, d: transformPathData(p.d, move) })),
  };
  const bottom = ctx.sources[0]!.node;
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(bottom.style)) if (!BOX_KEYS.includes(k)) style[k] = v;
  const px = (n: number): string => `${Number(n.toFixed(3))}px`;
  Object.assign(style, {
    position: 'absolute',
    left: px(x),
    top: px(y),
    width: px(width),
    height: px(height),
  });
  const nodeId = id ?? newNodeId('svg');
  const node = createVectorNode(vector, { name, style, id: nodeId });
  const create: Op = ctx.parentId
    ? { type: 'createNode', parentId: ctx.parentId, node, index: ctx.index }
    : { type: 'createNode', parentId: null, pageId: ctx.pageId, node, index: ctx.index };
  return {
    ops: [create, { type: 'deleteNodes', nodeIds: ctx.sources.map((s) => s.node.id) }],
    nodeId,
  };
}

/** Tinta de um path (sem id/d/fillRule). */
function paintOf(p: VectorPath): Omit<VectorPath, 'id' | 'd' | 'fillRule'> {
  const { id: _id, d: _d, fillRule: _fr, ...paint } = p;
  void _id;
  void _d;
  void _fr;
  return deepClone(paint);
}

/**
 * Booleana entre nós svg irmãos (2 ou mais, com paths editáveis; nós sem `vector` usam
 * `ensureVector`). Cada path vai ao espaço do pai (caixa do nó × viewBox). Resultado: um nó svg
 * novo, no lugar do primeiro (mesmo índice), `position: absolute` na caixa do resultado, com o
 * estilo do nó mais ao fundo (sem left/top/width/height) e a tinta do primeiro path dele; os
 * originais são removidos. Ordem dos nós = ordem no pai (o de baixo é o "primeiro" do subtract).
 * O resultado é achatado (só segmentos de reta); `fillRule` é aproximado (veja `booleanPathData`).
 * O viewBox do resultado começa em 0,0 e a caixa do nó fica em left/top.
 */
export function buildBooleanOps(
  doc: Document,
  nodeIds: string[],
  op: BooleanOp,
  opts: { name?: string; id?: string } = {},
): { ops: Op[]; nodeId: string } {
  const ctx = collectSources(doc, nodeIds, 2);
  const items = ctx.sources.flatMap((s) =>
    s.vector.paths.map((p) => ({ d: p.d, matrix: s.matrix, fillRule: p.fillRule })),
  );
  const d = booleanPathData(op, items);
  if (!d) throw new Error('O resultado da operação booleana é vazio');
  const path: VectorPath = { id: 'p1', d, ...paintOf(ctx.sources[0]!.vector.paths[0]!) };
  return buildResult(ctx, [path], opts.name ?? 'Booleana', opts.id);
}

/**
 * Achatar. Um nó: junta todos os paths num só (`d` concatenado, tinta do primeiro), via
 * `setVector`. Vários nós svg irmãos: um nó novo com os paths de todos levados ao espaço comum
 * (cada um mantém a tinta), no lugar do mais ao fundo; os originais são removidos.
 */
export function buildFlattenOps(
  doc: Document,
  nodeIds: string[],
  opts: { name?: string; id?: string } = {},
): { ops: Op[]; nodeId: string } {
  const ctx = collectSources(doc, nodeIds, 1);
  if (ctx.sources.length === 1) {
    const { node, vector } = ctx.sources[0]!;
    const first = vector.paths[0]!;
    const merged: VectorPath = {
      id: first.id,
      d: vector.paths.map((p) => p.d.trim()).join(' '),
      ...paintOf(first),
      ...(first.fillRule ? { fillRule: first.fillRule } : {}),
    };
    const { raw: _raw, ...rest } = vector;
    void _raw;
    return { ops: buildSetVectorOps(node.id, { ...rest, paths: [merged] }), nodeId: node.id };
  }
  const paths = ctx.sources.flatMap((s) =>
    s.vector.paths.map((p) => ({ ...deepClone(p), d: transformPathData(p.d, s.matrix) })),
  );
  return buildResult(ctx, paths, opts.name ?? 'Vetor achatado', opts.id);
}
