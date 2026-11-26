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

/** Fixed font, immune to the document's CSS (preflight, tokens). */
const LABEL_STYLE: CSSProperties = {
  all: 'initial',
  display: 'block',
  alignSelf: 'center',
  font: '500 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#ffffff',
  background: 'rgba(0, 0, 0, 0.6)',
  padding: '2px 8px',
  borderRadius: 4,
  whiteSpace: 'nowrap',
  letterSpacing: 0,
  textTransform: 'none',
};

export function Filmstrip({ doc, docId, frame, state, cells, columns }: FilmstripProps) {
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
          <div data-filmstrip-label="" style={LABEL_STYLE}>
            {cell.label}
          </div>
        </div>
      ))}
    </div>
  );
}
