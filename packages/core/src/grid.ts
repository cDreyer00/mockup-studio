/**
 * CSS Grid as a first-class layout: tracks, gaps, areas and child placement.
 *
 * Everything here is pure (no DOM, no Node): it parses and generates the CSS values of
 * `grid-template-*`, `gap`, `grid-template-areas` and `grid-column`/`grid-row`/`grid-area`, and
 * converts coordinates into cells from the measured tracks (`LayoutGrid`).
 */
import type { LayoutGrid, LayoutRect, LayoutTrack } from './layout.js';

/* ====================================================================== */
/* Tracks                                                                  */
/* ====================================================================== */

export type GridTrackKind =
  | 'fr'
  | 'px'
  | 'percent'
  | 'auto'
  | 'minmax'
  | 'min-content'
  | 'max-content'
  | 'fit-content'
  | 'other';

/**
 * A track (`grid-template-columns`/`rows`). `value` is the normalized CSS text of the whole track
 * (`1fr`, `200px`, `minmax(120px, 1fr)`); `min`/`max` exist only on `minmax`; `amount` is the
 * number of `fr`, `px` or `%`.
 */
export interface GridTrack {
  kind: GridTrackKind;
  value: string;
  min?: string;
  max?: string;
  amount?: number;
}

/** Track as input: CSS text (`"1fr"`), number (px) or the already typed object. */
export type GridTrackInput = string | number | GridTrack;

/** Limit of repetitions expanded per `repeat(n, ...)`; above it the track becomes `other`. */
const MAX_REPEAT = 200;

const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
const FR_RE = new RegExp(`^(${NUM})fr$`, 'i');
const PX_RE = new RegExp(`^(${NUM})px$`, 'i');
const PERCENT_RE = new RegExp(`^(${NUM})%$`);

/** Splits into top-level tokens (outside parentheses) by space; line `[names]` are discarded. */
function splitTopLevel(value: string, sep: RegExp): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Body of `fn(...)` (without the outer parentheses) or `null`. */
function fnBody(token: string, name: string): string | null {
  const m = new RegExp(`^${name}\\(([\\s\\S]*)\\)$`, 'i').exec(token.trim());
  return m ? m[1]!.trim() : null;
}

const fmtNum = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Normalizes the spacing of an argument list (`a,b` and `a ,  b` become `a, b`). */
function normArgs(parts: string[]): string {
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).join(', ');
}

/** Classifies a track token (a single size, without `repeat`). */
export function parseTrack(token: string): GridTrack {
  const t = token.trim().replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  let m = FR_RE.exec(t);
  if (m) return { kind: 'fr', value: `${fmtNum(parseFloat(m[1]!))}fr`, amount: parseFloat(m[1]!) };
  m = PX_RE.exec(t);
  if (m) return { kind: 'px', value: `${fmtNum(parseFloat(m[1]!))}px`, amount: parseFloat(m[1]!) };
  if (t === '0') return { kind: 'px', value: '0', amount: 0 };
  m = PERCENT_RE.exec(t);
  if (m) {
    return { kind: 'percent', value: `${fmtNum(parseFloat(m[1]!))}%`, amount: parseFloat(m[1]!) };
  }
  if (lower === 'auto') return { kind: 'auto', value: 'auto' };
  if (lower === 'min-content') return { kind: 'min-content', value: 'min-content' };
  if (lower === 'max-content') return { kind: 'max-content', value: 'max-content' };
  const mm = fnBody(t, 'minmax');
  if (mm !== null) {
    const args = splitTopLevel(mm, /,/);
    if (args.length === 2) {
      const [min, max] = args as [string, string];
      const a = parseTrack(min).value;
      const b = parseTrack(max).value;
      return { kind: 'minmax', value: `minmax(${normArgs([a, b])})`, min: a, max: b };
    }
  }
  const fit = fnBody(t, 'fit-content');
  if (fit !== null) return { kind: 'fit-content', value: `fit-content(${fit})` };
  return { kind: 'other', value: t };
}

/**
 * Track list of a `grid-template-columns`/`rows`. Expands `repeat(n, ...)`; `repeat(auto-fill|auto-fit, ...)`,
 * `subgrid` and `masonry` become an `other` track with the text preserved. Line names (`[a]`) are discarded.
 * `none`, empty and `undefined` give an empty list.
 */
