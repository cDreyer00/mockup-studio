/**
 * Measured geometry of a subtree, produced by the render page (`measure(nodeId)`) from the
 * real DOM (getBoundingClientRect + getComputedStyle). Used by `get_layout` and the SVG exporter.
 *
 * Coordinates in CSS px, relative to the top-left corner of the root frame containing the node
 * (the frame is rendered at 0,0 and scale 1).
 */
import type { NodeType } from './types.js';

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rendered line of text (via `Range.getClientRects`), relative to the frame. */
export interface LayoutTextLine extends LayoutRect {
  text: string;
  /** Distance from the top of the line to the baseline, in px (approximation: the font's ascent). */
  baseline: number;
}

/** Subset of `getComputedStyle` (values already resolved by the browser, in kebab-case). */
export interface LayoutStyle {
  'background-color'?: string;
  'background-image'?: string;
  'border-top-width'?: string;
  'border-right-width'?: string;
  'border-bottom-width'?: string;
  'border-left-width'?: string;
  'border-top-color'?: string;
  'border-right-color'?: string;
  'border-bottom-color'?: string;
  'border-left-color'?: string;
  'border-top-style'?: string;
  'border-right-style'?: string;
  'border-bottom-style'?: string;
  'border-left-style'?: string;
  'border-top-left-radius'?: string;
  'border-top-right-radius'?: string;
  'border-bottom-right-radius'?: string;
  'border-bottom-left-radius'?: string;
  'box-shadow'?: string;
  opacity?: string;
  color?: string;
  'font-family'?: string;
  'font-size'?: string;
  'font-weight'?: string;
  'font-style'?: string;
  'line-height'?: string;
  'letter-spacing'?: string;
  'text-align'?: string;
  'text-decoration-line'?: string;
  'text-transform'?: string;
  overflow?: string;
  'object-fit'?: string;
  transform?: string;
  visibility?: string;
  display?: string;
  [key: string]: string | undefined;
}

export interface LayoutNode extends LayoutRect {
  id: string;
  name: string;
  type: NodeType;
  tag: string;
  style: LayoutStyle;
  /** Text lines (`text` nodes). */
  lines?: LayoutTextLine[];
  /** Measured tracks when the node is a `display: grid` or `inline-grid` container. */
  grid?: LayoutGrid;
  /** Original `src` of the image node (relative to `assets/` or a data URL). */
  src?: string;
  children: LayoutNode[];
}

/** A measured grid track: start (relative to the frame, like nodes) and size, in px. */
export interface LayoutTrack {
  start: number;
  size: number;
}

/** Tracks of a grid container (content area, without padding and border), relative to the frame. */
export interface LayoutGrid {
  columns: LayoutTrack[];
  rows: LayoutTrack[];
  columnGap: number;
  rowGap: number;
}

/** Result of `render(...)` on the render page: rectangle of the requested node and the frame size. */
export interface RenderBox extends LayoutRect {
  frameId: string;
  frameWidth: number;
  frameHeight: number;
}
