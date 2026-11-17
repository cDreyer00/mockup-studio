/**
 * Pure canvas logic (no DOM or stores): screen↔world conversion, fitting, rules for
 * selection, marquee, resizing, flow insertion index and distance ruler.
 */
import type { Document, Node } from '@mockup/core';
import { getChain, getParent } from '../model/tree';

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Viewport {
  x: number;
  y: number;
  z: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 16;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/* ------------------------------------------------------------------ */
/* viewport                                                           */
/* ------------------------------------------------------------------ */

/** Point in screen coordinates (relative to the canvas) → world. */
export function screenToWorld(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.x) / vp.z, y: (p.y - vp.y) / vp.z };
}

export function worldToScreen(vp: Viewport, p: Point): Point {
  return { x: p.x * vp.z + vp.x, y: p.y * vp.z + vp.y };
}

export function rectToScreen(vp: Viewport, r: Rect): Rect {
  return { x: r.x * vp.z + vp.x, y: r.y * vp.z + vp.y, w: r.w * vp.z, h: r.h * vp.z };
}

/** New viewport with zoom `z`, keeping the screen point (px, py) fixed. */
export function zoomAtPoint(vp: Viewport, z: number, px: number, py: number): Viewport {
  const nz = clampZoom(z);
  const k = nz / vp.z;
  return { z: nz, x: px - (px - vp.x) * k, y: py - (py - vp.y) * k };
}

