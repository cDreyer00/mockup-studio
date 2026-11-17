import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { Check, Trash2, X } from 'lucide-react';
import type { ImageCrop } from '@mockup/core';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { CROP_MODE_PREVIEW_STYLE, cropToRect, dragCropHandle, moveCrop, pxToPct } from './crop';
import { cancelCrop, commitCrop } from './cropActions';
import { measureWorldRect } from './dom';
import { HANDLES, rectToScreen } from './geometry';
import type { HandleName, Rect } from './geometry';

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
 * Modo de recorte: a imagem inteira (prévia `fill`) fica visível, o que está fora do retângulo de
 * recorte escurece e o retângulo tem 8 alças. Arrastar dentro move; Enter confirma, Esc cancela.
 */
export function CropOverlay({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const nodeId = useUi((s) => s.cropNodeId);
  const draft = useUi((s) => s.cropDraft);
  const vp = useUi((s) => s.viewport);
  const preview = useUi((s) => (nodeId ? s.preview[nodeId] : undefined));
  const doc = useDoc((s) => s.doc);
  const selection = useUi((s) => s.selection);
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ crop: ImageCrop; x: number; y: number } | null>(null);

  // Outra ação limpou a prévia (ack de op): reafirma a imagem inteira.
  useEffect(() => {
    if (nodeId && !preview) {
      ui.setPreview({ ...useUi.getState().preview, [nodeId]: { style: CROP_MODE_PREVIEW_STYLE } });
    }
  }, [nodeId, preview]);

  // Mede a caixa da imagem depois que a prévia (fill) foi aplicada.
  useLayoutEffect(() => {
    if (!nodeId) return setRect(null);
    const root = rootRef.current;
    const raf = requestAnimationFrame(() => {
      const r = root ? measureWorldRect(root, nodeId) : null;
      setRect((prev) =>
        prev && r && prev.x === r.x && prev.y === r.y && prev.w === r.w && prev.h === r.h
          ? prev
          : r,
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [nodeId, vp, preview, doc, rootRef]);

  // A seleção saiu da imagem (camadas, MCP): descarta o modo.
  useEffect(() => {
    if (nodeId && !(selection.length === 1 && selection[0] === nodeId)) cancelCrop();
  }, [nodeId, selection]);

  useEffect(() => {
    if (!nodeId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') void commitCrop();
      else cancelCrop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [nodeId]);

  if (!nodeId || !draft || !rect) return null;

  const rel = cropToRect(draft, rect.w, rect.h);
  const origin = rectToScreen(vp, rect);
  const box = rectToScreen(vp, { x: rect.x + rel.x, y: rect.y + rel.y, w: rel.w, h: rel.h });
  const pos = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

  const begin = (e: ReactPointerEvent, handle: HandleName | 'move'): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { crop: draft, x: e.clientX, y: e.clientY };
    const onMove = (ev: PointerEvent): void => {
      const s = drag.current;
      if (!s) return;
      const { dx, dy } = pxToPct(
        (ev.clientX - s.x) / vp.z,
        (ev.clientY - s.y) / vp.z,
        rect.w,
        rect.h,
      );
      ui.setCropDraft(
        handle === 'move' ? moveCrop(s.crop, dx, dy) : dragCropHandle(s.crop, handle, dx, dy),
      );
    };
    const onUp = (): void => {
      drag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="cv-crop" data-crop-ui data-testid="crop-layer">
      <div className="cv-crop-ghost" style={pos(origin)} />
      <div
        className="cv-crop-rect"
        data-crop-ui
        data-testid="crop-overlay"
        style={pos(box)}
        onPointerDown={(e) => begin(e, 'move')}
      >
        {HANDLES.map((h) => (
          <div
            key={h}
            className={`cv-handle cv-handle-${h}`}
            data-crop-ui
            data-testid={`crop-handle-${h}`}
            style={{ left: `${HANDLE_POS[h][0] * 100}%`, top: `${HANDLE_POS[h][1] * 100}%` }}
            onPointerDown={(e) => begin(e, h)}
          />
        ))}
      </div>
      <div
        className="cv-crop-bar"
        data-crop-ui
        style={{ left: box.x + box.w / 2, top: box.y + box.h + 10 }}
      >
        <button
          type="button"
          className="btn primary"
          data-testid="crop-apply"
          title="Aplicar recorte (Enter)"
          onClick={() => void commitCrop()}
        >
          <Check size={13} /> Aplicar
        </button>
        <button
          type="button"
          className="btn"
          data-testid="crop-cancel"
          title="Cancelar (Esc)"
          onClick={cancelCrop}
        >
          <X size={13} /> Cancelar
        </button>
        <button
          type="button"
          className="btn"
          data-testid="crop-reset"
          title="Remover recorte"
          onClick={() => ui.setCropDraft({ top: 0, right: 0, bottom: 0, left: 0 })}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
