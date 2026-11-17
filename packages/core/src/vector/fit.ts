/** Fits the viewBox to the content, keeping the scale between the viewBox and the node box. */
import type { Vector } from '../types.js';
import { editVector } from './svg.js';
import { pathBounds } from './path.js';
import type { Box } from './path.js';

/**
 * Recomputes the viewBox as the box of the paths (plus `padding`, default: half of the largest stroke) and
 * returns the new node box in px in the parent, with the same `box.width / viewBox.width` scale (and
 * height) as before, so that the drawing stays still on screen. Empty paths: returns it unchanged.
 * The resulting vector has no `raw`.
 */
export function fitVectorToContent(
  v: Vector,
  box: Box,
  opts: { padding?: number } = {},
): { vector: Vector; box: Box } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of v.paths) {
    const b = pathBounds(p.d);
    if (b.width === 0 && b.height === 0 && !p.d.trim()) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return { vector: v, box };
  const maxStroke = Math.max(0, ...v.paths.map((p) => p.strokeWidth ?? 0));
  const pad = opts.padding ?? maxStroke / 2;
  const viewBox = {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
  const sx = v.viewBox.width ? box.width / v.viewBox.width : 1;
  const sy = v.viewBox.height ? box.height / v.viewBox.height : 1;
  return {
    vector: editVector(v, { viewBox }),
    box: {
      x: box.x + (viewBox.x - v.viewBox.x) * sx,
      y: box.y + (viewBox.y - v.viewBox.y) * sy,
      width: viewBox.width * sx,
      height: viewBox.height * sy,
    },
  };
}
