/**
 * Pen tool: live state (store), pointer/keyboard events and path completion.
 * The pure logic is in `pen.ts`; the live drawing is in `PenOverlay.tsx`. On completion, the svg node
 * goes into the parent under the first click with a single `applySafe` call.
 */
import { create } from 'zustand';
import { daemon } from '../client/daemon';
import { isEditableTarget } from '../shortcuts/guards';
import { useDoc } from '../state/docStore';
import { currentPageId } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { clientToWorld, findNodeEl, getCanvasRoot, measureWorldRect } from './dom';
import type { Point } from './geometry';
import {
  PEN_CLOSE_RADIUS,
  PEN_DRAG_THRESHOLD,
  PEN_EMPTY,
  PEN_MIN_GAP,
  addAnchor,
  buildPenNode,
  canFinish,
  closePen,
  constrainAngle,
  dragLastHandles,
  isNearFirst,
  removeLastAnchor,
} from './pen';
import type { PenState } from './pen';
import { buildCreateOps, planPlacement } from './placement';

export interface PenStore {
  state: PenState;
  /** Pointer in world coordinates (preview of the next segment). */
  cursor: Point | null;
  /** First click: world and window (decide the node's parent). */
  first: { world: Point; client: Point } | null;
}

export const usePen = create<PenStore>(() => ({ state: PEN_EMPTY, cursor: null, first: null }));

export function penReset(): void {
  usePen.setState({ state: PEN_EMPTY, cursor: null, first: null });
}

const zoom = (): number => useUi.getState().viewport.z;

/** Origin (world) of the coordinate system of the parent's absolute children: padding edge. */
function parentOrigin(root: HTMLElement, parentId: string): Point {
  const rect = measureWorldRect(root, parentId);
  const el = findNodeEl(root, parentId);
  return { x: (rect?.x ?? 0) + (el?.clientLeft ?? 0), y: (rect?.y ?? 0) + (el?.clientTop ?? 0) };
}

/** Pointer movement without a button: updates the preview of the next segment. */
export function penPointerMove(e: PointerEvent, root: HTMLElement): void {
  const s = usePen.getState();
  if (s.state.anchors.length === 0) return;
  let w = clientToWorld(root, e.clientX, e.clientY);
  const last = s.state.anchors[s.state.anchors.length - 1]!;
  if (e.shiftKey) w = constrainAngle(last, w);
  usePen.setState({ cursor: w });
}

/**
 * Pressing the button: closes (first anchor) or appends an anchor and follows the drag, which
 * creates symmetric handles (Alt breaks the symmetry).
 */
export function penPointerDown(e: PointerEvent, root: HTMLElement): void {
  const doc = useDoc.getState().doc;
  if (!doc) return;
  const toWorld = (ev: { clientX: number; clientY: number }): Point =>
    clientToWorld(root, ev.clientX, ev.clientY);
  const z = zoom();
  const w = toWorld(e);
  const cur = usePen.getState();

  if (isNearFirst(cur.state, w, PEN_CLOSE_RADIUS / z)) {
    usePen.setState({ state: closePen(cur.state) });
    void penFinish();
    return;
  }
  if (cur.state.anchors.length === 0) {
    // The first click decides the parent: with no container under the pointer, it warns and does not start.
    const plan = planPlacement(doc, w, { x: e.clientX, y: e.clientY });
    if (!plan.parentId) {
      ui.toast('Click inside a frame to draw the path', 'info');
      return;
    }
  }
  const next = addAnchor(cur.state, w, { minGap: PEN_MIN_GAP / z, shift: e.shiftKey });
  if (next === cur.state) return;
  usePen.setState({
    state: next,
    cursor: null,
    first: cur.first ?? { world: w, client: { x: e.clientX, y: e.clientY } },
  });

  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  const onMove = (ev: PointerEvent): void => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < PEN_DRAG_THRESHOLD)
      return;
    dragging = true;
    usePen.setState({ state: dragLastHandles(usePen.getState().state, toWorld(ev), ev.altKey) });
  };
  const stop = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

/** Finishes the current path (open or closed) and creates the svg node. Fewer than 2 anchors: discards. */
export async function penFinish(): Promise<void> {
  const { state, first } = usePen.getState();
  penReset();
  if (useUi.getState().tool === 'pen') ui.setTool('select');
  if (!canFinish(state) || !first) return;
  const doc = useDoc.getState().doc;
  const pageId = currentPageId();
  const root = getCanvasRoot();
  if (!doc || !pageId || !root) return;
  const plan = planPlacement(doc, first.world, first.client);
  if (!plan.parentId) {
    ui.toast('Click inside a frame to draw the path', 'info');
    return;
  }
  const origin = plan.flow ? { x: 0, y: 0 } : parentOrigin(root, plan.parentId);
  const { node } = buildPenNode(state, origin, { flow: plan.flow });
  const ack = await daemon.applySafe(buildCreateOps(pageId, plan, node));
  if (ack) ui.select([node.id]);
}

/** Double click: finishes (the 2nd click of the double was already ignored for being over the last anchor). */
export function penDoubleClick(): void {
  if (canFinish(usePen.getState().state)) void penFinish();
}

/**
 * Pen keys (captured on `window`, before the global shortcuts): Enter/Esc finish,
 * Backspace removes the last anchor. Only acts with a path in progress.
 */
export function attachPenKeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const s = usePen.getState().state;
    if (s.anchors.length === 0) return;
    const swallow = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Enter' || e.key === 'Escape') {
      swallow();
      if (canFinish(s)) void penFinish();
      else if (e.key === 'Escape') penReset();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      swallow();
      const next = removeLastAnchor(s);
      usePen.setState({
        state: next,
        cursor: usePen.getState().cursor,
        ...(next.anchors.length === 0 ? { first: null } : {}),
      });
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
