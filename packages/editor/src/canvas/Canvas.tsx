import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Document, Node, Page } from '@mockup/core';
import { FrameView } from './FrameView';
import { RenderCtx } from './NodeView';
import { useActivePage } from '../state/hooks';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

interface View {
  x: number;
  y: number;
  z: number;
}

interface CanvasProps {
  doc: Document;
  page: Page;
  selection: string[];
  onSelect: (nodeIds: string[]) => void;
  onZoomChange: (zoom: number) => void;
}

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Tamanho em px de um frame (width/height do style; padrão 800x600). */
function frameSize(f: Node): { w: number; h: number } {
  const w = parseFloat(f.style?.width ?? '');
  const h = parseFloat(f.style?.height ?? '');
  return { w: Number.isFinite(w) ? w : 800, h: Number.isFinite(h) ? h : 600 };
}

/** Canvas infinito com zoom/pan; renderiza os frames da página como HTML real. */
function CanvasInner({ doc, page, selection, onSelect, onZoomChange }: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  /** O último pointerdown virou arrasto (pan): o click seguinte não deve selecionar. */
  const lastDragMoved = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const framesRef = useRef(page.frames);
  framesRef.current = page.frames;

  /** Enquadra todos os frames da página na área visível. */
  const fit = () => {
    const el = ref.current;
    const frames = framesRef.current.filter((f) => !f.hidden);
    if (!el || frames.length === 0) return setView({ x: 0, y: 0, z: 1 });
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const f of frames) {
      const { w, h } = frameSize(f);
      const fx = f.position?.x ?? 0;
      const fy = f.position?.y ?? 0;
      x0 = Math.min(x0, fx);
      y0 = Math.min(y0, fy);
      x1 = Math.max(x1, fx + w);
      y1 = Math.max(y1, fy + h);
    }
    const pad = 60;
    const { clientWidth: cw, clientHeight: ch } = el;
    const z = clamp(Math.min((cw - pad * 2) / (x1 - x0), (ch - pad * 2) / (y1 - y0), 1));
    setView({ z, x: (cw - (x1 - x0) * z) / 2 - x0 * z, y: (ch - (y1 - y0) * z) / 2 - y0 * z });
  };

  /** Altera o zoom mantendo o ponto (cx, cy) do viewport fixo. */
  const zoomAt = (factor: number, cx: number, cy: number) => {
    setView((v) => {
      const z = clamp(v.z * factor);
      const k = z / v.z;
      return { z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };
  const zoomCenter = (factor: number) => {
    const el = ref.current;
    if (el) zoomAt(factor, el.clientWidth / 2, el.clientHeight / 2);
  };

  // Fit automático na primeira vez que um doc/página é exibido.
  const pageKey = `${doc.id}:${page.id}`;
  useEffect(() => {
    fit();
  }, [pageKey]);

  useEffect(() => onZoomChange(view.z), [view.z, onZoomChange]);

  // Wheel precisa de listener não passivo para poder chamar preventDefault.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Atalhos de teclado: Espaço (pan), Shift+0 (100%), Shift+1 (fit), +/- (zoom).
  useEffect(() => {
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setSpaceDown(true);
      } else if (e.shiftKey && e.code === 'Digit0') {
        const el = ref.current;
        if (el) zoomAt(1 / viewRef.current.z, el.clientWidth / 2, el.clientHeight / 2);
      } else if (e.shiftKey && e.code === 'Digit1') {
        fit();
      } else if (e.key === '+' || e.key === '=') {
        zoomCenter(1.25);
      } else if (e.key === '-' || e.key === '_') {
        zoomCenter(0.8);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    lastDragMoved.current = false;
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { px: e.clientX, py: e.clientY, moved: false };
      setPanning(true);
    }
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    d.px = e.clientX;
    d.py = e.clientY;
    d.moved = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = () => {
    lastDragMoved.current = drag.current?.moved ?? false;
    drag.current = null;
    setPanning(false);
  };

  // Refs evitam recriar o contexto: ignora seleção com Espaço pressionado ou logo após um pan.
  const spaceRef = useRef(spaceDown);
  spaceRef.current = spaceDown;
  const ctx = useMemo(
    () => ({
      docId: doc.id,
      selection: new Set(selection),
      onSelect: (id: string) => {
        if (spaceRef.current || lastDragMoved.current) return;
        onSelect([id]);
      },
    }),
    [doc.id, selection, onSelect],
  );

  const background = page.background || '#0f1115';
  const dot = Math.max(16 * view.z, 8);
  const canvasStyle: CSSProperties = {
    backgroundColor: background,
    backgroundImage: 'radial-gradient(rgba(128,128,140,.28) 1px, transparent 1px)',
    backgroundSize: `${dot}px ${dot}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
    cursor: panning ? 'grabbing' : spaceDown ? 'grab' : 'default',
  };

  return (
    <div
      ref={ref}
      className="canvas"
      style={canvasStyle}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onAuxClick={(e) => e.preventDefault()}
      onClick={() => !spaceDown && !lastDragMoved.current && onSelect([])}
    >
      <RenderCtx.Provider value={ctx}>
        <div
          className="canvas-world"
          style={{
            ...(doc.tokens as CSSProperties),
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
          }}
        >
          {page.frames.map((f) => (
            <FrameView key={f.id} frame={f} zoom={view.z} />
          ))}
        </div>
      </RenderCtx.Provider>
    </div>
  );
}

/** Canvas (versão provisória da base, ligada aos stores). */
export function Canvas() {
  const doc = useDoc((s) => s.doc);
  const page = useActivePage();
  const selection = useUi((s) => s.selection);
  if (!doc || !page) return null;
  return (
    <CanvasInner
      doc={doc}
      page={page}
      selection={selection}
      onSelect={ui.select}
      onZoomChange={(z) => ui.setViewport((v) => ({ ...v, z }))}
    />
  );
}