export function parseTrackList(value: string | undefined): GridTrack[] {
  const v = (value ?? '').trim();
  if (v === '' || /^none$/i.test(v)) return [];
  if (/^(subgrid|masonry)\b/i.test(v)) return [{ kind: 'other', value: v }];
  const out: GridTrack[] = [];
  const tokens = splitTopLevel(v.replace(/\[[^\]]*\]/g, ' '), /\s/);
  for (const tok of tokens) {
    const rep = fnBody(tok, 'repeat');
    if (rep === null) {
      out.push(parseTrack(tok));
      continue;
    }
    const args = splitTopLevel(rep, /,/);
    const n = args.length >= 2 && /^\d+$/.test(args[0]!.trim()) ? parseInt(args[0]!, 10) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > MAX_REPEAT) {
      out.push({ kind: 'other', value: tok.replace(/\s+/g, ' ') });
      continue;
    }
    const inner = splitTopLevel(
      args
        .slice(1)
        .join(',')
        .replace(/\[[^\]]*\]/g, ' '),
      /\s/,
    ).map(parseTrack);
    for (let i = 0; i < n; i++) out.push(...inner.map((t) => ({ ...t })));
  }
  return out;
}

/** CSS text of an input track (number = px). */
function trackText(t: GridTrackInput): string {
  if (typeof t === 'number') return `${fmtNum(t)}px`;
  if (typeof t === 'string') return parseTrack(t).value;
  return t.value;
}

/** Tracks → CSS; recompacts equal repetitions into `repeat(n, x)`. An empty list becomes `none`. */
export function serializeTrackList(tracks: GridTrackInput[]): string {
  const texts = tracks.map((t) => (typeof t === 'object' ? t.value : trackText(t)));
  const kinds = tracks.map((t) => (typeof t === 'object' ? t.kind : parseTrack(trackText(t)).kind));
  if (texts.length === 0) return 'none';
  const parts: string[] = [];
  let i = 0;
  while (i < texts.length) {
    let j = i + 1;
    // `other` can be a whole `repeat(auto-fill, ...)`: it is never recompacted
    while (kinds[i] !== 'other' && j < texts.length && texts[j] === texts[i]) j++;
    parts.push(j - i >= 2 ? `repeat(${j - i}, ${texts[i]})` : texts[i]!);
    i = j;
  }
  return parts.join(' ');
}

/** `repeat(n, minmax(0, 1fr))`: n equal columns/rows (Tailwind's `grid-cols-n`). */
export function equalTracks(n: number): string {
  const count = Math.max(1, Math.floor(n));
  return `repeat(${count}, minmax(0, 1fr))`;
}

/* ====================================================================== */
/* Named areas                                                             */
/* ====================================================================== */

const AREA_NAME_RE = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

/**
 * Validates the `grid-template-areas` rows (`["header header", "side main"]`): all with the same number of
 * cells, valid names (or `.` for an empty cell) and each area forming a rectangle. Returns the normalized
 * rows (cells separated by a single space) and throws an `Error` if anything is invalid.
 */
export function validateGridAreas(areas: string[]): string[][] {
  if (areas.length === 0) throw new Error('areas needs at least one row, e.g. ["a b"].');
  const rows = areas.map((r) => r.trim().split(/\s+/).filter(Boolean));
  const width = rows[0]!.length;
  rows.forEach((cells, y) => {
    if (cells.length === 0) throw new Error(`Row ${y + 1} of areas is empty.`);
    if (cells.length !== width) {
      throw new Error(
        `All rows of areas must have the same number of cells: row 1 has ${width} and row ${y + 1} has ${cells.length}.`,
      );
    }
    for (const c of cells) {
      if (!/^\.+$/.test(c) && !AREA_NAME_RE.test(c)) {
        throw new Error(
          `Invalid area name: "${c}". Use letters, numbers, "-" or "_" (or "." for an empty cell).`,
        );
      }
    }
  });
  const names = new Set(rows.flat().filter((c) => !/^\.+$/.test(c)));
  for (const name of names) {
    let x0 = Infinity;
    let x1 = -1;
    let y0 = Infinity;
    let y1 = -1;
    let count = 0;
    rows.forEach((cells, y) =>
      cells.forEach((c, x) => {
        if (c !== name) return;
        count++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }),
    );
    if (count !== (x1 - x0 + 1) * (y1 - y0 + 1)) {
      throw new Error(
        `Area "${name}" does not form a rectangle (separate or L-shaped cells). Each name must occupy a contiguous block.`,
      );
    }
  }
  return rows.map((cells) => cells.map((c) => (/^\.+$/.test(c) ? '.' : c)));
}

