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
 * Caixa do nó no pai, em px, lida do estilo: `left`/`top` e `width`/`height` em px (padrão:
 * viewBox do vetor). `null` se width/height não forem px nem houver viewBox. A posição segue o
 * editor: raiz da página (`isRoot`) usa `node.position`; filho usa `left`/`top`, senão
 * `node.position`, senão 0.
 */
export function nodeBoxInParent(node: Node, isRoot = false): Box | null {
  const vb = ensureVector(node)?.viewBox;
  const width = pxValue(node.style.width) ?? vb?.width;
  const height = pxValue(node.style.height) ?? vb?.height;
  if (width === undefined || height === undefined) return null;
  if (isRoot) return { x: node.position?.x ?? 0, y: node.position?.y ?? 0, width, height };
  return {
    x: pxValue(node.style.left) ?? node.position?.x ?? 0,
    y: pxValue(node.style.top) ?? node.position?.y ?? 0,
    width,
    height,
  };
}

/** Opções de `buildBooleanOps`/`buildFlattenOps`. */
export interface BuildOptions {
  name?: string;
  id?: string;
  /**
   * Caixa medida (px, no padding box do pai) de cada nó, por id. Obrigatória para nós em fluxo
   * (não raiz e sem `position: absolute|fixed`); para os livres tem precedência sobre o estilo.
   */
  boxes?: Record<string, Box>;
}

/** Nó "livre": raiz da página ou `position: absolute|fixed`; a posição vem do estilo. */
export function isFreeNode(node: Node, isRoot: boolean): boolean {
  if (isRoot) return true;
  const pos = (node.style['position'] ?? '').trim();
  return pos === 'absolute' || pos === 'fixed';
}

/**
 * Como o vetor é desenhado na caixa do nó (`preserveAspectRatio`): `'none'` = esticado; senão o
 * alinhamento (`xMidYMid`...) e se é `slice` (cobre) ou `meet` (cabe). Lê o `<svg>` raiz do `raw`,
 * depois `attrs.preserveAspectRatio`; sem nenhum, o vetor é esticado (`none`).
 */
function aspectOf(v: Vector): { align: string; slice: boolean } | 'none' {
  let value: string | undefined;
  if (v.raw !== undefined) {
    const tag = /<svg\b[^>]*>/i.exec(v.raw)?.[0];
    const m = tag ? /\spreserveAspectRatio\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag) : null;
    value = m ? (m[1] ?? m[2]) : undefined;
  }
  value ??= v.attrs?.['preserveAspectRatio'];
  if (value === undefined) return 'none';
  const parts = value
    .trim()
    .split(/\s+/)
    .filter((t) => t !== 'defer');
  const align = parts[0] ?? 'xMidYMid';
  if (align === 'none') return 'none';
  return { align, slice: parts[1] === 'slice' };
}

/** Leva o viewBox à caixa respeitando `preserveAspectRatio` (como o navegador desenha). */
function viewBoxMatrix(vector: Vector, box: Box): Matrix {
  const vb = vector.viewBox;
  const rx = vb.width ? box.width / vb.width : 1;
  const ry = vb.height ? box.height / vb.height : 1;
  const par = aspectOf(vector);
  if (par === 'none') {
    return { a: rx, b: 0, c: 0, d: ry, e: box.x - vb.x * rx, f: box.y - vb.y * ry };
  }
  const s = par.slice ? Math.max(rx, ry) : Math.min(rx, ry);
  const free = (total: number, used: number, k: string): number =>
    k === 'Min' ? 0 : k === 'Max' ? total - used : (total - used) / 2;
  const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(par.align);
  const ox = free(box.width, vb.width * s, m?.[1] ?? 'Mid');
  const oy = free(box.height, vb.height * s, m?.[2] ?? 'Mid');
  return { a: s, b: 0, c: 0, d: s, e: box.x + ox - vb.x * s, f: box.y + oy - vb.y * s };
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
  /** Estilo do pai (para o bloco de contenção do resultado). */
  parentStyle: Record<string, string> | null;
  pageId: string;
  index: number;
  /** Algum nó em fluxo entrou com caixa medida. */
  usedFlow: boolean;
}

