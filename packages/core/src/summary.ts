import type { Document, Node } from './types.js';

const TEXT_MAX = 40;

/** `24px` → `24`; outras unidades são mantidas. Aplica a cada token do valor. */
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

function layoutTokens(node: Node): string[] {
  const s = node.style;
  const out: string[] = [];
  const display = s.display;
  if (display === 'flex' || display === 'inline-flex') {
    out.push((s['flex-direction'] ?? 'row').startsWith('column') ? 'flex-col' : 'flex-row');
  } else if (display === 'grid' || display === 'inline-grid') out.push('grid');
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

/** Linha única de resumo do nó. */
export function summarizeNode(node: Node): string {
  const s = node.style;
  const parts: string[] = [node.id, JSON.stringify(node.name), node.tag];

  if (node.type === 'text') {
    const text = node.text ?? '';
    parts.push(JSON.stringify(text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text));
    const font = [s['font-size'], s['font-weight']].filter(Boolean).join('/');
    if (font) parts.push(font);
    if (s.color) parts.push(`color:${s.color}`);
    parts.push(...flags(node));
    return parts.join(' ');
  }

  if (node.type === 'image') {
    if (node.src) parts.push(`src:${shortSrc(node.src)}`);
    const size = sizeToken(s);
    if (size) parts.push(size);
    parts.push(...flags(node));
    return parts.join(' ');
  }

  const size = sizeToken(s);
  if (size) parts.push(size);
  parts.push(...layoutTokens(node));
  if (s.gap) parts.push(`gap:${shorten(s.gap)}`);
  const p = sides(s, 'padding', 'p');
  if (p) parts.push(p);
  const m = sides(s, 'margin', 'm');
  if (m) parts.push(m);
  const bg = s['background-color'] ?? s.background;
  if (bg) parts.push(`bg:${shorten(bg)}`);
  if (s.color) parts.push(`color:${s.color}`);
  if (s['border-radius']) parts.push(`radius:${shorten(s['border-radius'])}`);
  if (s.border) parts.push(`border:${shorten(s.border)}`);
  parts.push(...flags(node));
  return parts.join(' ');
}

function lines(node: Node, depth: number, level: number, base: string, out: string[]): void {
  const pad = base + '  '.repeat(level);
  out.push(pad + summarizeNode(node));
  if (node.children.length === 0) return;
  if (depth <= 0) {
    // depth 0 no topo mostra só o nó; abaixo disso indica os filhos omitidos.
    if (level > 0) out.push(`${pad}  … +${node.children.length} filhos`);
    return;
  }
  for (const child of node.children) lines(child, depth - 1, level + 1, base, out);
}

export function getTreeSummary(
  node: Node | Node[],
  depth = 2,
  options: { indent?: string } = {},
): string {
  const out: string[] = [];
  const base = options.indent ?? '';
  for (const n of Array.isArray(node) ? node : [node]) lines(n, depth, 0, base, out);
  return out.join('\n');
}

export function getDocumentSummary(doc: Document, depth = 1): string {
  const out: string[] = [];
  for (const page of doc.pages) {
    const n = page.frames.length;
    out.push(`${page.id} ${JSON.stringify(page.name)} (${n} ${n === 1 ? 'frame' : 'frames'})`);
    if (n > 0) out.push(getTreeSummary(page.frames, depth, { indent: '  ' }));
  }
  return out.join('\n');
}
