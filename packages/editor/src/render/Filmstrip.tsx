/**
 * Filmstrip of the render page: one cell per instant, each with its own `RenderApp` of the same root frame
 * and its own `MotionScope` seeked at that instant, plus a small label under the cell.
 * Layout: CSS grid, `columns` columns, 24 px gap and padding, cells sized to the frame (see `api.ts`).
 */
import { createElement } from 'react';
import type { CSSProperties } from 'react';
import type { Document, Node, PreviewState } from '@mockup/core';
import type { MotionScope } from '../motion/scope';
import { RenderApp } from './RenderApp';

export const FILMSTRIP_GAP = 24;
export const FILMSTRIP_PADDING = 24;
export const FILMSTRIP_MAX_CELLS = 12;
export const FILMSTRIP_MAX_COLUMNS = 12;

export interface FilmstripCell {
  scope: MotionScope;
  label: string;
}

export interface FilmstripProps {
  doc: Document;
  docId: string;
  frame: Node;
  state?: PreviewState;
  cells: FilmstripCell[];
  columns: number;
}

/**
 * Label font, immune to the document's CSS (preflight, tokens). Sized from the frame width (1/40,
 * 12 to 48 px) so it stays readable when the agent downsizes the image with `maxWidth`.
 */
export function labelStyle(frameWidth: number): CSSProperties {
  const size = Math.round(Math.min(48, Math.max(12, frameWidth / 40)));
  return {
    all: 'initial',
    display: 'block',
    alignSelf: 'center',
    font: `500 ${size}px/${Math.round(size * 1.35)}px system-ui, -apple-system, "Segoe UI", sans-serif`,
    color: '#ffffff',
    background: 'rgba(0, 0, 0, 0.6)',
    padding: `${Math.round(size / 6)}px ${Math.round(size / 1.5)}px`,
    borderRadius: Math.round(size / 3),
    whiteSpace: 'nowrap',
    letterSpacing: 0,
    textTransform: 'none',
  };
}

export function Filmstrip({ doc, docId, frame, state, cells, columns }: FilmstripProps) {
  const label = labelStyle(parseFloat(frame.style.width ?? '') || 1280);
  return (
    <div
      data-filmstrip=""
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, max-content)`,
        gap: FILMSTRIP_GAP,
        padding: FILMSTRIP_PADDING,
        width: 'max-content',
        boxSizing: 'content-box',
      }}
    >
      {cells.map((cell, i) => (
        <div
          key={i}
          data-filmstrip-item=""
          style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
        >
          {/* The cell is the positioning context of the (absolute) render world; `api.ts` sizes it. */}
          <div data-filmstrip-cell="" style={{ position: 'relative', overflow: 'hidden' }}>
            {createElement(RenderApp, { doc, docId, frame, state, motion: cell.scope })}
          </div>
          <div data-filmstrip-label="" style={label}>
            {cell.label}
          </div>
        </div>
      ))}
    </div>
  );
}
