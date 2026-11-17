import { isGridContainer } from '@mockup/core';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { flushSync } from 'react-dom';
import { getNode, getParent, isLockedDeep } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { measureWorldRect } from './dom';
import { rectToScreen } from './geometry';
import type { Rect } from './geometry';
import {
  currentPlacement,
  measureGridWorld,
  placementRect,
  startSpanDrag,
  useGridFx,
} from './gridDrag';
import type { GridWorld, SpanEdge } from './gridDrag';

interface Shown {
  /** Grid container whose tracks are shown. */
  gw: GridWorld;
  /** Selected child (span handles) and the cell/extent it occupies, in world coordinates. */
  child: { id: string; cell: Rect; locked: boolean } | null;
}

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function sameTracks(a: GridWorld['grid']['columns'], b: GridWorld['grid']['columns']): boolean {
  return (
    a.length === b.length && a.every((t, i) => t.start === b[i]!.start && t.size === b[i]!.size)
  );
}

function sameShown(a: Shown | null, b: Shown | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    sameRect(a.gw.rect, b.gw.rect) &&
    sameTracks(a.gw.grid.columns, b.gw.grid.columns) &&
    sameTracks(a.gw.grid.rows, b.gw.grid.rows) &&
    a.gw.grid.columnGap === b.gw.grid.columnGap &&
    a.gw.grid.rowGap === b.gw.grid.rowGap &&
    (a.child === b.child ||
      (!!a.child &&
        !!b.child &&
        a.child.id === b.child.id &&
        a.child.locked === b.child.locked &&
        sameRect(a.child.cell, b.child.cell)))
  );
}

/** Grid to show: the selected one, if it is a grid, or the grid parent of the selected child. */
function measure(root: HTMLElement): Shown | null {
  const { selection } = useUi.getState();
  const doc = useDoc.getState().doc;
  if (!doc || selection.length !== 1) return null;
  const id = selection[0]!;
  const node = getNode(doc, id);
  if (!node) return null;
  if (isGridContainer(node.style)) {
    const gw = measureGridWorld(root, id);
    return gw ? { gw, child: null } : null;
  }
  const parent = getParent(doc, id);
  if (!parent || !isGridContainer(parent.style)) return null;
  const gw = measureGridWorld(root, parent.id);
  if (!gw) return null;
  const cell = placementRect(
    gw.grid,
    currentPlacement(gw.grid, measureWorldRect(root, id), node.style),
  );
  return cell ? { gw, child: { id, cell, locked: isLockedDeep(doc, id) } } : null;
}

const px = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

/**
 * Tracks of the selected grid (columns and rows, with the gaps between them) measured from the DOM, the cell
 * highlight during drags and the span handles of a selected grid's child.
 */
export function GridOverlay({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const raf = useRef(0);
  const vp = useUi((s) => s.viewport);
  const tool = useUi((s) => s.tool);
  const editing = useUi((s) => s.editingTextId);
  const dropCell = useGridFx((s) => s.cell);

  useEffect(() => {
    const run = (): void => {
      raf.current = 0;
      const root = rootRef.current;
      if (!root) return;
      const next = measure(root);
      flushSync(() => setShown((prev) => (sameShown(prev, next) ? prev : next)));
    };
    const schedule = (): void => {
      if (!raf.current) raf.current = requestAnimationFrame(run);
    };
    schedule();
    const offUi = useUi.subscribe((s, p) => {
      if (s.selection !== p.selection || s.preview !== p.preview || s.pageId !== p.pageId)
        schedule();
    });
    const offDoc = useDoc.subscribe((s, p) => {
      if (s.doc !== p.doc) schedule();
    });
    const root = rootRef.current;
    root?.addEventListener('load', schedule, true);
    return () => {
      offUi();
      offDoc();
      root?.removeEventListener('load', schedule, true);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [rootRef]);

  if (!shown) return null;
  const { gw, child } = shown;
  const { columns, rows } = gw.grid;
  const first = columns[0];
  const last = columns[columns.length - 1];
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  if (!first || !last || !firstRow || !lastRow) return null;
  const spanX = first.start;
  const spanW = last.start + last.size - first.start;
  const spanY = firstRow.start;
  const spanH = lastRow.start + lastRow.size - firstRow.start;
  const screen = (r: Rect): Rect => rectToScreen(vp, r);
  const interactive = tool === 'select' && !editing && child !== null && !child.locked;

  const handle = (edge: Exclude<SpanEdge, 'se'>) => {
    if (!child) return null;
    const c = screen(child.cell);
    const style: CSSProperties =
      edge === 'e'
        ? { left: c.x + c.w, top: c.y + c.h * 0.25 }
        : { left: c.x + c.w * 0.25, top: c.y + c.h };
    return (
      <div
        key={edge}
        className={`cv-grid-handle cv-grid-handle-${edge}`}
        data-grid-span={edge}
        data-testid={`grid-span-handle-${edge}`}
        style={style}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const root = rootRef.current;
          if (root) startSpanDrag(root, child.id, edge);
        }}
      />
    );
  };

  return (
    <div className="cv-overlay" data-testid="grid-overlay">
      {columns.map((t, i) => (
        <div
          key={`c${i}`}
          className="cv-grid-track cv-grid-col"
          data-testid={`grid-track-col-${i}`}
          style={px(screen({ x: t.start, y: spanY, w: t.size, h: spanH }))}
        >
          <span className="cv-grid-label">{i + 1}</span>
        </div>
      ))}
      {rows.map((t, i) => (
        <div
          key={`r${i}`}
          className="cv-grid-track cv-grid-row"
          data-testid={`grid-track-row-${i}`}
          style={px(screen({ x: spanX, y: t.start, w: spanW, h: t.size }))}
        >
          <span className="cv-grid-label">{i + 1}</span>
        </div>
      ))}
      {dropCell && (
        <div className="cv-grid-drop" data-testid="grid-drop-cell" style={px(screen(dropCell))} />
      )}
      {interactive && (
        <>
          {handle('e')}
          {handle('s')}
        </>
      )}
    </div>
  );
}
