/** Pure functions for render page measurement (testable without a browser). */
import {
  isGridContainer,
  layoutTracks,
  parseTrackList,
  type Document,
  type LayoutGrid,
  type LayoutRect,
  type LayoutTrack,
  type Node,
} from '@mockup/core';
import { getEntry, getFrameOf } from '../model/tree';

/** `LayoutStyle` properties read from `getComputedStyle`. */
export const LAYOUT_STYLE_PROPS = [
  'background-color',
  'background-image',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration-line',
  'text-transform',
  'overflow',
  'object-fit',
  'transform',
  'visibility',
  'display',
] as const;

export interface PickedFrame {
  frame: Node;
  pageId: string;
  background: string | undefined;
}

/** Root frame (and page) containing the node; `null` if the node does not exist in the document. */
export function pickFrame(doc: Document, nodeId: string): PickedFrame | null {
  const entry = getEntry(doc, nodeId);
  const frame = entry ? getFrameOf(doc, nodeId) : undefined;
  if (!entry || !frame) return null;
  const page = doc.pages.find((p) => p.id === entry.pageId);
  return { frame, pageId: entry.pageId, background: page?.background };
}

export interface CharBox extends LayoutRect {
  ch: string;
}

export interface RawLine extends LayoutRect {
  text: string;
}

/**
 * Groups character rectangles into lines: characters whose top differs by less than the tolerance (and
 * that go in the same direction) stay together. Characters without a box (collapsed spaces) are ignored.
 */
export function groupLines(chars: CharBox[], tolerance = 2): RawLine[] {
  const lines: RawLine[] = [];
  let cur: RawLine | null = null;
  let curTop = 0;
  for (const c of chars) {
    if (c.width === 0 && c.height === 0) continue;
    if (cur && Math.abs(c.y - curTop) <= tolerance && c.x >= cur.x - tolerance) {
      const right = Math.max(cur.x + cur.width, c.x + c.width);
      const bottom = Math.max(cur.y + cur.height, c.y + c.height);
      cur.x = Math.min(cur.x, c.x);
      cur.y = Math.min(cur.y, c.y);
      cur.width = right - cur.x;
      cur.height = bottom - cur.y;
      cur.text += c.ch;
    } else {
      cur = { x: c.x, y: c.y, width: c.width, height: c.height, text: c.ch };
      curTop = c.y;
      lines.push(cur);
    }
  }
  return lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+$/, '').replace(/^\s+/, '') }))
    .filter((l) => l.text.length > 0);
}

/**
 * Applies the line box to the measured line (the text box is the font's content area): returns the
 * rectangle with the line box height, centered, and the baseline from its top.
 */
export function fitLineBox(
  line: RawLine,
  metrics: { ascent: number; descent: number },
  lineHeightPx: number | null,
): { y: number; height: number; baseline: number } {
  const content = metrics.ascent + metrics.descent;
  const lh = lineHeightPx && lineHeightPx > 0 ? lineHeightPx : content;
  const center = line.y + line.height / 2;
  return {
    y: center - lh / 2,
    height: lh,
    baseline: (lh - content) / 2 + metrics.ascent,
  };
}

/** `getComputedStyle` values of a grid container, as strings (already resolved by the browser). */
export interface GridComputed {
  display: string;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  columnGap: string;
  rowGap: string;
  borderLeftWidth: string;
  borderTopWidth: string;
  paddingLeft: string;
  paddingTop: string;
}

const px = (v: string | undefined): number => {
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Resolved sizes (`"200px 200px"`, with optional line names) → start/size from `origin`. */
function tracksFrom(template: string, origin: number, gap: number): LayoutTrack[] {
  const sizes = parseTrackList(template).map((t) => (t.kind === 'px' ? (t.amount ?? 0) : 0));
  return layoutTracks(sizes, gap, origin);
}

/**
 * Measured tracks of a `display: grid`/`inline-grid` container, relative to the frame: reads the tracks
 * resolved in px (`grid-template-columns`/`rows` from the computed style) and positions them in the content box
 * (node rectangle minus border and padding). `undefined` if the node is not a grid.
 */
export function measureGridTracks(cs: GridComputed, rect: LayoutRect): LayoutGrid | undefined {
  if (!isGridContainer({ display: cs.display })) return undefined;
  const columnGap = px(cs.columnGap);
  const rowGap = px(cs.rowGap);
  const x = rect.x + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const y = rect.y + px(cs.borderTopWidth) + px(cs.paddingTop);
  return {
    columns: tracksFrom(cs.gridTemplateColumns, x, columnGap),
    rows: tracksFrom(cs.gridTemplateRows, y, rowGap),
    columnGap,
    rowGap,
  };
}