/** Area rows → `grid-template-areas` value (`"header header" "side main"`). */
export function serializeGridAreas(areas: string[]): string {
  return validateGridAreas(areas)
    .map((cells) => `"${cells.join(' ')}"`)
    .join(' ');
}

/** `grid-template-areas` → rows (`["header header", "side main"]`); `none`/empty give an empty list. */
export function parseGridAreas(value: string | undefined): string[] {
  const v = (value ?? '').trim();
  if (v === '' || /^none$/i.test(v)) return [];
  const rows: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) rows.push((m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' '));
  return rows;
}

/** Names of the areas declared in `grid-template-areas`, without repeats, in order of appearance. */
export function gridAreaNames(value: string | undefined): string[] {
  const names: string[] = [];
  for (const row of parseGridAreas(value)) {
    for (const c of row.split(' ')) if (c && !/^\.+$/.test(c) && !names.includes(c)) names.push(c);
  }
  return names;
}

/* ====================================================================== */
/* Container styles                                                        */
/* ====================================================================== */

/** `columns`/`rows`: number (`repeat(n, minmax(0, 1fr))`), CSS text or a list of tracks. */
export type GridTemplateInput = number | string | GridTrackInput[];

export interface GridContainerOptions {
  columns: GridTemplateInput;
  rows?: GridTemplateInput;
  /** Number (px) or CSS text (`"16px"`, `"16px 24px"`). */
  gap?: number | string;
  columnGap?: number | string;
  rowGap?: number | string;
  /** `grid-template-areas` rows, e.g. `["header header", "side main"]`. */
  areas?: string[];
  placeItems?: string;
  autoFlow?: string;
}

function templateValue(input: GridTemplateInput, label: string): string {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 1) throw new Error(`${label} must be an integer >= 1.`);
    return equalTracks(input);
  }
  if (typeof input === 'string') {
    const v = input.trim();
    if (v === '') throw new Error(`${label} is empty. E.g. 3, "1fr 2fr" or ["200px", "1fr"].`);
    return v;
  }
  if (input.length === 0) throw new Error(`${label} needs at least one track.`);
  return serializeTrackList(input);
}

const gapText = (g: number | string): string =>
  typeof g === 'number' ? `${fmtNum(g)}px` : g.trim();

/**
 * CSS styles of a grid container (`display: grid` + tracks, gaps, areas, alignment and flow).
 * Only emits what was requested. With `gap` and `columnGap`/`rowGap` together, expands to `column-gap`/`row-gap`.
 */
export function gridContainerStyles(opts: GridContainerOptions): Record<string, string> {
  const style: Record<string, string> = { display: 'grid' };
  style['grid-template-columns'] = templateValue(opts.columns, 'columns');
  if (opts.rows !== undefined) style['grid-template-rows'] = templateValue(opts.rows, 'rows');
  if (opts.columnGap !== undefined || opts.rowGap !== undefined) {
    const base = opts.gap !== undefined ? gapText(opts.gap) : undefined;
    const col = opts.columnGap !== undefined ? gapText(opts.columnGap) : base;
    const row = opts.rowGap !== undefined ? gapText(opts.rowGap) : base;
    if (col !== undefined) style['column-gap'] = col;
    if (row !== undefined) style['row-gap'] = row;
  } else if (opts.gap !== undefined) style.gap = gapText(opts.gap);
  if (opts.areas !== undefined) style['grid-template-areas'] = serializeGridAreas(opts.areas);
  if (opts.placeItems !== undefined && opts.placeItems.trim() !== '') {
    style['place-items'] = opts.placeItems.trim();
  }
  if (opts.autoFlow !== undefined && opts.autoFlow.trim() !== '') {
    style['grid-auto-flow'] = opts.autoFlow.trim();
  }
  return style;
}

