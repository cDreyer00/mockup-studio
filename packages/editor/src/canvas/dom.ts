/** Canvas DOM measurements (node rectangles in world coordinates). */
import { useUi } from '../state/uiStore';
import type { Point, Rect } from './geometry';

export function getCanvasRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="canvas"]');
}

export function findNodeEl(root: ParentNode, id: string): HTMLElement | null {
  const safe = id.replace(/["\\]/g, (c) => '\\' + c);
  return root.querySelector<HTMLElement>(`[data-node-id="${safe}"]`);
}

/** Node rectangle in world coordinates: `(screen - canvas topLeft - (x, y)) / z`. */
export function measureWorldRect(root: HTMLElement, id: string): Rect | null {
  const el = findNodeEl(root, id);
  if (!el) return null;
  const rr = root.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  const { x, y, z } = useUi.getState().viewport;
  return {
    x: (b.left - rr.left - x) / z,
    y: (b.top - rr.top - y) / z,
    w: b.width / z,
    h: b.height / z,
  };
}

/** Client (window) coordinates → world. */
export function clientToWorld(root: HTMLElement, cx: number, cy: number): Point {
  const rr = root.getBoundingClientRect();
  const { x, y, z } = useUi.getState().viewport;
  return { x: (cx - rr.left - x) / z, y: (cy - rr.top - y) / z };
}

/** World → client (window) coordinates. */
export function worldToClient(root: HTMLElement, p: Point): Point {
  const rr = root.getBoundingClientRect();
  const { x, y, z } = useUi.getState().viewport;
  return { x: p.x * z + x + rr.left, y: p.y * z + y + rr.top };
}