const label = (n: Node): string => `"${n.name ?? n.id}"`;

/** Valida e ordena (ordem no pai) os nós svg irmãos. `what` completa "antes ___" na recusa. */
function collectSources(
  doc: Document,
  nodeIds: string[],
  min: number,
  boxes: Record<string, Box> | undefined,
  what: string,
): Context {
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
  // um nó só (achatar via setVector) não depende da posição
  const multi = found.length > 1;
  let usedFlow = false;
  const sources = found.map((p): Source => {
    const vector = ensureVector(p.node);
    if (!vector || !isVectorEditable(vector)) {
      throw new Error(`O nó ${label(p.node)} não tem paths editáveis`);
    }
    const isRoot = p.parent === null;
    const measured = boxes?.[p.node.id];
    let box: Box | null;
    if (!multi) {
      box = measured ??
        nodeBoxInParent(p.node, isRoot) ?? {
          x: 0,
          y: 0,
          width: vector.viewBox.width,
          height: vector.viewBox.height,
        };
    } else if (measured) {
      box = measured;
      if (!isFreeNode(p.node, isRoot)) usedFlow = true;
    } else if (!isFreeNode(p.node, isRoot)) {
      throw new Error(
        `O nó ${label(p.node)} está em fluxo (sem position: absolute); posicione-o livremente antes ${what}`,
      );
    } else {
      box = nodeBoxInParent(p.node, isRoot);
    }
    if (!box) {
      throw new Error(`Não foi possível determinar a caixa do nó ${label(p.node)} (width/height em px)`);
    }
    return { node: p.node, vector, box, matrix: viewBoxMatrix(vector, box) };
  });
  return {
    sources,
    parentId: first.parent?.id ?? null,
    parentStyle: first.parent?.style ?? null,
    pageId: first.page.id,
    index: found[0]!.index,
    usedFlow,
  };
}

const BOX_KEYS = ['left', 'top', 'width', 'height', 'position'];

/** Multiplica cada número de um dasharray por `k` (`"2 1"` × 2 = `"4 2"`). */
function scaleDash(dash: string, k: number): string {
  return dash.replace(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi, (n) =>
    String(Number((parseFloat(n) * k).toFixed(4))),
  );
}

/**
 * Leva espessura e tracejado ao espaço do pai: × escala da matriz (`hypot(a, b)`, como
 * `importShape`). Traço visível sem `strokeWidth` vale 1 no SVG, então vira a própria escala.
 */
