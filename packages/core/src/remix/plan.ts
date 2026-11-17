/**
 * Local remix planner: generates side-by-side variations of a node (clones of the root frame with a
 * transformation applied). Pure and deterministic (same input, same ops; ids come from
 * `newId`, injectable in tests). All ops of a remix go in a single list, so the caller can
 * apply them in one call (one undo entry). The AI remix (`ai`) lives on the server.
 */
import { parseCssColor } from '../cssEval.js';
import { getComputedLike } from '../computed.js';
import { findNode, walk } from '../document.js';
import { newNodeId } from '../ids.js';
import type { Op, StyleChange } from '../ops.js';
import type { RemixKind } from '../protocol.js';
import type { Document, Node, NodeType } from '../types.js';
import { colorScale, COLOR_STOPS } from './color.js';
import { FONT_PAIRS, fontFamilyValue } from './fontPairs.js';

export interface PlanRemixOptions {
  /** Number of variations (each kind has its own default and maximum). */
  count?: number;
  /** Font families available locally (`font-pairs`); absent = no filtering. */
  fonts?: string[];
  /** Id generator for the cloned nodes (default: `newNodeId`). */
  newId?: (type: NodeType) => string;
}

export interface RemixPlan {
  ops: Op[];
  /** Root frames created, in variation order. */
  frameIds: string[];
  /** Name of each variation, parallel to `frameIds`. */
  labels: string[];
}

/** Horizontal gap between the side-by-side frames, in px. */
export const REMIX_GAP = 80;
/** Size used when the frame has no width/height in px. */
const DEFAULT_FRAME_SIZE = 400;

/** Style edit and reordering, described by the ORIGINAL ids (translated to the clone later). */
interface Variation {
  label: string;
  styles: { nodeId: string; set?: Record<string, string>; unset?: string[] }[];
  reorder?: { parentId: string; childIds: string[] };
}

const px = (v: string | undefined): number | undefined => {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))px\s*$/i.exec(v ?? '');
  return m ? Number(m[1]) : undefined;
};

const positive = (n: number | undefined): n is number => n !== undefined && n > 0;

function checkCount(count: number | undefined, def: number, max: number): number {
  if (count === undefined) return Math.min(def, max);
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`Invalid count (${String(count)}): use an integer starting at 1.`);
  return Math.min(count, max);
}

/* ---------------- color-scale ---------------- */

const COLOR_PROPS = ['background-color', 'background', 'color', 'border-color', 'fill'] as const;

/** Evenly spaced indices of `count` items out of `total` (1 item = the middle one, the 500 stop). */
function spacedIndexes(count: number, total: number): number[] {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  if (count === 1) return [Math.min(5, total - 1)];
  return Array.from({ length: count }, (_, k) => Math.round((k * (total - 1)) / (count - 1)));
}

function planColorScale(doc: Document, node: Node, count: number | undefined): Variation[] {
  const computed = getComputedLike(doc, node.id);
  let found: { prop: string; value: string } | undefined;
  for (const prop of COLOR_PROPS) {
    if (!(prop in node.style)) continue;
    const value = computed[prop];
    const rgba = value ? parseCssColor(value) : null;
    if (value && rgba && rgba.a === 1) {
      found = { prop, value };
      break;
    }
  }
  if (!found)
    throw new Error(
      'The node has no solid color (background-color, background, color, border-color or fill) to generate the shade scale. Pick a node with a color defined in hex, rgb(), hsl() or a token.',
    );
  const { prop, value } = found;
  const scale = colorScale(value);
  const n = checkCount(count, COLOR_STOPS.length, COLOR_STOPS.length);
  return spacedIndexes(n, scale.length).map((i) => ({
    label: `shade ${scale[i]!.stop}`,
    styles: [{ nodeId: node.id, set: { [prop]: scale[i]!.color } }],
  }));
}

/* ---------------- font-pairs ---------------- */

const isHeadingTag = (tag: string): boolean => /^h[1-6]$/i.test(tag);

function fontSizePx(v: string | undefined): number | undefined {
  const rem = /^\s*(\d*\.?\d+)rem\s*$/i.exec(v ?? '');
  return rem ? Number(rem[1]) * 16 : px(v);
}