/** Does the style describe a grid container (`display: grid` or `inline-grid`)? */
export function isGridContainer(style: Record<string, string | undefined>): boolean {
  const d = (style.display ?? '').trim().toLowerCase();
  return d === 'grid' || d === 'inline-grid';
}

/** Number of tracks declared in `grid-template-columns`/`rows` (`repeat(auto-fill, ...)` counts as 1). */
export function trackCount(
  style: Record<string, string | undefined>,
  axis: 'columns' | 'rows',
): number {
  return parseTrackList(style[`grid-template-${axis}`]).length;
}

/* ====================================================================== */
/* Child placement                                                         */
/* ====================================================================== */

/** Position of a child in the grid; columns and rows start at 1. */
export interface GridPlacement {
  column?: number;
  row?: number;
  columnSpan?: number;
  rowSpan?: number;
  /** `grid-area` name (named area). */
  area?: string;
}

function axisValue(start: number | undefined, span: number | undefined): string | undefined {
  if (start === undefined && span === undefined) return undefined;
  if (start === undefined) return `span ${span}`;
  return span !== undefined && span > 1 ? `${start} / span ${span}` : String(start);
}

function checkLine(n: number | undefined, label: string): void {
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    throw new Error(`${label} must be an integer >= 1 (grid lines start at 1).`);
  }
}

/** Placement styles: `grid-column`/`grid-row` (`2 / span 2`) or `grid-area` (named area). */
export function gridPlacementStyles(p: GridPlacement): Record<string, string> {
  if (p.area !== undefined && p.area.trim() !== '') {
    const area = p.area.trim();
    if (!AREA_NAME_RE.test(area)) {
      throw new Error(`Invalid area name: "${area}". Use letters, numbers, "-" or "_".`);
    }
    return { 'grid-area': area };
  }
  checkLine(p.column, 'column');
  checkLine(p.row, 'row');
  checkLine(p.columnSpan, 'columnSpan');
  checkLine(p.rowSpan, 'rowSpan');
  const out: Record<string, string> = {};
  const col = axisValue(p.column, p.columnSpan);
  const row = axisValue(p.row, p.rowSpan);
  if (col !== undefined) out['grid-column'] = col;
  if (row !== undefined) out['grid-row'] = row;
  return out;
}

interface AxisToken {
  line?: number;
  span?: number;
  name?: string;
}

function parseAxisToken(raw: string | undefined): AxisToken {
  const t = (raw ?? '').trim();
  if (t === '' || /^auto$/i.test(t)) return {};
  let m = /^span\s+(\d+)$/i.exec(t);
  if (m) return { span: parseInt(m[1]!, 10) };
  m = /^(-?\d+)$/.exec(t);
  if (m) return { line: parseInt(m[1]!, 10) };
  if (AREA_NAME_RE.test(t)) return { name: t };
  return {};
}

function parseAxis(
  start: string | undefined,
  end: string | undefined,
): { start?: number; span?: number } {
  const a = parseAxisToken(start);
  const b = parseAxisToken(end);
  const out: { start?: number; span?: number } = {};
  if (a.line !== undefined && a.line > 0) out.start = a.line;
  if (a.span !== undefined) out.span = a.span;
  if (b.span !== undefined) out.span = b.span;
  else if (b.line !== undefined && b.line > 0 && out.start !== undefined) {
    out.span = Math.max(1, b.line - out.start);
  }
  return out;
}

function splitSlash(value: string | undefined): string[] {
  return (value ?? '').split('/').map((s) => s.trim());
}

