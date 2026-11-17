/**
 * Op builders shared by the MCP and the editor (each returns the ops of a single
 * undo entry). They throw an `Error` with an English message when the input is invalid.
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
import { ensureVector, isVectorEditable, vectorPreserveAspectRatio } from './svg.js';

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
 * Node box in the parent, in px, read from the style: `left`/`top` and `width`/`height` in px (default:
 * the vector's viewBox). `null` if width/height are not px and there is no viewBox. The position follows the
 * editor: a page root (`isRoot`) uses `node.position`; a child uses `left`/`top`, otherwise
 * `node.position`, otherwise 0.
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

/** Options of `buildBooleanOps`/`buildFlattenOps`. */
export interface BuildOptions {
  name?: string;
  id?: string;
  /**
   * Measured box (px, in the parent's padding box) of each node, by id. Required for in-flow nodes
   * (not root and without `position: absolute|fixed`); for free nodes it takes precedence over the style.
   */
  boxes?: Record<string, Box>;
}

/** "Free" node: page root or `position: absolute|fixed`; the position comes from the style. */
export function isFreeNode(node: Node, isRoot: boolean): boolean {
  if (isRoot) return true;
  const pos = (node.style['position'] ?? '').trim();
  return pos === 'absolute' || pos === 'fixed';
}

/** Brings the viewBox to the box respecting `preserveAspectRatio` (as the browser draws it). */
function viewBoxMatrix(vector: Vector, box: Box): Matrix {
  const vb = vector.viewBox;
  const rx = vb.width ? box.width / vb.width : 1;
  const ry = vb.height ? box.height / vb.height : 1;
  const par = vectorPreserveAspectRatio(vector);
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
  /** Brings viewBox coordinates to the parent's space. */
  matrix: Matrix;
}

interface Context {
  sources: Source[];
  parentId: string | null;
  /** Parent style (for the result's containing block). */
  parentStyle: Record<string, string> | null;
  pageId: string;
  index: number;
  /** Some in-flow node came in with a measured box. */
  usedFlow: boolean;
}

const label = (n: Node): string => `"${n.name ?? n.id}"`;

/** Validates and sorts (parent order) the sibling svg nodes. `what` completes "before ___" in the refusal. */
function collectSources(
  doc: Document,
  nodeIds: string[],
  min: number,
  boxes: Record<string, Box> | undefined,
  what: string,
): Context {
  const ids = [...new Set(nodeIds)];
  if (ids.length < min) {
    throw new Error(`Select at least ${min} svg ${min === 1 ? 'node' : 'nodes'}`);
  }
  const found = ids.map((id) => {
    const p = findNode(doc, id);
    if (!p) throw new Error(`Node not found: "${id}"`);
    return p;
  });
  const first = found[0]!;
  for (const p of found) {
    if (p.node.type !== 'svg') throw new Error(`Node ${label(p.node)} is not an svg`);
    if ((p.parent?.id ?? null) !== (first.parent?.id ?? null) || p.page.id !== first.page.id) {
      throw new Error('The nodes must be siblings (have the same parent)');
    }
  }
  found.sort((a, b) => a.index - b.index);
  // a single node (flatten via setVector) does not depend on the position
  const multi = found.length > 1;
  let usedFlow = false;
  const sources = found.map((p): Source => {
    const vector = ensureVector(p.node);
    if (!vector || !isVectorEditable(vector)) {
      throw new Error(`Node ${label(p.node)} has no editable paths`);
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
        `Node ${label(p.node)} is in flow (no position: absolute); position it freely before ${what}`,
      );
    } else {
      box = nodeBoxInParent(p.node, isRoot);
    }
    if (!box) {
      throw new Error(`Could not determine the box of node ${label(p.node)} (width/height in px)`);
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

/** Multiplies each number of a dasharray by `k` (`"2 1"` × 2 = `"4 2"`). */
function scaleDash(dash: string, k: number): string {
  return dash.replace(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi, (n) =>
    String(Number((parseFloat(n) * k).toFixed(4))),
  );
}

/**
 * Brings thickness and dash to the parent's space: × matrix scale (`hypot(a, b)`, like
 * `importShape`). A visible stroke without `strokeWidth` is 1 in SVG, so it becomes the scale itself.
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

/** Builds the result node from paths already in the parent's space and emits the ops (create + delete). */
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
  // thicknesses already scaled (parent space)
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
    // root frame: the canvas position lives in `node.position` (without left/top/position)
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
  // the result is absolute in the parent: with measured in-flow nodes, the parent must be the containing block
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

/** Paint of a path (without id/d/fillRule). */
function paintOf(p: VectorPath): Omit<VectorPath, 'id' | 'd' | 'fillRule'> {
  const { id: _id, d: _d, fillRule: _fr, ...paint } = p;
  void _id;
  void _d;
  void _fr;
  return deepClone(paint);
}

/**
 * Boolean between sibling svg nodes (2 or more, with editable paths; nodes without `vector` use
 * `ensureVector`). Each path goes to the parent's space (node box × viewBox, respecting the
 * vector's `preserveAspectRatio`). Result: a new svg node, in place of the first (same
 * index), in the result's box, with the style of the bottom-most node (without left/top/width/height/
 * position) and the paint of its first path (thickness and dash × scale); the originals are
 * removed. Node order = parent order (the bottom one is the "first" of subtract).
 *
 * Position: free nodes (page root or `position: absolute|fixed`) use the style (root:
 * `node.position`). In-flow nodes require `opts.boxes` (box measured in the parent's padding box); without it,
 * it throws. With an in-flow node, the result is `position: absolute` in the parent (which becomes
 * `position: relative` if static) and the remaining siblings reflow. On the page root the
 * result uses `node.position`, like root frames. The result's viewBox starts at 0,0.
 * The result is flattened (straight segments only); `fillRule` is approximated (see `booleanPathData`).
 */
export function buildBooleanOps(
  doc: Document,
  nodeIds: string[],
  op: BooleanOp,
  opts: BuildOptions = {},
): { ops: Op[]; nodeId: string } {
  const ctx = collectSources(doc, nodeIds, 2, opts.boxes, 'the boolean operation');
  const items = ctx.sources.flatMap((s) =>
    s.vector.paths.map((p) => ({ d: p.d, matrix: s.matrix, fillRule: p.fillRule })),
  );
  const d = booleanPathData(op, items);
  if (!d) throw new Error('The result of the boolean operation is empty');
  const first = ctx.sources[0]!;
  const path: VectorPath = {
    id: 'p1',
    d,
    ...scalePaint(paintOf(first.vector.paths[0]!), first.matrix),
  };
  return buildResult(ctx, [path], opts.name ?? 'Boolean', opts.id);
}

/**
 * Flatten. One node: merges all paths into one (`d` concatenated, paint of the first), via
 * `setVector`. Several sibling svg nodes: a new node with the paths of all brought to the common space
 * (each keeps its paint, with thickness and dash × scale), in place of the bottom-most; the
 * originals are removed. Position and `opts.boxes`: see `buildBooleanOps`.
 */
export function buildFlattenOps(
  doc: Document,
  nodeIds: string[],
  opts: BuildOptions = {},
): { ops: Op[]; nodeId: string } {
  const ctx = collectSources(doc, nodeIds, 1, opts.boxes, 'flattening');
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
  return buildResult(ctx, paths, opts.name ?? 'Flattened vector', opts.id);
}
