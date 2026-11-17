import { useEffect } from 'react';
import { subpathsToPath } from '@mockup/core';
import type { PathAnchor } from '@mockup/core';
import { useUi } from '../state/uiStore';
import type { Viewport } from '../state/uiStore';
import type { Point } from './geometry';
import { PEN_CLOSE_RADIUS, isNearFirst, previewSegmentD } from './pen';
import type { PenState } from './pen';
import { attachPenKeys, penFinish, usePen } from './penTool';
import './vector.css';

const toScreen = (vp: Viewport, p: Point): Point => ({
  x: p.x * vp.z + vp.x,
  y: p.y * vp.z + vp.y,
});

function anchorToScreen(vp: Viewport, a: PathAnchor): PathAnchor {
  return {
    ...toScreen(vp, a),
    ...(a.in ? { in: toScreen(vp, a.in) } : {}),
    ...(a.out ? { out: toScreen(vp, a.out) } : {}),
  };
}

/** Caminho em andamento da Caneta (coordenadas de tela): segmentos, prévia, alças e âncoras. */
export function PenOverlay() {
  const tool = useUi((s) => s.tool);
  const vp = useUi((s) => s.viewport);
  const pen = usePen();

  // Teclas (Enter/Esc/Backspace) e conclusão ao trocar de ferramenta no meio do caminho.
  useEffect(() => {
    if (tool !== 'pen') return;
    const off = attachPenKeys();
    const offTool = useUi.subscribe((s, p) => {
      if (p.tool === 'pen' && s.tool !== 'pen') void penFinish();
    });
    return () => {
      off();
      offTool();
    };
  }, [tool]);

  const state: PenState = pen.state;
  if (tool !== 'pen' || state.anchors.length === 0) return null;
  const anchors = state.anchors.map((a) => anchorToScreen(vp, a));
  const cursor = pen.cursor ? toScreen(vp, pen.cursor) : null;
  const screenState: PenState = { anchors, closed: state.closed };
  const closing = !!cursor && isNearFirst(screenState, cursor, PEN_CLOSE_RADIUS) && !state.closed;
  const d = anchors.length > 1 ? subpathsToPath([{ anchors, closed: state.closed }]) : '';
  const preview = cursor ? previewSegmentD(screenState, cursor, closing) : '';
  const last = anchors[anchors.length - 1]!;

  return (
    <div className="cv-overlay cv-pen" data-testid="pen-overlay">
      <svg className="cv-vsvg" width="100%" height="100%">
        {d && <path className="cv-pen-path" d={d} />}
        {preview && <path className="cv-pen-preview" d={preview} />}
        {[last.in, last.out].map(
          (h, i) =>
            h && (
              <line key={i} className="cv-handle-line" x1={last.x} y1={last.y} x2={h.x} y2={h.y} />
            ),
        )}
        {[last.in, last.out].map(
          (h, i) => h && <circle key={`h${i}`} className="cv-handle-dot" cx={h.x} cy={h.y} r={3} />,
        )}
      </svg>
      {anchors.map((a, i) => (
        <div
          key={i}
          className={`cv-anchor${i === 0 && closing ? ' closing' : ''}${i === anchors.length - 1 ? ' last' : ''}`}
          data-testid={`pen-anchor-${i}`}
          style={{ left: a.x, top: a.y }}
        />
      ))}
    </div>
  );
}
