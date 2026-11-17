/**
 * viewBox ↔ screen mapping of an svg node drawn as an `<img>` (including `preserveAspectRatio`):
 * it is what the point-editing overlay uses to position anchors and handles over the drawing.
 */
import type { VectorViewBox } from '@mockup/core';
import type { Point, Rect } from './geometry';

export interface ViewMap {
  /** viewBox → screen scale per axis. */
  sx: number;
  sy: number;
  /** x_screen = sx · x_view + tx; y_screen = sy · y_view + ty. */
  tx: number;
  ty: number;
  toScreen(p: Point): Point;
  toView(p: Point): Point;
}

const ALIGN: Record<string, number> = { Min: 0, Mid: 0.5, Max: 1 };

/** `preserveAspectRatio` → alignment per axis (0, 0.5, 1) and meet/slice; `none` = no aspect ratio. */
export function parseAspect(
  value?: string,
): { none: true } | { none: false; ax: number; ay: number; slice: boolean } {
  const parts = (value ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts[0] === 'defer') parts.shift();
  const align = parts[0] ?? 'xMidYMid';
  if (align === 'none') return { none: true };
  const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(align);
  return {
    none: false,
    ax: m ? ALIGN[m[1]!]! : 0.5,
    ay: m ? ALIGN[m[2]!]! : 0.5,
    slice: parts[1] === 'slice',
  };
}

/**
 * How the browser fits the `viewBox` into the `rect` box (in screen px): uniform scale (meet) and
 * centered by default, or independent per axis with `preserveAspectRatio="none"`.
 */
export function makeViewMap(vb: VectorViewBox, rect: Rect, preserveAspectRatio?: string): ViewMap {
  const vw = vb.width || 1;
  const vh = vb.height || 1;
  const a = parseAspect(preserveAspectRatio);
  let sx = rect.w / vw;
  let sy = rect.h / vh;
  let tx = rect.x - vb.x * sx;
  let ty = rect.y - vb.y * sy;
  if (!a.none) {
    const s = a.slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s;
    sy = s;
    tx = rect.x + (rect.w - vw * s) * a.ax - vb.x * s;
    ty = rect.y + (rect.h - vh * s) * a.ay - vb.y * s;
  }
  return {
    sx,
    sy,
    tx,
    ty,
    toScreen: (p) => ({ x: p.x * sx + tx, y: p.y * sy + ty }),
    toView: (p) => ({ x: sx ? (p.x - tx) / sx : 0, y: sy ? (p.y - ty) / sy : 0 }),
  };
}
