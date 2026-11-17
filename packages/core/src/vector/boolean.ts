/** Boolean operations between paths (via `polygon-clipping`; curves are flattened). */
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Polygon } from 'polygon-clipping';
import type { VectorPath } from '../types.js';
import { flattenPath, formatNumber, transformPathData } from './path.js';
import type { Matrix } from './path.js';

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'exclude';

export const BOOLEAN_OPS: readonly BooleanOp[] = ['union', 'subtract', 'intersect', 'exclude'];

export interface BooleanItem {
  d: string;
  /** Brings the path to the common space (default: identity). */
  matrix?: Matrix;
  fillRule?: VectorPath['fillRule'];
}

/**
 * Converts an item into a MultiPolygon: each subpath becomes a ring (open subpaths are closed, as
 * in the SVG fill). Approximation of the fill rules: `evenodd` combines the rings with
 * xor (holes by parity); `nonzero` (default) unions the rings, so an inner subpath with the
 * opposite direction, which in SVG would be a hole, is absorbed by the union.
 */
function itemToMultiPolygon(item: BooleanItem, tolerance: number): MultiPolygon {
  const d = item.matrix ? transformPathData(item.d, item.matrix, 6) : item.d;
  const rings: Polygon[] = [];
  for (const poly of flattenPath(d, tolerance)) {
    if (poly.points.length < 3) continue;
    rings.push([poly.points.map((p) => [p[0], p[1]] as [number, number])]);
  }
  if (rings.length === 0) return [];
  if (rings.length === 1) return [rings[0]!];
  const [first, ...rest] = rings as [Polygon, ...Polygon[]];
  return item.fillRule === 'evenodd'
    ? polygonClipping.xor(first, ...rest)
    : polygonClipping.union(first, ...rest);
}

function ringToPath(ring: [number, number][]): string {
  // polygon-clipping repeats the first point at the end of the ring; Z already closes it
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  const pts = ring.length > 1 && a[0] === b[0] && a[1] === b[1] ? ring.slice(0, -1) : ring;
  const cmds = pts.map(
    (p, i) => `${i === 0 ? 'M' : 'L'} ${formatNumber(p[0], 3)} ${formatNumber(p[1], 3)}`,
  );
  return `${cmds.join(' ')} Z`;
}

/**
 * Result as path data (common space), closed subpaths. `subtract` = first minus the rest;
 * `exclude` = xor. Empty result = `''`. Needs at least 2 items.
 * Curves are flattened (`tolerance`): the result only has straight segments.
 */
export function booleanPathData(op: BooleanOp, items: BooleanItem[], tolerance = 0.25): string {
  if (items.length < 2) throw new Error('The boolean operation needs at least 2 shapes');
  const geoms = items.map((it) => itemToMultiPolygon(it, tolerance));
  const nonEmpty = geoms.filter((g) => g.length > 0);
  let result: MultiPolygon = [];
  switch (op) {
    case 'union':
      if (nonEmpty.length) result = polygonClipping.union(nonEmpty[0]!, ...nonEmpty.slice(1));
      break;
    case 'exclude':
      if (nonEmpty.length) result = polygonClipping.xor(nonEmpty[0]!, ...nonEmpty.slice(1));
      break;
    case 'intersect':
      if (nonEmpty.length === geoms.length) {
        result = polygonClipping.intersection(geoms[0]!, ...geoms.slice(1));
      }
      break;
    case 'subtract':
      if (geoms[0]!.length > 0) {
        result = polygonClipping.difference(
          geoms[0]!,
          ...geoms.slice(1).filter((g) => g.length > 0),
        );
      }
      break;
    default:
      throw new Error(`Unknown boolean operation: "${String(op)}"`);
  }
  return result.flatMap((poly) => poly.map((ring) => ringToPath(ring))).join(' ');
}
