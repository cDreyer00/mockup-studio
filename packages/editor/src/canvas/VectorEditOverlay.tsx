import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { ensureVector, subpathsToPath } from '@mockup/core';
import type { Node, Vector } from '@mockup/core';
import { daemon } from '../client/daemon';
import { isEditableTarget } from '../shortcuts/guards';
import { useNode } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { measureWorldRect } from './dom';
import { rectToScreen } from './geometry';
import type { Point, Rect } from './geometry';
import {
  buildVectorEditOps,
  deleteAnchors,
  flatSubpaths,
  hitSegment,
  insertAnchor,
  isSmooth,
  loadModel,
  modelToVector,
  moveAnchors,
  moveHandle,
  refKey,
  sameRef,
  toggleSmooth,
} from './vectorEdit';
import type { AnchorRef, EditModel, HandleKind } from './vectorEdit';
import { makeViewMap } from './vectorMap';
import type { ViewMap } from './vectorMap';
import './vector.css';

/** Minimum displacement (screen px) for a click to become a drag. */
const DRAG_THRESHOLD = 2;
/** Click tolerance (screen px) on a segment to insert an anchor. */
const SEGMENT_TOLERANCE = 6;

export const COMPLEX_SVG_MESSAGE =
  'This SVG is complex (filters, masks, text...) and has no editable paths: edit the markup.';

function tryEnsure(node: Node): Vector | null {
  try {
    return ensureVector(node);
  } catch {
    return null;
  }
}

function tryLoad(v: Vector | null): EditModel | null {
  if (!v || v.paths.length === 0) return null;
  try {
    return loadModel(v);
  } catch {
    return null;
  }
}