/** Viewport that fits `rect` (world) centered in an area `size`, with margin `padding`. */
export function fitRect(
  rect: Rect,
  size: { w: number; h: number },
  padding = 60,
  maxZoom = 1,
): Viewport {
  const rw = Math.max(1, rect.w);
  const rh = Math.max(1, rect.h);
  const availW = Math.max(1, size.w - padding * 2);
  const availH = Math.max(1, size.h - padding * 2);
  const z = clampZoom(Math.min(availW / rw, availH / rh, maxZoom));
  return {
    z,
    x: (size.w - rw * z) / 2 - rect.x * z,
    y: (size.h - rh * z) / 2 - rect.y * z,
  };
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `inner` is entirely inside `outer` (with slack `margin`). */
export function rectInside(outer: Rect, inner: Rect, margin = 0): boolean {
  return (
    inner.x >= outer.x + margin &&
    inner.y >= outer.y + margin &&
    inner.x + inner.w <= outer.x + outer.w - margin &&
    inner.y + inner.h <= outer.y + outer.h - margin
  );
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return rectInside(outer, inner, 0);
}

/* ------------------------------------------------------------------ */
/* marquee                                                            */
/* ------------------------------------------------------------------ */

/** Normalized rectangle between two points. */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Strict intersection (rectangles that only touch at the edges do not count). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Ids of the items whose rectangle intersects the marquee (in the order received). */
export function marqueeHits(items: readonly { id: string; rect: Rect }[], marquee: Rect): string[] {
  return items.filter((i) => rectsIntersect(i.rect, marquee)).map((i) => i.id);
}

/* ------------------------------------------------------------------ */
/* click selection                                                 */
/* ------------------------------------------------------------------ */

/** Chain from the root frame to the target, cut at the first locked node (which is not selectable). */
export function selectableChain(doc: Document, targetId: string): Node[] {
  const out: Node[] = [];
  for (const n of getChain(doc, targetId)) {
    if (n.locked) break;
    out.push(n);
  }
  return out;
}

/**
 * Figma-style click rule. With the current selection inside a parent that is in the chain, the click
 * selects the chain element right below that parent (siblings stay clickable); otherwise it selects
 * the direct child of the frame (or the frame itself). `deep` selects the target itself.
 * Returns `null` if nothing is selectable (locked target).
 */
export function resolveClickTarget(
  doc: Document,
  targetId: string,
  selection: readonly string[],
  opts: { deep?: boolean } = {},
): string | null {
  const chain = selectableChain(doc, targetId);
  if (chain.length === 0) return null;
  if (opts.deep) return chain[chain.length - 1]!.id;
  for (const s of selection) {
    const parent = getParent(doc, s);
    if (!parent) continue;
    const i = chain.findIndex((n) => n.id === parent.id);
    if (i >= 0) return chain[Math.min(i + 1, chain.length - 1)]!.id;
  }
  return (chain[1] ?? chain[0])!.id;
}

/** Double click: goes down one level in the chain or enters text editing. */
export function resolveDoubleClick(
  doc: Document,
  targetId: string,
  selection: readonly string[],
): { select: string | null; edit: string | null } {
  const chain = selectableChain(doc, targetId);
  if (chain.length === 0) return { select: null, edit: null };
  const i = chain.findIndex((n) => selection.includes(n.id));
  if (i < 0) return { select: (chain[1] ?? chain[0])!.id, edit: null };
  const cur = chain[i]!;
  const next = chain[i + 1];
  if (next) return { select: next.id, edit: null };
  if (cur.type === 'text' && selection.length === 1) return { select: null, edit: cur.id };
  return { select: null, edit: null };
}

/* ------------------------------------------------------------------ */
/* resize                                                       */
/* ------------------------------------------------------------------ */

export type HandleName = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: readonly HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Resulting rectangle from dragging the `handle` by (dx, dy). `fromCenter` (Alt) resizes
 * symmetrically; `keepRatio` (Shift) keeps the aspect ratio. Minimum size 1.
 */
export function resizeRect(
  rect: Rect,
  handle: HandleName,
  dx: number,
  dy: number,
  opts: { keepRatio?: boolean; fromCenter?: boolean } = {},
): Rect {
  const hx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const hy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const k = opts.fromCenter ? 2 : 1;
  let w = hx ? Math.max(1, rect.w + hx * dx * k) : rect.w;
  let h = hy ? Math.max(1, rect.h + hy * dy * k) : rect.h;
  if (opts.keepRatio && rect.w > 0 && rect.h > 0) {
    const ratio = rect.w / rect.h;
    if (hx && hy) {
      const s = Math.max(w / rect.w, h / rect.h);
      w = Math.max(1, rect.w * s);
      h = w / ratio;
      if (h < 1) {
        h = 1;
        w = ratio;
      }
    } else if (hx) {
      h = Math.max(1, w / ratio);
    } else if (hy) {
      w = Math.max(1, h * ratio);
    }
  }
  if (opts.fromCenter) {
    return { x: rect.x + rect.w / 2 - w / 2, y: rect.y + rect.h / 2 - h / 2, w, h };
  }
  const x = hx < 0 ? rect.x + rect.w - w : hx > 0 ? rect.x : rect.x + (rect.w - w) / 2;
  const y = hy < 0 ? rect.y + rect.h - h : hy > 0 ? rect.y : rect.y + (rect.h - h) / 2;
  return { x, y, w, h };
}

/** Maps `r` (inside the old box `from`) to the new box `to` (proportional scale). */
export function scaleRectToBox(r: Rect, from: Rect, to: Rect): Rect {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  return {
    x: to.x + (r.x - from.x) * sx,
    y: to.y + (r.y - from.y) * sy,
    w: Math.max(1, r.w * sx),
    h: Math.max(1, r.h * sy),
  };
}

/* ------------------------------------------------------------------ */
/* flow insertion                                                  */
/* ------------------------------------------------------------------ */

export type Axis = 'row' | 'column';

function distToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Insertion index (0..n) in the ORIGINAL list of siblings for the pointer. Considers only the siblings
 * that are not being moved (`movingIndices`): finds the one closest to the pointer and inserts before
 * or after it depending on its center on the main axis.
 */
export function computeInsertIndex(
  siblingRects: readonly Rect[],
  pointer: Point,
  axis: Axis,
  movingIndices: readonly number[] = [],
): number {
  let best = -1;
  let bestDist = Infinity;
  siblingRects.forEach((r, i) => {
    if (movingIndices.includes(i)) return;
    const d = distToRect(pointer, r);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  if (best < 0) return 0;
  const r = siblingRects[best]!;
  const before = axis === 'row' ? pointer.x < r.x + r.w / 2 : pointer.y < r.y + r.h / 2;
  return before ? best : best + 1;
}

/**
 * Insertion indicator line (rectangle with thickness 0 on the main axis) for the index
 * `gap` returned by `computeInsertIndex`.
 */
export function insertLineRect(
  siblingRects: readonly Rect[],
  gap: number,
  axis: Axis,
  movingIndices: readonly number[] = [],
): Rect | null {
  let prev = -1;
  for (let i = gap - 1; i >= 0; i--) {
    if (!movingIndices.includes(i)) {
      prev = i;
      break;
    }
  }
  let next = -1;
  for (let i = gap; i < siblingRects.length; i++) {
    if (!movingIndices.includes(i)) {
      next = i;
      break;
    }
  }
  const p = prev >= 0 ? siblingRects[prev]! : null;
  const n = next >= 0 ? siblingRects[next]! : null;
  if (!p && !n) return null;
  if (axis === 'column') {
    const ref = p ?? n!;
    const pEnd = p ? p.y + p.h : 0;
    const edge = p && n ? (n.y >= pEnd ? (pEnd + n.y) / 2 : pEnd) : p ? pEnd : n!.y;
    return { x: ref.x, y: edge, w: ref.w, h: 0 };
  }
  const ref = p ?? n!;
  const pEnd = p ? p.x + p.w : 0;
  const edge = p && n ? (n.x >= pEnd ? (pEnd + n.x) / 2 : pEnd) : p ? pEnd : n!.x;
  return { x: edge, y: ref.y, w: 0, h: ref.h };
}

export interface SiblingRect {
  /** Real index in `parent.children`. */
  index: number;
  rect: Rect;
}

/**
 * Combines `computeInsertIndex` with the conversion for `moveNodes`: `gap` is the index in the
 * original list of children; `moveIndex` is the `index` to send (applied after removing the moved nodes).
 */
export function resolveFlowInsert(
  siblings: readonly SiblingRect[],
  pointer: Point,
  axis: Axis,
  movingReal: readonly number[] = [],
): { gap: number; moveIndex: number; line: Rect | null } {
  const rects = siblings.map((s) => s.rect);
  const movingPos = siblings.flatMap((s, i) => (movingReal.includes(s.index) ? [i] : []));
  const g = computeInsertIndex(rects, pointer, axis, movingPos);
  const n = siblings.length;
  const gap = g < n ? siblings[g]!.index : n ? siblings[n - 1]!.index + 1 : 0;
  const moveIndex = gap - movingReal.filter((i) => i < gap).length;
  return { gap, moveIndex, line: insertLineRect(rects, g, axis, movingPos) };
}

/** `true` if moving `movingReal` to `moveIndex` does not change the order of the children. */
export function isNoopReorder(movingReal: readonly number[], moveIndex: number): boolean {
  const sorted = [...movingReal].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1]! + 1);
  return contiguous && sorted[0] === moveIndex;
}

/* ------------------------------------------------------------------ */
/* distance ruler (Alt)                                          */
/* ------------------------------------------------------------------ */

export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Distance in world units (design px), rounded. */
  value: number;
  axis: 'h' | 'v';
}