/** Reads `grid-column`, `grid-row`, `grid-area` and the longhand forms (`grid-column-start`...) of a style. */
export function parseGridPlacement(style: Record<string, string | undefined>): GridPlacement {
  const out: GridPlacement = {};
  const set = (k: keyof GridPlacement, v: number | undefined): void => {
    if (v !== undefined) (out as Record<string, number>)[k] = v;
  };
  let colStart = style['grid-column-start'];
  let colEnd = style['grid-column-end'];
  let rowStart = style['grid-row-start'];
  let rowEnd = style['grid-row-end'];
  if (style['grid-column'] !== undefined) [colStart, colEnd] = splitSlash(style['grid-column']);
  if (style['grid-row'] !== undefined) [rowStart, rowEnd] = splitSlash(style['grid-row']);
  const area = style['grid-area'];
  if (area !== undefined && area.trim() !== '') {
    const parts = splitSlash(area);
    if (parts.length === 1) {
      const tok = parseAxisToken(parts[0]);
      if (tok.name) out.area = tok.name;
      else {
        // `grid-area: 2` sets the start line of the row (row-start) and repeats the rest as `auto`
        rowStart = parts[0];
      }
    } else {
      [rowStart, colStart, rowEnd, colEnd] = parts;
    }
  }
  const col = parseAxis(colStart, colEnd);
  const row = parseAxis(rowStart, rowEnd);
  set('column', col.start);
  set('columnSpan', col.span);
  set('row', row.start);
  set('rowSpan', row.span);
  return out;
}

/* ====================================================================== */
/* Track sizing without DOM                                                */
/* ====================================================================== */

interface Sizing {
  /** Fixed size in px (px and %). */
  fixed?: number;
  /** fr weight (fr, auto, min/max-content, fit-content, other and minmax with a flexible max). */
  weight?: number;
  /** Floor in px (minimum of `minmax`). */
  floor: number;
}

function sizingOf(track: GridTrack, available: number): Sizing {
  switch (track.kind) {
    case 'px':
      return { fixed: track.amount ?? 0, floor: 0 };
    case 'percent':
      return { fixed: ((track.amount ?? 0) / 100) * available, floor: 0 };
    case 'fr':
      return { weight: Math.max(0, track.amount ?? 0), floor: 0 };
    case 'minmax': {
      const min = parseTrack(track.min ?? 'auto');
      const max = parseTrack(track.max ?? 'auto');
      const floor =
        min.kind === 'px'
          ? (min.amount ?? 0)
          : min.kind === 'percent'
            ? ((min.amount ?? 0) / 100) * available
            : 0;
      if (max.kind === 'px') return { fixed: Math.max(floor, max.amount ?? 0), floor };
      if (max.kind === 'percent') {
        return { fixed: Math.max(floor, ((max.amount ?? 0) / 100) * available), floor };
      }
      if (max.kind === 'fr') return { weight: Math.max(0, max.amount ?? 0), floor };
      return { weight: 1, floor };
    }
    default:
      // auto, min/max-content, fit-content, other: without DOM there is no content measure; they count as 1fr
      return { weight: 1, floor: 0 };
  }
}

/**
 * Size of each track in px, without DOM: `px` and `%` (of the available space) are fixed, `fr` splits the
 * remainder (minus gaps) by weight, and `auto`/`min-content`/`max-content`/`fit-content` count as
 * 1fr. `minmax` respects the floor in px. It is an approximation for the fallback when there is no render.
 */
export function resolveTrackSizes(tracks: GridTrack[], available: number, gap = 0): number[] {
  const n = tracks.length;
  if (n === 0) return [];
  const sizing = tracks.map((t) => sizingOf(t, available));
  const sizes = sizing.map((s) => s.fixed ?? 0);
  const flexible = sizing.map((s, i) => (s.weight !== undefined ? i : -1)).filter((i) => i >= 0);
  const pinned = new Set<number>();
  const free0 = available - gap * (n - 1) - sizes.reduce((a, b) => a + b, 0);
  // repeat: flexible tracks whose floor exceeds their proportional share stay at the floor and leave the split
  for (let pass = 0; pass <= flexible.length; pass++) {
    const open = flexible.filter((i) => !pinned.has(i));
    const pinnedTotal = [...pinned].reduce((a, i) => a + sizing[i]!.floor, 0);
    const free = Math.max(0, free0 - pinnedTotal);
    const totalWeight = open.reduce((a, i) => a + sizing[i]!.weight!, 0);
    // sum of factors < 1: only that fraction of the free space is distributed
    const scale = totalWeight > 0 && totalWeight < 1 ? totalWeight : 1;
    let again = false;
    for (const i of open) {
      const share = totalWeight > 0 ? (free * scale * sizing[i]!.weight!) / totalWeight : 0;
      if (share < sizing[i]!.floor) {
        pinned.add(i);
        again = true;
      } else sizes[i] = share;
    }
    if (!again) break;
  }
  for (const i of pinned) sizes[i] = sizing[i]!.floor;
  return sizes.map((s) => Math.round(s * 1000) / 1000);
}