function fontWeightOf(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (/^(bold|bolder)$/i.test(v.trim())) return 700;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const hasText = (n: Node): boolean => typeof n.text === 'string' && n.text.trim() !== '';

function planFontPairs(
  doc: Document,
  node: Node,
  ancestors: Node[],
  count: number | undefined,
  fonts: string[] | undefined,
): Variation[] {
  const available = fonts ? new Set(fonts.map((f) => f.trim().toLowerCase())) : undefined;
  const pairs = FONT_PAIRS.filter(
    (p) =>
      !available || (available.has(p.heading.toLowerCase()) && available.has(p.body.toLowerCase())),
  );
  if (pairs.length === 0)
    throw new Error(
      'None of the curated font pairs has both families available. Install or embed fonts (e.g. Inter, Playfair Display) with add_font and try again.',
    );
  const n = checkCount(count, 4, pairs.length);

  // Who gets the font: the root and the nodes with text; heading = h1–h6, font size >= 24px or weight >= 600.
  const targets: { nodeId: string; heading: boolean }[] = [];
  let anyText = false;
  const visit = (cur: Node, tagHeading: boolean): void => {
    const byTag = tagHeading || isHeadingTag(cur.tag);
    if (hasText(cur)) anyText = true;
    if (cur === node || hasText(cur)) {
      let heading = byTag;
      if (!heading) {
        const c = getComputedLike(doc, cur.id);
        const size = fontSizePx(c['font-size']);
        const weight = fontWeightOf(c['font-weight']);
        heading = (size !== undefined && size >= 24) || (weight !== undefined && weight >= 600);
      }
      targets.push({ nodeId: cur.id, heading });
    }
    for (const child of cur.children) visit(child, byTag);
  };
  visit(
    node,
    ancestors.some((a) => isHeadingTag(a.tag)),
  );
  if (!anyText) throw new Error('The node has no text to change the font on.');

  return pairs.slice(0, n).map((p) => ({
    label: `${p.heading} + ${p.body}`,
    styles: targets.map((t) => ({
      nodeId: t.nodeId,
      set: { 'font-family': fontFamilyValue(t.heading ? p.heading : p.body) },
    })),
  }));
}

/* ---------------- spacing ---------------- */

const SPACING_PROPS = new Set([
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-inline',
  'padding-block',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-inline',
  'margin-block',
  'gap',
  'row-gap',
  'column-gap',
]);

/** Rounds to the grid without zeroing positive values (keeps the sign of negative margins). */
function snap(v: number, grid: number): number {
  const abs = Math.abs(v);
  const r = Math.round(abs / grid) * grid;
  return Math.sign(v) * (r === 0 && abs > 0 ? grid : r);
}

const SPACING_VARIATIONS: { label: string; fn: (v: number) => number }[] = [
  { label: 'compact', fn: (v) => snap(v * 0.5, 4) },
  { label: 'grid 4', fn: (v) => snap(v, 4) },
  { label: 'grid 8', fn: (v) => snap(v, 8) },
  { label: 'comfortable', fn: (v) => snap(v * 1.5, 8) },
  { label: 'spacious', fn: (v) => snap(v * 2, 8) },
];

const formatPx = (n: number): string => `${+n.toFixed(2)}px`;

function planSpacing(doc: Document, node: Node, count: number | undefined): Variation[] {
  const entries: { nodeId: string; prop: string; raw: string; tokens: string[] }[] = [];
  walk(node, (cur) => {
    const props = Object.keys(cur.style).filter((p) => SPACING_PROPS.has(p));
    if (props.length === 0) return;
    const computed = getComputedLike(doc, cur.id);
    for (const prop of props) {
      const value = (computed[prop] ?? '').trim();
      if (!value || value.includes('(')) continue;
      const tokens = value.split(/\s+/);
      if (tokens.some((t) => px(t) !== undefined && px(t) !== 0))
        entries.push({ nodeId: cur.id, prop, raw: cur.style[prop]!, tokens });
    }
  });
  if (entries.length === 0)
    throw new Error(
      'The node has no spacing in px (padding, margin, gap) to vary. Set values like "16px" on the node or its children.',
    );
  const n = checkCount(count, 4, SPACING_VARIATIONS.length);
  const all = SPACING_VARIATIONS.map(({ label, fn }) => ({
    label,
    styles: entries.flatMap((e) => {
      const value = e.tokens
        .map((t) => {
          const v = px(t);
          return v === undefined ? t : formatPx(fn(v));
        })
        .join(' ');
      return value === e.raw ? [] : [{ nodeId: e.nodeId, set: { [e.prop]: value } }];
    }),
  }));
  // Drops variations equal to the original (nothing changes) or to a previous one: avoids duplicate frames.
  const seen = new Set<string>();
  const distinct = all.filter((v) => {
    if (v.styles.length === 0) return false;
    const key = JSON.stringify(v.styles);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (distinct.length === 0)
    throw new Error(
      'No spacing variation differs from the original: the values are already on the grid and at the minimum.',
    );
  return distinct.slice(0, n);
}

/* ---------------- layout ---------------- */

const isFlex = (n: Node): boolean =>
  n.type !== 'instance' && /^(inline-)?flex$/i.test((n.style['display'] ?? '').trim());

/** `justify-content` → `align-items` when swapping the axes (`undefined` = remove). */
function justifyToAlign(j: string | undefined): string | undefined {
  switch (j?.trim()) {
    case 'flex-start':
    case 'start':
    case 'left':
      return 'flex-start';
    case 'flex-end':
    case 'end':
    case 'right':
      return 'flex-end';
    case 'center':
      return 'center';
    case 'space-between':
    case 'space-around':
    case 'space-evenly':
      return 'stretch';
    default:
      return undefined;
  }
}

/** `align-items` → `justify-content` when swapping the axes (`undefined` = remove). */
function alignToJustify(a: string | undefined): string | undefined {
  switch (a?.trim()) {
    case 'flex-start':
    case 'start':
    case 'self-start':
      return 'flex-start';
    case 'flex-end':
    case 'end':
    case 'self-end':
      return 'flex-end';
    case 'center':
      return 'center';
    default:
      return undefined;
  }
}

function flexDirection(style: Record<string, string>): string {
  const own = style['flex-direction']?.trim();
  if (own) return own;
  const first = style['flex-flow']?.trim().split(/\s+/)[0];
  return first && /^(row|column)(-reverse)?$/.test(first) ? first : 'row';
}

function planLayout(node: Node, ancestors: Node[], count: number | undefined): Variation[] {
  const container = [node, ...[...ancestors].reverse()].find(isFlex);
  if (!container)
    throw new Error(
      'Neither the node nor its ancestors use flex (display: flex). The layout remix only rearranges flex containers.',
    );
  const style = container.style;
  const dir = flexDirection(style);
  const flow = 'flex-flow' in style ? ['flex-flow'] : [];

  const variations: Variation[] = [];
  const newAlign = justifyToAlign(style['justify-content']);
  const newJustify = alignToJustify(style['align-items']);
  variations.push({
    label: 'reversed direction',
    styles: [
      {
        nodeId: container.id,
        set: {
          'flex-direction': dir.startsWith('column') ? 'row' : 'column',
          ...(newAlign ? { 'align-items': newAlign } : {}),
          ...(newJustify ? { 'justify-content': newJustify } : {}),
        },
        unset: [
          ...flow,
          ...(!newAlign && 'align-items' in style ? ['align-items'] : []),
          ...(!newJustify && 'justify-content' in style ? ['justify-content'] : []),
        ],
      },
    ],
  });
  // With fewer than 2 children the reversed order would be an identical clone: left out.
  if (container.children.length >= 2) {
    variations.push({
      label: 'reversed order',
      styles: [],
      reorder: {
        parentId: container.id,
        childIds: [...container.children].reverse().map((c) => c.id),
      },
    });
  }
  variations.push({
    label: 'centered with wrap',
    styles: [
      {
        nodeId: container.id,
        set: {
          'flex-direction': dir,
          'flex-wrap': 'wrap',
          'justify-content': 'center',
          'align-items': 'center',
        },
        unset: flow,
      },
    ],
  });
  return variations.slice(0, checkCount(count, 3, 3));
}

/* ---------------- assembly ---------------- */

function frameSize(frame: Node): { w: number; h: number } {
  const s = frame.style;
  const w = px(s['width']);
  const h = px(s['height']) ?? px(s['min-height']);
  return { w: positive(w) ? w : DEFAULT_FRAME_SIZE, h: positive(h) ? h : DEFAULT_FRAME_SIZE };
}

/**
 * Creates variations of the root frame that contains `nodeId`, side by side to the right, applying the
 * transformation of `kind` to the matching node in each clone. Throws `Error` (message in
 * English) for a nonexistent/virtual node, or when the kind does not apply to the node (no color, no
 * flex, no spacing, no text). `ai` is not local: see `RemixService`.
 */
export function planRemix(
  doc: Document,
  nodeId: string,
  kind: RemixKind,
  opts: PlanRemixOptions = {},
): RemixPlan {
  if (kind === 'ai')
    throw new Error('The AI remix is run by the assistant (kind "ai"), not by planRemix.');
  if (nodeId.includes('/'))
    throw new Error(
      `Node "${nodeId}" is inside a component instance and cannot be remixed. Edit the main component or pick a real node.`,
    );
  const path = findNode(doc, nodeId);
  if (!path)
    throw new Error(
      `Node not found: "${nodeId}". Use get_basic_info or get_tree_summary to see the ids.`,
    );
  const node = path.node;
  const frame = path.ancestors[0] ?? node;

  let variations: Variation[];
  switch (kind) {
    case 'color-scale':
      variations = planColorScale(doc, node, opts.count);
      break;
    case 'font-pairs':
      variations = planFontPairs(doc, node, path.ancestors, opts.count, opts.fonts);
      break;
    case 'spacing':
      variations = planSpacing(doc, node, opts.count);
      break;
    case 'layout':
      variations = planLayout(node, path.ancestors, opts.count);
      break;
    default:
      throw new Error(`Unknown remix kind: "${String(kind)}".`);
  }

  // Position: after the rightmost frame that overlaps vertically with the source one.
  const { w, h } = frameSize(frame);
  const y = frame.position?.y ?? 0;
  let right = (frame.position?.x ?? 0) + w;
  for (const other of path.page.frames) {
    const o = frameSize(other);
    const oy = other.position?.y ?? 0;
    if (oy < y + h && y < oy + o.h) right = Math.max(right, (other.position?.x ?? 0) + o.w);
  }
  const startX = right + REMIX_GAP;

  const newId = opts.newId ?? newNodeId;
  const subtree: Node[] = [];
  walk(frame, (n) => {
    subtree.push(n);
  });
  const indexOf = new Map(subtree.map((n, i) => [n.id, i]));

  const ops: Op[] = [];
  const frameIds: string[] = [];
  const labels: string[] = [];
  const rename: { nodeId: string; name: string }[] = [];
  const positions: { nodeId: string; position: { x: number; y: number } }[] = [];
  const styleChanges: StyleChange[] = [];
  const moves: Op[] = [];

  // Each clone is duplicated from the previous one (the first, from the original): layer order stays natural.
  let sourceIds = subtree.map((n) => n.id);
  variations.forEach((v, i) => {
    const cloneIds = subtree.map((n) => newId(n.type));
    const idMap = Object.fromEntries(sourceIds.map((id, k) => [id, cloneIds[k]!]));
    ops.push({ type: 'duplicateNodes', nodeIds: [sourceIds[0]!], idMap });
    sourceIds = cloneIds;

    const cid = (orig: string): string => cloneIds[indexOf.get(orig)!]!;
    const rootId = cloneIds[0]!;
    frameIds.push(rootId);
    labels.push(v.label);
    rename.push({ nodeId: rootId, name: `${frame.name} — ${v.label}` });
    positions.push({ nodeId: rootId, position: { x: startX + i * (w + REMIX_GAP), y } });
    for (const s of v.styles) {
      styleChanges.push({
        nodeId: cid(s.nodeId),
        ...(s.set ? { set: s.set } : {}),
        ...(s.unset?.length ? { unset: s.unset } : {}),
      });
    }
    if (v.reorder) {
      moves.push({
        type: 'moveNodes',
        nodeIds: v.reorder.childIds.map(cid),
        parentId: cid(v.reorder.parentId),
        index: 0,
      });
    }
  });

  ops.push({ type: 'renameNodes', changes: rename });
  ops.push({ type: 'setPosition', changes: positions });
  if (styleChanges.length) ops.push({ type: 'updateStyles', changes: styleChanges });
  ops.push(...moves);
  return { ops, frameIds, labels };
}
