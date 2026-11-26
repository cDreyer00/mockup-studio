import { getComponent } from './components/expand.js';
import { sortStateKeys } from './states.js';
import { isGridContainer, parseGridPlacement, trackCount } from './grid.js';
import { getSlideTransition } from './motion/transitions.js';
import type { Document, Node } from './types.js';

const TEXT_MAX = 40;

/** `24px` → `24`; other units are kept. Applies to each token of the value. */
function shorten(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^(-?\d*\.?\d+)px$/, '$1'))
    .join(' ');
}

const isPx = (v: string | undefined): v is string => !!v && /^-?\d*\.?\d+(px)?$/.test(v.trim());
const num = (v: string): string => v.trim().replace(/px$/, '');

function sizeToken(s: Record<string, string>): string | undefined {
  const w = s.width;
  const h = s.height;
  if (isPx(w) && isPx(h)) return `${num(w)}x${num(h)}`;
  const parts: string[] = [];
  if (w) parts.push(`w:${shorten(w)}`);
  if (h) parts.push(`h:${shorten(h)}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function sides(s: Record<string, string>, base: string, label: string): string | undefined {
  if (s[base]) return `${label}:${shorten(s[base])}`;
  const parts: string[] = [];
  for (const [side, short] of [
    ['top', 't'],
    ['right', 'r'],
    ['bottom', 'b'],
    ['left', 'l'],
  ] as const) {
    const v = s[`${base}-${side}`];
    if (v) parts.push(`${label}${short}:${shorten(v)}`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** `grid 3x2` (declared columns x rows); only one axis becomes `grid 3col`/`grid 2row`. */
function gridToken(s: Record<string, string>): string {
  const cols = trackCount(s, 'columns');
  const rows = trackCount(s, 'rows');
  if (cols > 0 && rows > 0) return `grid ${cols}x${rows}`;
  if (cols > 0) return `grid ${cols}col`;
  if (rows > 0) return `grid ${rows}row`;
  return 'grid';
}

/** Position in a grid: `cell:2/1 span:2x1` (1-based column/row) or `area:name`. */
function placementTokens(node: Node): string[] {
  const s = node.style;
  if (
    !s['grid-column'] &&
    !s['grid-row'] &&
    !s['grid-area'] &&
    !s['grid-column-start'] &&
    !s['grid-row-start']
  )
    return [];
  const p = parseGridPlacement(s);
  if (p.area) return [`area:${p.area}`];
  const out: string[] = [];
  if (p.column !== undefined || p.row !== undefined) {
    out.push(`cell:${p.column ?? '?'}/${p.row ?? '?'}`);
  }
  if ((p.columnSpan ?? 1) > 1 || (p.rowSpan ?? 1) > 1) {
    out.push(`span:${p.columnSpan ?? 1}x${p.rowSpan ?? 1}`);
  }
  return out;
}

function layoutTokens(node: Node): string[] {
  const s = node.style;
  const out: string[] = [];
  const display = s.display;
  if (display === 'flex' || display === 'inline-flex') {
    out.push((s['flex-direction'] ?? 'row').startsWith('column') ? 'flex-col' : 'flex-row');
  } else if (isGridContainer(s)) out.push(gridToken(s));
  else if (display === 'block') out.push('block');
  if (s.position === 'absolute') {
    const x = node.position?.x ?? (s.left ? num(s.left) : undefined);
    const y = node.position?.y ?? (s.top ? num(s.top) : undefined);
    out.push(x !== undefined && y !== undefined ? `abs@${x},${y}` : 'abs');
  }
  return out;
}

function shortSrc(src: string): string {
  if (src.startsWith('data:')) return 'data:…';
  return src.length > TEXT_MAX ? src.slice(0, TEXT_MAX) + '…' : src;
}

function flags(node: Node): string[] {
  const f: string[] = [];
  if (node.hidden) f.push('[hidden]');
  if (node.locked) f.push('[locked]');
  return f;
}

/** Tailwind markers: `tw` (has `classes`) and `states:hover,md` (has states with styles). */
function tailwindTokens(node: Node): string[] {
  const out: string[] = [];
  if (node.classes) out.push('tw');
  const keys = Object.keys(node.states ?? {}).filter(
    (k) => Object.keys(node.states![k]).length > 0,
  );
  if (keys.length > 0) out.push(`states:${sortStateKeys(keys).join(',')}`);
  return out;
}

/** Motion markers: `motion:in fade-up+b1,emphasis float` (`+bN` = build N) and `transition:push-left`. */
function motionTokens(node: Node): string[] {
  const out: string[] = [];
  if (node.animations && node.animations.length > 0) {
    const list = node.animations.map(
      (a) => `${a.kind} ${a.preset}${a.build ? `+b${a.build}` : ''}`,
    );
    out.push(`motion:${list.join(',')}`);
  }
  const t = node.slideTransition;
  if (t) {
    const dir = getSlideTransition(t.preset)?.directional ? `-${t.direction ?? 'left'}` : '';
    out.push(`transition:${t.preset}${dir}`);
  }
  return out;
}

/**
 * Instance (or expanded root): `◆Name` of the component (the id without `doc`) and the instance's props,
 * e.g. `◆Button variant=outline label="Save"` (strings and colors in quotes).
 */
function instanceTokens(node: Node, doc?: Document): string[] {
  if (!node.componentId) return [];
  const def = doc ? getComponent(doc, node.componentId) : undefined;
  const out = [`◆${def?.name ?? node.componentId}`];
  for (const [k, v] of Object.entries(node.props ?? {})) {
    const type = def?.props.find((p) => p.name === k)?.type;
    const quoted = type ? type === 'string' || type === 'color' : typeof v === 'string';
    out.push(`${k}=${quoted ? JSON.stringify(v) : String(v)}`);
  }
  if (node.overrides && Object.keys(node.overrides).length > 0) out.push('overrides');
  return out;
}

/** Single summary line for the node (`doc` provides the component name of instances). */
export function summarizeNode(node: Node, doc?: Document): string {
  const s = node.style;
  const parts: string[] = [
    node.id,
    JSON.stringify(node.name),
    node.tag,
    ...instanceTokens(node, doc),
  ];

  if (node.type === 'text') {
    const text = node.text ?? '';
    parts.push(JSON.stringify(text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text));
    const font = [s['font-size'], s['font-weight']].filter(Boolean).join('/');
    if (font) parts.push(font);
    if (s.color) parts.push(`color:${s.color}`);
    parts.push(
      ...placementTokens(node),
      ...tailwindTokens(node),
      ...motionTokens(node),
      ...flags(node),
    );
    return parts.join(' ');
  }

  if (node.type === 'effect' || node.type === 'video' || node.type === 'embed') {
    if (node.effect) parts.push(`effect:${node.effect.kind}`);
    if (node.video) parts.push(`video:${shortSrc(node.video.src)}`);
    if (node.embed) {
      const e = node.embed;
      const where = e.url ?? e.src;
      parts.push(`embed:${e.provider}${where ? ` ${shortSrc(where)}` : ''}`);
    }
    const size = sizeToken(s);
    if (size) parts.push(size);
    if (s.position === 'absolute') parts.push('abs');
    parts.push(...tailwindTokens(node), ...motionTokens(node), ...flags(node));
    return parts.join(' ');
  }

  if (node.type === 'image') {
    if (node.src) parts.push(`src:${shortSrc(node.src)}`);
    const size = sizeToken(s);
    if (size) parts.push(size);
    parts.push(
      ...placementTokens(node),
      ...tailwindTokens(node),
      ...motionTokens(node),
      ...flags(node),
    );
    return parts.join(' ');
  }

  const size = sizeToken(s);
  if (size) parts.push(size);
  if (node.type === 'repeater') {
    const src =
      node.dataSource && node.dataSource.kind !== 'inline' ? `<${node.dataSource.kind}` : '';
    parts.push(`repeat:${node.data?.length ?? 0}${src}`);
  }
  parts.push(...layoutTokens(node));
  if (s.gap) parts.push(`gap:${shorten(s.gap)}`);
  else if (isGridContainer(s)) {
    if (s['column-gap']) parts.push(`gap-x:${shorten(s['column-gap'])}`);
    if (s['row-gap']) parts.push(`gap-y:${shorten(s['row-gap'])}`);
  }
  parts.push(...placementTokens(node));
  const p = sides(s, 'padding', 'p');
  if (p) parts.push(p);
  const m = sides(s, 'margin', 'm');
  if (m) parts.push(m);
  const bg = s['background-color'] ?? s.background;
  if (bg) parts.push(`bg:${shorten(bg)}`);
  if (s.color) parts.push(`color:${s.color}`);
  if (s['border-radius']) parts.push(`radius:${shorten(s['border-radius'])}`);
  if (s.border) parts.push(`border:${shorten(s.border)}`);
  parts.push(...tailwindTokens(node), ...motionTokens(node), ...flags(node));
  return parts.join(' ');
}

function lines(
  node: Node,
  depth: number,
  level: number,
  base: string,
  out: string[],
  doc?: Document,
): void {
  const pad = base + '  '.repeat(level);
  out.push(pad + summarizeNode(node, doc));
  if (node.children.length === 0) return;
  if (depth <= 0) {
    // depth 0 at the top shows only the node; below that it indicates the omitted children.
    if (level > 0) out.push(`${pad}  … +${node.children.length} children`);
    return;
  }
  for (const child of node.children) lines(child, depth - 1, level + 1, base, out, doc);
}

export function getTreeSummary(
  node: Node | Node[],
  depth = 2,
  options: { indent?: string; doc?: Document } = {},
): string {
  const out: string[] = [];
  const base = options.indent ?? '';
  for (const n of Array.isArray(node) ? node : [node]) lines(n, depth, 0, base, out, options.doc);
  return out.join('\n');
}

export function getDocumentSummary(doc: Document, depth = 1): string {
  const out: string[] = [];
  for (const page of doc.pages) {
    const n = page.frames.length;
    out.push(`${page.id} ${JSON.stringify(page.name)} (${n} ${n === 1 ? 'frame' : 'frames'})`);
    if (n > 0) out.push(getTreeSummary(page.frames, depth, { indent: '  ', doc }));
  }
  return out.join('\n');
}