/** Positions and sizes (`LayoutTrack`) from the resolved sizes, starting at `origin`. */
export function layoutTracks(sizes: number[], gap = 0, origin = 0): LayoutTrack[] {
  let pos = origin;
  return sizes.map((size) => {
    const t = { start: pos, size };
    pos += size + gap;
    return t;
  });
}

/* ====================================================================== */
/* Cells (for the editor and for get_layout)                               */
/* ====================================================================== */

/** 1-based cell: column and row. */
export interface GridCell {
  column: number;
  row: number;
}

/** Cell with extent: start and how many tracks it spans. */
export interface GridSpan extends GridCell {
  columnSpan: number;
  rowSpan: number;
}

/** 0-based index of the track containing `pos`; in gaps, the nearest track; `-1` outside the grid. */
function trackAt(tracks: LayoutTrack[], pos: number): number {
  const first = tracks[0];
  const last = tracks[tracks.length - 1];
  if (!first || !last) return -1;
  if (pos < first.start || pos > last.start + last.size) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]!;
    const dist =
      pos < t.start ? t.start - pos : pos > t.start + t.size ? pos - t.start - t.size : 0;
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/** 1-based cell under the point `(x, y)` (same coordinate system as the tracks); `null` outside the grid. */
export function cellAt(grid: LayoutGrid, x: number, y: number): GridCell | null {
  const c = trackAt(grid.columns, x);
  const r = trackAt(grid.rows, y);
  if (c < 0 || r < 0) return null;
  return { column: c + 1, row: r + 1 };
}

function nearestEdge(tracks: LayoutTrack[], pos: number, useEnd: boolean): number {
  let best = 0;
  let bestDist = Infinity;
  tracks.forEach((t, i) => {
    const edge = useEnd ? t.start + t.size : t.start;
    const d = Math.abs(edge - pos);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/**
 * Start and extent (in tracks) of a rectangle over the grid: the start edge snaps to the nearest track
 * start and the end edge to the nearest track end (used when stretching a child by its handles). `null` without tracks.
 */
export function spanFromRect(grid: LayoutGrid, rect: LayoutRect): GridSpan | null {
  if (grid.columns.length === 0 || grid.rows.length === 0) return null;
  const c0 = nearestEdge(grid.columns, rect.x, false);
  const c1 = Math.max(c0, nearestEdge(grid.columns, rect.x + rect.width, true));
  const r0 = nearestEdge(grid.rows, rect.y, false);
  const r1 = Math.max(r0, nearestEdge(grid.rows, rect.y + rect.height, true));
  return { column: c0 + 1, row: r0 + 1, columnSpan: c1 - c0 + 1, rowSpan: r1 - r0 + 1 };
}

/** Rectangle (same system as the tracks) covered by a cell and its extent; `null` if outside the grid. */
export function cellRect(grid: LayoutGrid, span: GridSpan): LayoutRect | null {
  const c0 = grid.columns[span.column - 1];
  const c1 = grid.columns[Math.min(grid.columns.length, span.column + span.columnSpan - 1) - 1];
  const r0 = grid.rows[span.row - 1];
  const r1 = grid.rows[Math.min(grid.rows.length, span.row + span.rowSpan - 1) - 1];
  if (!c0 || !c1 || !r0 || !r1) return null;
  return {
    x: c0.start,
    y: r0.start,
    width: c1.start + c1.size - c0.start,
    height: r1.start + r1.size - r0.start,
  };
}

/* ====================================================================== */
/* Compact text of the measured tracks                                     */
/* ====================================================================== */

const round1 = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * Compact line of the measured tracks, used by `get_layout`:
 * `grid cols 0+200,216+200 rows 0+100 gap 16/16` (each track is `start+size` in px).
 */
export function formatGridTracks(grid: LayoutGrid): string {
  const list = (tracks: LayoutTrack[]): string =>
    tracks.length === 0 ? '-' : tracks.map((t) => `${round1(t.start)}+${round1(t.size)}`).join(',');
  return `grid cols ${list(grid.columns)} rows ${list(grid.rows)} gap ${round1(grid.columnGap)}/${round1(grid.rowGap)}`;
}