/** Point editing of the svg node in `editingVectorId`: anchors and handles over the drawing. */
export function VectorEditOverlay({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const id = useUi((s) => s.editingVectorId);
  const node = useNode(id);
  if (!id || !node || node.type !== 'svg') return null;
  return <Editor key={id} node={node} rootRef={rootRef} />;
}

function Editor({ node, rootRef }: { node: Node; rootRef: RefObject<HTMLDivElement | null> }) {
  const vp = useUi((s) => s.viewport);
  const preview = useUi((s) => s.preview[node.id]);
  const vector = useMemo(() => tryEnsure(node), [node]);
  const base = useMemo(() => tryLoad(vector), [vector]);
  const [draft, setDraft] = useState<EditModel | null>(null);
  const [sel, setSel] = useState<AnchorRef[]>([]);
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ cancel(): void } | null>(null);
  const latest = useRef({ node, vector, base, sel });
  latest.current = { node, vector, base, sel };

  // SVG without editable paths: warns and exits the mode.
  useEffect(() => {
    if (!base) {
      ui.toast(COMPLEX_SVG_MESSAGE, 'info');
      ui.editVector(null);
    }
  }, [base]);

  // Exit if the selection stops being just this node.
  useEffect(
    () =>
      useUi.subscribe((s, p) => {
        if (
          s.selection !== p.selection &&
          !(s.selection.length === 1 && s.selection[0] === node.id)
        )
          ui.editVector(null);
      }),
    [node.id],
  );

  // Node box in the world (re-measures when the node or the preview change; again on the next frame).
  useLayoutEffect(() => {
    const measure = (): void => {
      const root = rootRef.current;
      const r = root ? measureWorldRect(root, node.id) : null;
      setRect((prev) =>
        prev && r && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h
          ? prev
          : r,
      );
    };
    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [node, preview, rootRef]);

  const absolute = node.style.position === 'absolute' || node.style.position === 'fixed';

  const commit = async (model: EditModel, v: Vector): Promise<void> => {
    const empty = model.paths.length === 0;
    const ops = empty
      ? [{ type: 'deleteNodes' as const, nodeIds: [latest.current.node.id] }]
      : buildVectorEditOps(latest.current.node, modelToVector(v, model), { absolute });
    if (empty) ui.editVector(null);
    await daemon.applySafe(ops);
    setDraft(null);
  };

  // Keys (capture, before the global shortcuts): Esc/Enter exit, Delete removes anchors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const swallow = (): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Escape') {
        swallow();
        if (drag.current) {
          drag.current.cancel();
          return;
        }
        ui.editVector(null);
      } else if (e.key === 'Enter') {
        swallow();
        ui.editVector(null);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        swallow();
        const { base: b, vector: v, sel: s } = latest.current;
        if (!b || !v || s.length === 0) return;
        setSel([]);
        void commit(deleteAnchors(b, s), v);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // only on mount: the handler reads the current state via `latest`
  }, []);

  if (!vector || !base || !rect) return null;

  const screenRect = rectToScreen(vp, rect);
  const map: ViewMap = makeViewMap(vector.viewBox, screenRect, vector.attrs?.preserveAspectRatio);
  const shown = draft ?? base;
  const subs = flatSubpaths(shown);
  const local = (e: { clientX: number; clientY: number }): Point => {
    const rr = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rr?.left ?? 0), y: e.clientY - (rr?.top ?? 0) };
  };

  /** Drag with threshold; `update` receives the displacement in viewBox units. */
  const startDrag = (
    e: ReactPointerEvent,
    update: (d: Point, ev: PointerEvent) => EditModel,
    onClick?: () => void,
  ): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = local(e);
    const startView = map.toView(start);
    let moved = false;
    let model: EditModel | null = null;
    const onMove = (ev: PointerEvent): void => {
      const p = local(ev);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD) return;
      moved = true;
      const v = map.toView(p);
      model = update({ x: v.x - startView.x, y: v.y - startView.y }, ev);
      setDraft(model);
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      drag.current = null;
    };
    const onUp = (): void => {
      stop();
      if (moved && model) void commit(model, vector);
      else onClick?.();
    };
    const onCancel = (): void => {
      stop();
      setDraft(null);
    };
    drag.current = { cancel: onCancel };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const onAnchorDown = (e: ReactPointerEvent, ref: AnchorRef): void => {
    const selected = sel.some((r) => sameRef(r, ref));
    let moving = sel;
    if (e.shiftKey) {
      // Shift adds to/removes from the selection (without dragging).
      setSel(selected ? sel.filter((r) => !sameRef(r, ref)) : [...sel, ref]);
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (!selected) {
      moving = [ref];
      setSel(moving);
    }
    startDrag(e, (d) => moveAnchors(base, moving, d.x, d.y));
  };

  const onHandleDown = (e: ReactPointerEvent, ref: AnchorRef, kind: HandleKind): void => {
    const a = flatSubpaths(base)[ref.s]?.anchors[ref.i];
    const h = a?.[kind];
    if (!h) return;
    startDrag(e, (d, ev) => moveHandle(base, ref, kind, { x: h.x + d.x, y: h.y + d.y }, ev.altKey));
  };

  const onSegmentDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const hit = hitSegment(base, map.toView(local(e)), SEGMENT_TOLERANCE / Math.max(map.sx, 1e-6));
    if (!hit) return;
    setSel([{ s: hit.s, i: hit.seg + 1 }]);
    void commit(insertAnchor(base, hit.s, hit.seg, hit.t), vector);
  };

  const pathD = (s: number): string => {
    const sp = subs[s]!;
    return subpathsToPath(
      [
        {
          closed: sp.closed,
          anchors: sp.anchors.map((a) => ({
            ...map.toScreen(a),
            ...(a.in ? { in: map.toScreen(a.in) } : {}),
            ...(a.out ? { out: map.toScreen(a.out) } : {}),
          })),
        },
      ],
      2,
    );
  };

  return (
    <div className="cv-overlay cv-vedit" data-testid="vector-edit-overlay" data-vector-overlay>
      <svg className="cv-vsvg" width="100%" height="100%">
        {subs.map((_, s) => (
          <path key={`o${s}`} className="cv-vedit-path" d={pathD(s)} />
        ))}
        {subs.map((sp, s) =>
          sp.anchors.flatMap((a, i) =>
            (['in', 'out'] as const).map((k) => {
              const h = a[k];
              if (!h) return null;
              const from = map.toScreen(a);
              const to = map.toScreen(h);
              return (
                <line
                  key={`l${s}-${i}-${k}`}
                  className="cv-handle-line"
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
              );
            }),
          ),
        )}
        {subs.map((_, s) => (
          <path
            key={`h${s}`}
            className="cv-vedit-hit"
            data-testid={`vector-segment-${s}`}
            d={pathD(s)}
            onPointerDown={onSegmentDown}
          />
        ))}
      </svg>
      {subs.map((sp, s) =>
        sp.anchors.map((a, i) => {
          const ref: AnchorRef = { s, i };
          const p = map.toScreen(a);
          return (
            <div key={`a${refKey(ref)}`}>
              {(['in', 'out'] as const).map((k) => {
                const h = a[k];
                if (!h) return null;
                const hp = map.toScreen(h);
                return (
                  <div
                    key={k}
                    className="cv-vhandle"
                    data-testid={`vector-handle-${s}-${i}-${k}`}
                    style={{ left: hp.x, top: hp.y }}
                    onPointerDown={(e) => onHandleDown(e, ref, k)}
                  />
                );
              })}
              <div
                className={`cv-vanchor${sel.some((r) => sameRef(r, ref)) ? ' selected' : ''}${isSmooth(a) ? ' smooth' : ''}`}
                data-testid={`vector-anchor-${s}-${i}`}
                style={{ left: p.x, top: p.y }}
                onPointerDown={(e) => onAnchorDown(e, ref)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  void commit(toggleSmooth(base, ref), vector);
                }}
              />
            </div>
          );
        }),
      )}
    </div>
  );
}
