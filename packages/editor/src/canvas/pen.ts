/**
 * Pen tool state machine (pure logic, no DOM): anchors in world coordinates, symmetric
 * Bézier handles when dragging, closing, removal of the last anchor and svg node assembly.
 * The live drawing (`PenOverlay`) and the pointer events (`penTool`) live in other modules.
 */
import { createVectorNode, fitVectorToContent, subpathsToPath } from '@mockup/core';
import type { Node, PathAnchor, Subpath, Vector } from '@mockup/core';
import type { Point } from './geometry';

export interface PenState {
  anchors: PathAnchor[];
  closed: boolean;
}

export const PEN_EMPTY: PenState = { anchors: [], closed: false };

/** Radius (screen px) around the first anchor that closes the path. */
export const PEN_CLOSE_RADIUS = 8;
/** Minimum displacement (screen px) for a click to become a handle drag. */
export const PEN_DRAG_THRESHOLD = 3;
/** Minimum distance (screen px) to accept a new anchor (ignores the 2nd click of a double click). */
export const PEN_MIN_GAP = 2;

/** Default path ink: #111111 stroke of 2 px; closed paths get a #d9d9d9 fill. */
export const PEN_STROKE = '#111111';
export const PEN_STROKE_WIDTH = 2;
export const PEN_FILL = '#d9d9d9';

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Snaps `to` to the nearest multiple of 45° (around `from`), preserving the length. */
export function constrainAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...to };
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

/**
 * Appends a straight anchor. Ignores the point if the path is already closed or if it falls less than
 * `minGap` (world) from the last anchor. With `shift` the point is constrained to multiples of 45° from the last one.
 */
export function addAnchor(
  s: PenState,
  p: Point,
  opts: { minGap?: number; shift?: boolean } = {},
): PenState {
  if (s.closed) return s;
  const last = s.anchors[s.anchors.length - 1];
  let at = p;
  if (last && opts.shift) at = constrainAngle(last, p);
  if (last && dist(last, at) < (opts.minGap ?? 0)) return s;
  return { ...s, anchors: [...s.anchors, { x: at.x, y: at.y }] };
}

/**
 * Drag right after creating the last anchor: `out` goes to `p` and `in` to the symmetric point around
 * the anchor. With `alt` the symmetry breaks: only `out` changes (`in` stays as it was).
 */
export function dragLastHandles(s: PenState, p: Point, alt = false): PenState {
  const i = s.anchors.length - 1;
  const a = s.anchors[i];
  if (!a) return s;
  const next: PathAnchor = { x: a.x, y: a.y, out: { x: p.x, y: p.y } };
  if (a.in) next.in = a.in;
  if (!alt) next.in = { x: 2 * a.x - p.x, y: 2 * a.y - p.y };
  const anchors = s.anchors.slice();
  anchors[i] = next;
  return { ...s, anchors };
}

/** Is the point over the first anchor (and are there enough anchors to close)? */
export function isNearFirst(s: PenState, p: Point, radius: number): boolean {
  const first = s.anchors[0];
  return !s.closed && s.anchors.length >= 2 && !!first && dist(first, p) <= radius;
}

export function closePen(s: PenState): PenState {
  return s.anchors.length >= 2 ? { ...s, closed: true } : s;
}

export function removeLastAnchor(s: PenState): PenState {
  if (s.anchors.length === 0) return s;
  return { anchors: s.anchors.slice(0, -1), closed: false };
}

/** An open path needs 2 anchors; so does a closed one (the machine only closes with 2 or more). */
export function canFinish(s: PenState): boolean {
  return s.anchors.length >= 2;
}

export function penSubpath(s: PenState): Subpath {
  return { anchors: s.anchors.map((a) => ({ ...a })), closed: s.closed };
}

/**
 * Path data (`M .. C/L ..`) of the preview segment from the last anchor to `cursor`; with `closing` the
 * destination is the first anchor and uses its incoming handle. Same coordinate system as the
 * anchors of `s`. Empty if there are no anchors or the path is already closed.
 */
export function previewSegmentD(s: PenState, cursor: Point, closing = false): string {
  const last = s.anchors[s.anchors.length - 1];
  if (!last || s.closed) return '';
  const first = s.anchors[0]!;
  const to = closing ? first : cursor;
  const c1 = last.out;
  const c2 = closing ? first.in : undefined;
  const f = (n: number): number => Math.round(n * 1000) / 1000;
  if (!c1 && !c2) return `M ${f(last.x)} ${f(last.y)} L ${f(to.x)} ${f(to.y)}`;
  const a = c1 ?? last;
  const b = c2 ?? to;
  return `M ${f(last.x)} ${f(last.y)} C ${f(a.x)} ${f(a.y)} ${f(b.x)} ${f(b.y)} ${f(to.x)} ${f(to.y)}`;
}

export function translateAnchors(anchors: PathAnchor[], dx: number, dy: number): PathAnchor[] {
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return anchors.map((a) => ({
    ...mv(a),
    ...(a.in ? { in: mv(a.in) } : {}),
    ...(a.out ? { out: mv(a.out) } : {}),
  }));
}

/**
 * svg node of the finished path. The anchors come in world coordinates; `origin` is the parent's origin
 * (world) to convert them. `flow`: the node enters the parent's flow (width/height only); otherwise it is
 * `position: absolute` at left/top. Also returns the final box (in the parent).
 */
export function buildPenNode(
  s: PenState,
  origin: Point,
  opts: { flow?: boolean; name?: string } = {},
): { node: Node; box: { x: number; y: number; width: number; height: number } } {
  const anchors = translateAnchors(s.anchors, -origin.x, -origin.y);
  const d = subpathsToPath([{ anchors, closed: s.closed }]);
  const draft: Vector = {
    // viewBox identical to the box (scale 1): the path coordinates are already the parent's.
    viewBox: { x: 0, y: 0, width: 1, height: 1 },
    paths: [
      {
        id: 'p1',
        d,
        fill: s.closed ? PEN_FILL : 'none',
        stroke: PEN_STROKE,
        strokeWidth: PEN_STROKE_WIDTH,
      },
    ],
  };
  const fit = fitVectorToContent(draft, { x: 0, y: 0, width: 1, height: 1 });
  const num = (n: number): string => `${Math.round(n * 100) / 100}px`;
  const style: Record<string, string> = {
    width: num(fit.box.width),
    height: num(fit.box.height),
  };
  if (opts.flow) style.display = 'block';
  else {
    style.position = 'absolute';
    style.left = num(fit.box.x);
    style.top = num(fit.box.y);
  }
  const node = createVectorNode(fit.vector, { name: opts.name ?? 'Path', style });
  return { node, box: fit.box };
}