function scalePaint<T extends Omit<VectorPath, 'id' | 'd' | 'fillRule'>>(p: T, m: Matrix): T {
  const k = Math.hypot(m.a, m.b);
  if (Math.abs(k - 1) < 1e-9) return p;
  const out = { ...p };
  const hasStroke = out.stroke !== undefined && out.stroke !== 'none';
  if (out.strokeWidth !== undefined) out.strokeWidth = Number((out.strokeWidth * k).toFixed(4));
  else if (hasStroke) out.strokeWidth = Number(k.toFixed(4));
  if (out.strokeDasharray !== undefined) out.strokeDasharray = scaleDash(out.strokeDasharray, k);
  return out;
}

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
  // espessuras já escaladas (espaço do pai)
  const maxStroke = Math.max(
    0,
    ...paths.map((p) => (p.stroke && p.stroke !== 'none' ? (p.strokeWidth ?? 1) : 0)),
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
  const root = ctx.parentId === null;
  if (root) {
    // frame raiz: a posição no canvas fica em `node.position` (sem left/top/position)
    Object.assign(style, { width: px(width), height: px(height) });
  } else {
    Object.assign(style, {
      position: 'absolute',
      left: px(x),
      top: px(y),
      width: px(width),
      height: px(height),
    });
  }
  const nodeId = id ?? newNodeId('svg');
  const node = createVectorNode(vector, { name, style, id: nodeId });
  if (root) node.position = { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
  const create: Op = ctx.parentId
    ? { type: 'createNode', parentId: ctx.parentId, node, index: ctx.index }
    : { type: 'createNode', parentId: null, pageId: ctx.pageId, node, index: ctx.index };
  const ops: Op[] = [];
  // o resultado é absoluto no pai: com nós em fluxo medidos, o pai precisa ser o bloco de contenção
  if (ctx.usedFlow && ctx.parentId) {
    const pos = (ctx.parentStyle?.['position'] ?? '').trim();
    if (pos === '' || pos === 'static') {
      ops.push({
        type: 'updateStyles',
        changes: [{ nodeId: ctx.parentId, set: { position: 'relative' } }],
      });
    }
  }
  ops.push(create, { type: 'deleteNodes', nodeIds: ctx.sources.map((s) => s.node.id) });
  return { ops, nodeId };
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
 * `ensureVector`). Cada path vai ao espaço do pai (caixa do nó × viewBox, respeitando o
 * `preserveAspectRatio` do vetor). Resultado: um nó svg novo, no lugar do primeiro (mesmo
 * índice), na caixa do resultado, com o estilo do nó mais ao fundo (sem left/top/width/height/
 * position) e a tinta do primeiro path dele (espessura e tracejado × escala); os originais são
 * removidos. Ordem dos nós = ordem no pai (o de baixo é o "primeiro" do subtract).
 *
 * Posição: nós livres (raiz da página ou `position: absolute|fixed`) usam o estilo (raiz:
 * `node.position`). Nós em fluxo exigem `opts.boxes` (caixa medida no padding box do pai); sem ela,
 * lança erro. Com nó em fluxo, o resultado é `position: absolute` no pai (que passa a
 * `position: relative` se for estático) e os irmãos restantes refluem. Na raiz da página o
 * resultado usa `node.position`, como os frames raiz. O viewBox do resultado começa em 0,0.
 * O resultado é achatado (só segmentos de reta); `fillRule` é aproximado (veja `booleanPathData`).
 */
export function buildBooleanOps(
  doc: Document,
  nodeIds: string[],
  op: BooleanOp,
  opts: BuildOptions = {},
): { ops: Op[]; nodeId: string } {
  const ctx = collectSources(doc, nodeIds, 2, opts.boxes, 'da booleana');
  const items = ctx.sources.flatMap((s) =>
    s.vector.paths.map((p) => ({ d: p.d, matrix: s.matrix, fillRule: p.fillRule })),
  );
  const d = booleanPathData(op, items);
  if (!d) throw new Error('O resultado da operação booleana é vazio');
  const first = ctx.sources[0]!;
  const path: VectorPath = { id: 'p1', d, ...scalePaint(paintOf(first.vector.paths[0]!), first.matrix) };
  return buildResult(ctx, [path], opts.name ?? 'Booleana', opts.id);
}

/**
 * Achatar. Um nó: junta todos os paths num só (`d` concatenado, tinta do primeiro), via
 * `setVector`. Vários nós svg irmãos: um nó novo com os paths de todos levados ao espaço comum
 * (cada um mantém a tinta, com espessura e tracejado × escala), no lugar do mais ao fundo; os
 * originais são removidos. Posição e `opts.boxes`: veja `buildBooleanOps`.
 */
export function buildFlattenOps(
  doc: Document,
  nodeIds: string[],
  opts: BuildOptions = {},
): { ops: Op[]; nodeId: string } {
  const ctx = collectSources(doc, nodeIds, 1, opts.boxes, 'de achatar');
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
    s.vector.paths.map((p) => ({
      ...scalePaint(deepClone(p), s.matrix),
      d: transformPathData(p.d, s.matrix),
    })),
  );
  return buildResult(ctx, paths, opts.name ?? 'Vetor achatado', opts.id);
}
