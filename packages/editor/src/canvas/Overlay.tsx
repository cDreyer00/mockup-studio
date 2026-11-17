import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { flushSync } from 'react-dom';
import { componentRole, isPurpleRole } from '../components/model';
import { isLockedDeep, topLevel } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { measureWorldRect } from './dom';
import { CropOverlay } from './CropOverlay';
import { useFx } from './fx';
import { HANDLES, distanceGuides, rectToScreen, unionRects } from './geometry';
import type { HandleName, Rect } from './geometry';

interface Measured {
  sel: { id: string; rect: Rect }[];
  hover: Rect | null;
  /** There are selectable nodes to resize (none locked). */
  resizable: boolean;
  /** Selection/hover on a component instance (or a node inside it, or inside the main component): purple outline. */
  selComponent: boolean;
  hoverComponent: boolean;
}

const EMPTY: Measured = {
  sel: [],
  hover: null,
  resizable: false,
  selComponent: false,
  hoverComponent: false,
};

function sameRect(a: Rect | null, b: Rect | null): boolean {
  return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

function sameMeasured(a: Measured, b: Measured): boolean {
  return (
    a.resizable === b.resizable &&
    a.selComponent === b.selComponent &&
    a.hoverComponent === b.hoverComponent &&
    sameRect(a.hover, b.hover) &&
    a.sel.length === b.sel.length &&
    a.sel.every((s, i) => s.id === b.sel[i]!.id && sameRect(s.rect, b.sel[i]!.rect))
  );
}

function measure(root: HTMLElement): Measured {
  const { selection, hoverId } = useUi.getState();
  const doc = useDoc.getState().doc;
  const sel: Measured['sel'] = [];
  for (const id of selection) {
    const rect = measureWorldRect(root, id);
    if (rect) sel.push({ id, rect });
  }
  const hover = hoverId && !selection.includes(hoverId) ? measureWorldRect(root, hoverId) : null;
  const resizable =
    !!doc &&
    sel.length > 0 &&
    topLevel(
      doc,
      sel.map((s) => s.id),
    ).every((id) => !isLockedDeep(doc, id));
  const purple = (id: string): boolean => isPurpleRole(componentRole(doc, id));
  return {
    sel,
    hover,
    resizable,
    selComponent: sel.some((s) => purple(s.id)),
    hoverComponent: !!hover && !!hoverId && purple(hoverId),
  };
}

const px = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

const HANDLE_POS: Record<HandleName, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

/**
 * Layer in screen coordinates above the world: hover, selection, handles, dimensions, marquee,
 * insertion indicator and distance ruler. Measures the DOM via rAF when selection/hover/doc/preview
 * change; pan and zoom only reconvert the already-measured rectangles (in world coordinates).
 */
export function Overlay({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const [m, setM] = useState<Measured>(EMPTY);
  const raf = useRef(0);
  const vp = useUi((s) => s.viewport);
  const tool = useUi((s) => s.tool);
  const editing = useUi((s) => s.editingTextId);
  const alt = useUi((s) => s.altDown);
  const fx = useFx();

  useEffect(() => {
    const run = (): void => {
      raf.current = 0;
      const root = rootRef.current;
      if (!root) return;
      const next = measure(root);
      flushSync(() => setM((prev) => (sameMeasured(prev, next) ? prev : next)));
    };
    const schedule = (): void => {
      if (!raf.current) raf.current = requestAnimationFrame(run);
    };
    schedule();
    const offUi = useUi.subscribe((s, p) => {
      if (
        s.selection !== p.selection ||
        s.hoverId !== p.hoverId ||
        s.preview !== p.preview ||
        s.pageId !== p.pageId
      )
        schedule();
    });
    const offDoc = useDoc.subscribe((s, p) => {
      if (s.doc !== p.doc) schedule();
    });
    const root = rootRef.current;
    // Images/fonts that finish loading change the size of the nodes.
    root?.addEventListener('load', schedule, true);
    return () => {
      offUi();
      offDoc();
      root?.removeEventListener('load', schedule, true);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [rootRef]);

  const screen = (r: Rect): Rect => rectToScreen(vp, r);
  const box = unionRects(m.sel.map((s) => s.rect));
  const boxS = box ? screen(box) : null;
  const cropping = useUi((s) => s.cropNodeId !== null);
  const interactive = tool === 'select' && !editing && !cropping;
  const sc = m.selComponent ? ' cv-component' : '';

  let guides: ReturnType<typeof distanceGuides> = [];
  if (alt && m.sel.length === 1 && m.hover) {
    guides = distanceGuides(screen(m.sel[0]!.rect), screen(m.hover), vp.z);
  }

  const marquee = fx.marquee ? screen(fx.marquee) : null;
  const draw = fx.draw ? screen(fx.draw) : null;
  const insert = fx.insert ? screen(fx.insert) : null;

  return (
    <div className="cv-overlay" data-testid="canvas-overlay">
      {cropping && <CropOverlay rootRef={rootRef} />}
      {m.hover && interactive && (
        <div
          className={`cv-hover${m.hoverComponent ? ' cv-component' : ''}`}
          style={px(screen(m.hover))}
        />
      )}
      {m.sel.length > 1 &&
        m.sel.map((s) => (
          <div key={s.id} className={`cv-sel-node${sc}`} style={px(screen(s.rect))} />
        ))}
      {boxS && (
        <>
          <div
            className={`cv-sel-box${sc}`}
            data-testid="selection-box"
            data-component={m.selComponent ? '' : undefined}
            style={px(boxS)}
          >
            {interactive &&
              m.resizable &&
              HANDLES.map((h) => (
                <div
                  key={h}
                  className={`cv-handle cv-handle-${h}`}
                  data-handle={h}
                  data-testid={`handle-${h}`}
                  style={{ left: `${HANDLE_POS[h][0] * 100}%`, top: `${HANDLE_POS[h][1] * 100}%` }}
                />
              ))}
          </div>
          <div
            className={`cv-dim${sc}`}
            style={{ left: boxS.x + boxS.w / 2, top: boxS.y + boxS.h + 8 }}
            data-testid="selection-size"
          >
            {Math.round(box!.w)} × {Math.round(box!.h)}
          </div>
        </>
      )}
      {guides.map((g, i) => (
        <div key={i} className="cv-guide-wrap">
          <div
            className={`cv-guide cv-guide-${g.axis}`}
            style={{
              left: Math.min(g.x1, g.x2),
              top: Math.min(g.y1, g.y2),
              width: g.axis === 'h' ? Math.abs(g.x2 - g.x1) : 1,
              height: g.axis === 'v' ? Math.abs(g.y2 - g.y1) : 1,
            }}
          />
          <div
            className="cv-guide-label"
            style={{ left: (g.x1 + g.x2) / 2, top: (g.y1 + g.y2) / 2 }}
          >
            {g.value}
          </div>
        </div>
      ))}
      {marquee && <div className="cv-marquee" data-testid="marquee" style={px(marquee)} />}
      {draw && <div className="cv-draw" data-testid="draw-preview" style={px(draw)} />}
      {insert && (
        <div
          className="cv-insert"
          data-testid="insert-indicator"
          style={{
            left: insert.w < 2 ? insert.x - 1 : insert.x,
            top: insert.h < 2 ? insert.y - 1 : insert.y,
            width: Math.max(2, insert.w),
            height: Math.max(2, insert.h),
          }}
        />
      )}
    </div>
  );
}
