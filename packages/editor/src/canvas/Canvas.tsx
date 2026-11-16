import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { frameSize } from '../model/tree';
import { useDoc } from '../state/docStore';
import { useActivePage } from '../state/hooks';
import { ui, useUi } from '../state/uiStore';
import { canvasApi, registerCanvasApi } from './canvasApi';
import type { CanvasApi } from './canvasApi';
import { FrameView } from './FrameView';
import { fitRect, rectInside, rectToScreen, unionRects, zoomAtPoint } from './geometry';
import type { Rect, Viewport } from './geometry';
import { measureWorldRect } from './dom';
import { attachInteractions } from './interactions';
import { DocIdContext } from './NodeView';
import { Overlay } from './Overlay';
import './canvas.css';

const FIT_PADDING = 60;
/** Zoom máximo ao enquadrar a página inteira / ao enquadrar nós. */
const FIT_ALL_MAX_ZOOM = 1;
const FIT_NODES_MAX_ZOOM = 2;
const ZOOM_STEP = 1.25;

/** Último pedido de foco tratado (sobrevive a remontagens do canvas). */
let handledFocusNonce = 0;

/** Aplica o viewport direto no DOM (sem re-render): transform do mundo, `--z` e grade de pontos. */
function applyViewport(root: HTMLElement, world: HTMLElement, vp: Viewport): void {
  world.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})`;
  root.style.setProperty('--z', String(vp.z));
  let size = 24 * vp.z;
  while (size < 12) size *= 4;
  root.style.backgroundSize = `${size}px ${size}px`;
  root.style.backgroundPosition = `${vp.x - size / 2}px ${vp.y - size / 2}px`;
}

/** Canvas infinito: mundo transformado, frames da página e overlay de seleção/gestos. */
export function Canvas() {
  const rootRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const docId = useDoc((s) => s.doc?.id ?? null);
  const tokens = useDoc((s) => s.doc?.tokens);
  const page = useActivePage();
  const focusRequest = useUi((s) => s.focusRequest);
  const pageRef = useRef(page);
  pageRef.current = page;
  const saved = useRef(new Map<string, Viewport>());
  const lastKey = useRef<string | null>(null);
  const pendingFit = useRef(false);

  // Viewport → DOM (sem passar pelo React).
  useLayoutEffect(() => {
    const root = rootRef.current;
    const world = worldRef.current;
    if (!root || !world) return;
    applyViewport(root, world, useUi.getState().viewport);
    return useUi.subscribe((s, p) => {
      if (s.viewport !== p.viewport) applyViewport(root, world, s.viewport);
    });
  }, []);

  // Interações (ponteiro, teclado, roda, menu de contexto, drop).
  useEffect(() => {
    const root = rootRef.current;
    return root ? attachInteractions(root) : undefined;
  }, []);

  // API imperativa para as outras áreas.
  useEffect(() => {
    const size = (): { w: number; h: number } => {
      const r = rootRef.current;
      return { w: r?.clientWidth ?? 0, h: r?.clientHeight ?? 0 };
    };
    const setVp = (vp: Viewport): void => ui.setViewport(vp);
    const zoomBy = (factor: number): void => {
      const s = size();
      setVp(
        zoomAtPoint(
          useUi.getState().viewport,
          useUi.getState().viewport.z * factor,
          s.w / 2,
          s.h / 2,
        ),
      );
    };
    const nodeRect = (id: string): Rect | null => {
      const root = rootRef.current;
      return root ? measureWorldRect(root, id) : null;
    };
    const fitModelRect = (): Rect | null => {
      const frames = (pageRef.current?.frames ?? []).filter((f) => !f.hidden);
      return unionRects(
        frames.map((f) => ({ x: f.position?.x ?? 0, y: f.position?.y ?? 0, ...frameSize(f) })),
      );
    };
    const api: CanvasApi = {
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(1 / ZOOM_STEP),
      zoomTo: (z) => {
        const s = size();
        const vp = useUi.getState().viewport;
        setVp(zoomAtPoint(vp, z, s.w / 2, s.h / 2));
      },
      fitAll: () => {
        const s = size();
        const rect = fitModelRect();
        if (s.w <= 0 || s.h <= 0) return;
        setVp(rect ? fitRect(rect, s, FIT_PADDING, FIT_ALL_MAX_ZOOM) : { x: 0, y: 0, z: 1 });
      },
      fitNodes: (ids = useUi.getState().selection) => {
        const rect = unionRects(ids.map(nodeRect).filter((r): r is Rect => !!r));
        const s = size();
        if (rect && s.w > 0) setVp(fitRect(rect, s, FIT_PADDING, FIT_NODES_MAX_ZOOM));
      },
      viewportCenter: () => {
        const s = size();
        const vp = useUi.getState().viewport;
        return { x: (s.w / 2 - vp.x) / vp.z, y: (s.h / 2 - vp.y) / vp.z };
      },
      nodeRect,
    };
    return registerCanvasApi(api);
  }, []);

  // Primeira exibição de um documento/página: restaura o viewport salvo ou enquadra tudo.
  const key = docId && page ? `${docId}:${page.id}` : null;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || key === lastKey.current) return;
    if (lastKey.current) saved.current.set(lastKey.current, useUi.getState().viewport);
    lastKey.current = key;
    if (!key) return;
    const prev = saved.current.get(key);
    if (prev) {
      ui.setViewport(prev);
      return;
    }
    if (root.clientWidth > 0) {
      canvasApi.fitAll();
    } else {
      pendingFit.current = true;
    }
  }, [key]);

  // Se o canvas ainda não tinha tamanho no primeiro enquadramento, refaz quando ganhar.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pendingFit.current && root.clientWidth > 0) {
        pendingFit.current = false;
        canvasApi.fitAll();
      }
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // Pedido de foco (seleção do MCP, Shift+2): espera o DOM e enquadra (ou só traz à vista).
  useEffect(() => {
    const req = focusRequest;
    const root = rootRef.current;
    if (!req || !root || req.nonce <= handledFocusNonce) return;
    let raf = 0;
    let tries = 0;
    const run = (): void => {
      const rects = req.nodeIds
        .map((id) => measureWorldRect(root, id))
        .filter((r): r is Rect => !!r);
      if (rects.length === 0) {
        if (tries++ < 8) raf = requestAnimationFrame(run);
        return;
      }
      handledFocusNonce = req.nonce;
      const union = unionRects(rects)!;
      const size = { w: root.clientWidth, h: root.clientHeight };
      if (size.w <= 0 || size.h <= 0) return;
      const vp = useUi.getState().viewport;
      if (req.soft) {
        const view: Rect = { x: 0, y: 0, w: size.w, h: size.h };
        if (rectInside(view, rectToScreen(vp, union), 8)) return;
        ui.setViewport(fitRect(union, size, FIT_PADDING, vp.z));
      } else {
        ui.setViewport(fitRect(union, size, FIT_PADDING, FIT_NODES_MAX_ZOOM));
      }
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [focusRequest]);

  return (
    <div
      ref={rootRef}
      className="cv"
      data-testid="canvas"
      tabIndex={-1}
      style={{ backgroundColor: page?.background || '#0f1115' }}
    >
      <div
        ref={worldRef}
        className="cv-world"
        data-testid="canvas-world"
        style={tokens as CSSProperties | undefined}
      >
        <DocIdContext.Provider value={docId ?? ''}>
          {page?.frames.map((f) => (
            <FrameView key={f.id} frame={f} />
          ))}
        </DocIdContext.Provider>
      </div>
      <Overlay rootRef={rootRef} />
    </div>
  );
}