function mid(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi > lo ? (lo + hi) / 2 : (Math.min(a1, b1) + Math.max(a0, b0)) / 2;
}

/**
 * Distance lines between `a` and `b`. If one contains the other, the 4 distances between the
 * inner edges; otherwise, the horizontal and/or vertical gaps between facing edges.
 * `scale` converts the rectangles' space to world px (zoom, if they are on screen).
 */
export function distanceGuides(a: Rect, b: Rect, scale = 1): Guide[] {
  const val = (d: number): number => Math.round(d / scale);
  const guides: Guide[] = [];
  const nested = (outer: Rect, inner: Rect): void => {
    const cx = inner.x + inner.w / 2;
    const cy = inner.y + inner.h / 2;
    const l = inner.x - outer.x;
    const t = inner.y - outer.y;
    const r = outer.x + outer.w - (inner.x + inner.w);
    const bt = outer.y + outer.h - (inner.y + inner.h);
    guides.push({ x1: outer.x, y1: cy, x2: inner.x, y2: cy, value: val(l), axis: 'h' });
    guides.push({
      x1: inner.x + inner.w,
      y1: cy,
      x2: outer.x + outer.w,
      y2: cy,
      value: val(r),
      axis: 'h',
    });
    guides.push({ x1: cx, y1: outer.y, x2: cx, y2: inner.y, value: val(t), axis: 'v' });
    guides.push({
      x1: cx,
      y1: inner.y + inner.h,
      x2: cx,
      y2: outer.y + outer.h,
      value: val(bt),
      axis: 'v',
    });
  };
  if (rectContains(a, b)) {
    nested(a, b);
    return guides;
  }
  if (rectContains(b, a)) {
    nested(b, a);
    return guides;
  }
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const [l, r] = a.x < b.x ? [a, b] : [b, a];
    const y = mid(a.y, a.y + a.h, b.y, b.y + b.h);
    guides.push({ x1: l.x + l.w, y1: y, x2: r.x, y2: y, value: val(r.x - (l.x + l.w)), axis: 'h' });
  }
  if (a.y + a.h <= b.y || b.y + b.h <= a.y) {
    const [t, bt] = a.y < b.y ? [a, b] : [b, a];
    const x = mid(a.x, a.x + a.w, b.x, b.x + b.w);
    guides.push({
      x1: x,
      y1: t.y + t.h,
      x2: x,
      y2: bt.y,
      value: val(bt.y - (t.y + t.h)),
      axis: 'v',
    });
  }
  return guides;
}
