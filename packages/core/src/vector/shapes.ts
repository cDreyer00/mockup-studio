/** Basic shapes as paths: rectangle, ellipse, line, polygon and star. */
import { createNode } from '../document.js';
import { deepClone } from '../clone.js';
import { newNodeId } from '../ids.js';
import type { Node, Vector, VectorPath } from '../types.js';
import { ellipsePathData, rectPathData, serializePathData } from './path.js';
import type { PathCommand } from './path.js';
import { setVectorPaint, vectorToSvg } from './svg.js';
import type { VectorPaintPatch } from './svg.js';

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'polygon' | 'star';

export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'line', 'polygon', 'star'];

export interface ShapeSpec {
  kind: ShapeKind;
  /** Shape box (> 0; a line accepts 0 on one of the axes). */
  width: number;
  height: number;
  /** rect: corner radius. */
  cornerRadius?: number;
  /** polygon: number of sides (3 to 64, default 3). */
  sides?: number;
  /** star: number of points (3 to 64, default 5). */
  points?: number;
  /** star: inner / outer radius (0.05 to 0.95, default 0.5). */
  innerRatio?: number;
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function assertSize(spec: ShapeSpec): void {
  const { width: w, height: h } = spec;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 0 || h < 0) {
    throw new Error('Invalid shape size: width and height must be finite numbers');
  }
  if (spec.kind === 'line' ? w === 0 && h === 0 : w === 0 || h === 0) {
    throw new Error('Invalid shape size: width and height must be greater than 0');
  }
}

/** Vertices of a polyline on a unit circle (starts at the top), fitted to the `w × h` box. */
function fitToBox(unit: [number, number][], w: number, h: number): PathCommand[] {
  const xs = unit.map((p) => p[0]);
  const ys = unit.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const cmds: PathCommand[] = unit.map(([x, y], i) => ({
    type: i === 0 ? 'M' : 'L',
    x: ((x - minX) / spanX) * w,
    y: ((y - minY) / spanY) * h,
  }));
  cmds.push({ type: 'Z' });
  return cmds;
}

/** Path data of the shape in the `0 0 width height` box (line: diagonal from 0,0 to width,height). */
export function shapePathData(spec: ShapeSpec): string {
  assertSize(spec);
  const { width: w, height: h } = spec;
  switch (spec.kind) {
    case 'rect': {
      const r = clamp(spec.cornerRadius ?? 0, 0, Math.min(w, h) / 2);
      return rectPathData(0, 0, w, h, r, r);
    }
    case 'ellipse':
      return ellipsePathData(w / 2, h / 2, w / 2, h / 2);
    case 'line':
      return serializePathData([
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: w, y: h },
      ]);
    case 'polygon': {
      const n = Math.round(clamp(spec.sides ?? 3, 3, 64));
      const unit: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        unit.push([Math.cos(a), Math.sin(a)]);
      }
      return serializePathData(fitToBox(unit, w, h));
    }
    case 'star': {
      const n = Math.round(clamp(spec.points ?? 5, 3, 64));
      const ratio = clamp(spec.innerRatio ?? 0.5, 0.05, 0.95);
      const unit: [number, number][] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (Math.PI * i) / n;
        const r = i % 2 === 0 ? 1 : ratio;
        unit.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      return serializePathData(fitToBox(unit, w, h));
    }
  }
}

/**
 * Vector of a shape: viewBox `0 0 w h` (line with stroke slack), one path `p1`.
 * Default paint: closed shapes `fill: #d9d9d9`, no stroke; line `stroke: #111111`, width 2,
 * no fill. `paint` overrides the default.
 *
 * Line: the viewBox gets slack of half the stroke (minimum 0.5) around the box
 * (`-pad -pad w+2pad h+2pad`), so the stroke and horizontal/vertical lines are not clipped.
 */
export function createShapeVector(spec: ShapeSpec, paint?: VectorPaintPatch): Vector {
  const d = shapePathData(spec);
  const isLine = spec.kind === 'line';
  const strokeWidth = paint?.strokeWidth ?? 2;
  const pad = isLine ? Math.max(strokeWidth / 2, 0.5) : 0;
  const path: VectorPath = isLine
    ? { id: 'p1', d, fill: 'none', stroke: '#111111', strokeWidth: 2 }
    : { id: 'p1', d, fill: '#d9d9d9' };
  const base: Vector = {
    viewBox: {
      x: pad ? -pad : 0,
      y: pad ? -pad : 0,
      width: spec.width + 2 * pad,
      height: spec.height + 2 * pad,
    },
    paths: [path],
  };
  return paint ? setVectorPaint(base, paint) : base;
}

/**
 * New `svg` node (tag `svg`, new `sv_...` id if `id` is absent) with `vector` and `svg = vectorToSvg(vector)`.
 * `style` is the node's CSS (e.g. position/left/top/width/height).
 */
export function createVectorNode(
  vector: Vector,
  opts: { name?: string; style?: Record<string, string>; id?: string } = {},
): Node {
  const node = createNode({
    id: opts.id ?? newNodeId('svg'),
    type: 'svg',
    tag: 'svg',
    name: opts.name ?? 'Vector',
    style: opts.style ?? {},
    svg: vectorToSvg(vector),
  });
  // createNode (document.ts) does not copy `vector`; assign here
  node.vector = deepClone(vector);
  return node;
}
