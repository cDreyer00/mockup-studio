/**
 * Text to outlines: converts `text` nodes into `svg` nodes with the glyphs drawn as paths.
 *
 * Used by the MCP tool `text_to_outlines` and by the editor HTTP route
 * (`POST /api/docs/:docId/text-to-outlines`), which call `buildTextOutlineOps`.
 *
 * - Font: effective family (the first one in the `font-family` stack that exists), weight and style.
 *   Looks first in the files embedded in the document (`doc.fonts`, under `assets/`) and then in the
 *   fonts installed on the system (`listSystemFonts`). `opentype.js` does not read WOFF2: `.woff2`
 *   files are decompressed with `woff2-encoder` (WASM, no native dependencies) before reading.
 * - Layout: with a render engine, uses the lines measured in the DOM (`LayoutNode.lines`); without
 *   one, wraps by width (greedy, by words) using the font advance, `line-height`, `letter-spacing`
 *   and `text-align`.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as opentypeNs from 'opentype.js';
import type { Font as OTFont } from 'opentype.js';
import {
  DOCUMENT_FONT_STACK,
  createVectorNode,
  findNode,
  getComputedLike,
  type Document,
  type FontRef,
  type LayoutNode,
  type Node,
  type Op,
  type Vector,
} from '@mockup/core';
import { listSystemFonts, type SystemFont } from './fonts.js';
import type { RenderProvider } from './render.js';

/** Usage error with the matching HTTP status (400 invalid input, 404 not found). */
export class OutlineError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export interface OutlineRequest {
  doc: Document;
  docId: string;
  nodeIds: string[];
  /** The document's `assets/` folder (null if it has not been saved yet). */
  assetsDir: string | null;
  render?: RenderProvider;
}

export interface OutlineResult {
  /** Ops for a single undo entry. */
  ops: Op[];
  /** Ids of the new svg nodes, in the order of `nodeIds`. */
  nodeIds: string[];
  /** Notes for the agent (font used, layout, missing glyphs). */
  notes: string[];
}

/* ---------------------------------------------------------------- font loading */

const otParse: (buf: ArrayBuffer) => OTFont = (() => {
  // The package is UMD (CJS in Node) or ESM with named exports only (bundlers): this covers both.
  const ns = opentypeNs as unknown as {
    parse?: (b: ArrayBuffer) => OTFont;
    default?: { parse: (b: ArrayBuffer) => OTFont };
  };
  const fn = ns.parse ?? ns.default?.parse;
  if (!fn) throw new Error('opentype.js does not expose parse');
  return fn;
})();

const FONT_FILE_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const FONT_CACHE_MAX = 24;
const MAX_FONT_BYTES = 20 * 1024 * 1024;
const fontCache = new Map<string, Promise<OTFont>>();

const toArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** Reads and parses a font file (ttf, otf, woff and woff2), cached by path, size and mtime. */
async function loadFontFile(file: string): Promise<OTFont> {
  const st = await fs.promises.stat(file);
  if (!st.isFile() || st.size > MAX_FONT_BYTES) throw new Error(`Invalid font file: ${file}`);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const hit = fontCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    let bytes: Uint8Array = await fs.promises.readFile(file);
    if (path.extname(file).toLowerCase() === '.woff2') {
      const { default: decompress } = await import('woff2-encoder/decompress');
      bytes = await decompress(bytes);
    }
    return otParse(toArrayBuffer(bytes));
  })();
  fontCache.set(key, p);
  if (fontCache.size > FONT_CACHE_MAX) fontCache.delete(fontCache.keys().next().value as string);
  p.catch(() => fontCache.delete(key));
  return p;
}

/** Font ready to draw: file read and, if variable, the axis coordinates. */
interface LoadedFont {
  font: OTFont;
  coords?: Record<string, number>;
  /** Description for the agent, e.g.: `Inter 700 (inter-700-normal-3100e775.woff2)`. */
  label: string;
}

interface Candidate {
  file: string;
  weightMin: number;
  weightMax: number;
  italic: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function pickCandidate(list: Candidate[], weight: number, italic: boolean): Candidate | undefined {
  let best: Candidate | undefined;
  let bestScore = Infinity;
  for (const c of list) {
    const dist =
      weight < c.weightMin ? c.weightMin - weight : weight > c.weightMax ? weight - c.weightMax : 0;
    const score = (c.italic === italic ? 0 : 1000) + dist;
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Candidates of an embedded font (`FontRef` convention: parallel lists or a weight range). */
function docCandidates(ref: FontRef, assetsDir: string): Candidate[] {
  const files = ref.files ?? [];
  const same = (a?: unknown[]): boolean => !!a && a.length === files.length;
  const ws = ref.weights?.filter((w) => Number.isFinite(w));
  const root = path.resolve(assetsDir);
  const out: Candidate[] = [];
  files.forEach((rel, i) => {
    if (!FONT_FILE_EXTS.has(path.extname(rel).toLowerCase())) return;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) return; // file outside assets/
    const lo = same(ws) ? ws![i]! : ws?.length ? Math.min(...ws) : 100;
    const hi = same(ws) ? ws![i]! : ws?.length ? Math.max(...ws) : 900;
    out.push({
      file: abs,
      weightMin: lo,
      weightMax: hi,
      italic: same(ref.styles) ? ref.styles![i] !== 'normal' : false,
    });
  });
  return out;
}

/** Absolute path of a file listed by the system (on Windows, the registry gives only the name). */
function systemFilePath(file: string): string {
  if (path.isAbsolute(file)) return file;
  if (process.platform === 'win32')
    return path.join(process.env['WINDIR'] ?? 'C:\\Windows', 'Fonts', file);
  return file;
}

function describeFile(font: OTFont): { weight: number; italic: boolean } {
  const os2 = font.tables['os2'] as { usWeightClass?: number; fsSelection?: number } | undefined;
  const head = font.tables['head'] as { macStyle?: number } | undefined;
  const italic = ((os2?.fsSelection ?? 0) & 1) === 1 || ((head?.macStyle ?? 0) & 2) === 2;
  return { weight: os2?.usWeightClass ?? 400, italic };
}

/** Reads all the family's files (ttc and unsupported formats are skipped) and describes each one. */
async function systemCandidates(sys: SystemFont): Promise<{ cand: Candidate; font: OTFont }[]> {
  const files = sys.files
    .map(systemFilePath)
    .filter((f) => FONT_FILE_EXTS.has(path.extname(f).toLowerCase()))
    .slice(0, 24);
  const out: { cand: Candidate; font: OTFont }[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const font = await loadFontFile(file);
        const d = describeFile(font);
        out.push({
          cand: { file, weightMin: d.weight, weightMax: d.weight, italic: d.italic },
          font,
        });
      } catch {
        // unreadable format: try the family's other files
      }
    }),
  );
  return out.sort((a, b) => a.cand.file.localeCompare(b.cand.file));
}

function withCoords(font: OTFont, weight: number, label: string): LoadedFont {
  const axes = (
    font.tables['fvar'] as
      { axes?: { tag: string; minValue: number; maxValue: number }[] } | undefined
  )?.axes;
  const wght = font.variation ? axes?.find((a) => a.tag === 'wght') : undefined;
  return wght
    ? {
        font,
        coords: { wght: clamp(weight, wght.minValue, wght.maxValue) },
        label,
      }
    : { font, label };
}

const GENERIC_FALLBACKS: Record<string, string[]> = {
  'sans-serif': [
    'Segoe UI',
    'Arial',
    'Helvetica',
    'Roboto',
    'DejaVu Sans',
    'Liberation Sans',
    'Noto Sans',
  ],
  serif: ['Times New Roman', 'Georgia', 'Liberation Serif', 'DejaVu Serif', 'Noto Serif'],
  monospace: ['Consolas', 'Courier New', 'DejaVu Sans Mono', 'Liberation Mono', 'Menlo'],
};
const GENERIC_ALIAS: Record<string, string> = {
  'system-ui': 'sans-serif',
  '-apple-system': 'sans-serif',
  blinkmacsystemfont: 'sans-serif',
  'ui-sans-serif': 'sans-serif',
  'ui-serif': 'serif',
  'ui-monospace': 'monospace',
  cursive: 'sans-serif',
  fantasy: 'sans-serif',
};

/** Splits `font-family` into names (without quotes), honoring quotes and commas inside them. */
export function parseFontFamilies(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Resolves the text font: document, then system, in stack order; finally the generics
 * (`sans-serif`, `serif`, `monospace`, `system-ui`...) mapped to common system fonts.
 */
export async function resolveTextFont(
  doc: Pick<Document, 'fonts'>,
  assetsDir: string | null,
  families: string[],
  weight: number,
  italic: boolean,
): Promise<LoadedFont> {
  const system = await listSystemFonts();
  const bySystemName = (name: string): SystemFont | undefined =>
    system.find((f) => f.family.toLowerCase() === name.toLowerCase());

  const fromSystem = async (sys: SystemFont): Promise<LoadedFont | undefined> => {
    const list = await systemCandidates(sys);
    const c = pickCandidate(
      list.map((x) => x.cand),
      weight,
      italic,
    );
    if (!c) return undefined;
    const font = list.find((x) => x.cand.file === c.file)!.font;
    return withCoords(font, weight, `${sys.family} ${weight} (${path.basename(c.file)}, system)`);
  };

  const tryName = async (name: string): Promise<LoadedFont | undefined> => {
    const ref = doc.fonts.find((f) => f.family.toLowerCase() === name.toLowerCase());
    if (ref?.files?.length && assetsDir) {
      const c = pickCandidate(docCandidates(ref, assetsDir), weight, italic);
      if (c) {
        try {
          const font = await loadFontFile(c.file);
          return withCoords(font, weight, `${ref.family} ${weight} (${path.basename(c.file)})`);
        } catch {
          // missing or corrupt file: try the system
        }
      }
    }
    const sys = bySystemName(name);
    return sys ? fromSystem(sys) : undefined;
  };

  const generics = new Set<string>();
  for (const name of families) {
    const key = name.toLowerCase();
    const generic = GENERIC_FALLBACKS[key] ? key : GENERIC_ALIAS[key];
    if (generic) {
      generics.add(generic);
      continue;
    }
    const hit = await tryName(name);
    if (hit) return hit;
  }
  if (!generics.size) generics.add('sans-serif');
  for (const g of generics) {
    for (const name of GENERIC_FALLBACKS[g]!) {
      const hit = await tryName(name);
      if (hit) return { ...hit, label: `${hit.label}, in place of ${g}` };
    }
  }
  throw new OutlineError(
    `No font found for "${families.join(', ')}" (weight ${weight}). ` +
      'Embed the file in the document with add_font (google, path or URL) or use an installed font (list_fonts); then try again.',
  );
}

/* ---------------------------------------------------------------- text style */

interface TextStyle {
  families: string[];
  size: number;
  weight: number;
  italic: boolean;
  /** `null` = `normal`. */
  lineHeight: number | null;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  transform: string;
  color: string;
  whiteSpace: string;
}

const HEADING_SIZE: Record<string, number> = {
  h1: 32,
  h2: 24,
  h3: 18.72,
  h4: 16,
  h5: 13.28,
  h6: 10.72,
};

/** Number in px of a CSS value (`px`, `em`, `rem`, `%` of `base`, bare number as a factor). */
function cssPx(value: string | undefined, base: number, unitless: 'factor' | 'px'): number | null {
  const m = /^\s*(-?\d*\.?\d+)\s*(px|rem|em|%|pt)?\s*$/i.exec(value ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? '').toLowerCase()) {
    case 'px':
      return n;
    case 'pt':
      return (n * 4) / 3;
    case 'rem':
      return n * 16;
    case 'em':
      return n * base;
    case '%':
      return (n / 100) * base;
    default:
      return unitless === 'factor' ? n * base : n;
  }
}

function weightOf(value: string | undefined, tag: string): number {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'bold' || v === 'bolder') return 700;
  if (v === 'lighter') return 300;
  if (v === 'normal') return 400;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 1000) return Math.round(n);
  return /^(h[1-6]|b|strong|th)$/.test(tag) ? 700 : 400;
}

function textStyleOf(node: Node, computed: Record<string, string | undefined>): TextStyle {
  const size = cssPx(computed['font-size'], 16, 'px') ?? HEADING_SIZE[node.tag] ?? 16;
  const color = (computed['color'] ?? '').trim();
  const align = (computed['text-align'] ?? 'left').trim().toLowerCase();
  const lh = (computed['line-height'] ?? 'normal').trim();
  return {
    families: parseFontFamilies(computed['font-family'] || DOCUMENT_FONT_STACK),
    size: size > 0 ? size : 16,
    weight: weightOf(computed['font-weight'], node.tag),
    italic: /italic|oblique/i.test(computed['font-style'] ?? ''),
    lineHeight: lh === 'normal' ? null : cssPx(lh, size, 'factor'),
    letterSpacing: cssPx(computed['letter-spacing'], size, 'px') ?? 0,
    align: align === 'center' ? 'center' : align === 'right' || align === 'end' ? 'right' : 'left',
    transform: (computed['text-transform'] ?? 'none').trim().toLowerCase(),
    // `currentcolor`, `inherit` and `var()` without a value are not usable as the path fill
    color:
      color &&
      !/currentcolor|inherit|initial|unset|var\(/i.test(color) &&
      /^[^<>"';{}\\]+$/.test(color)
        ? color
        : '#000000',
    whiteSpace: (computed['white-space'] ?? 'normal').trim().toLowerCase(),
  };
}

function applyTransform(text: string, transform: string): string {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize')
    return text.replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase());
  return text;
}

/* ---------------------------------------------------------------- layout and drawing */

interface PlacedLine {
  text: string;
  x: number;
  baseline: number;
}

interface Layout {
  width: number;
  height: number;
  lines: PlacedLine[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function glyphOptions(
  lf: LoadedFont,
  size: number,
  letterSpacing: number,
): Record<string, unknown> {
  return {
    kerning: true,
    variation: lf.coords,
    // opentype.js `letterSpacing` is a fraction of the font size (em)
    letterSpacing: letterSpacing ? letterSpacing / size : 0,
  };
}

/** Horizontal advance of `text` in px (with kerning and `letter-spacing`). */
function advance(lf: LoadedFont, text: string, size: number, letterSpacing: number): number {
  return lf.font.forEachGlyph(text, 0, 0, size, glyphOptions(lf, size, letterSpacing), (g) => {
    // apply the variable coordinates (adjusts `advanceWidth` via HVAR) before the advance is read
    lf.font.variation?.getTransform(g, lf.coords);
  });
}

/** Path data (px, Y not flipped) of the line, with the baseline at `y`. */
function linePathData(lf: LoadedFont, text: string, x: number, y: number, st: TextStyle): string {
  const parts: string[] = [];
  const opts = glyphOptions(lf, st.size, st.letterSpacing);
  lf.font.forEachGlyph(text, x, y, st.size, opts, (g, gx, gy, gs) => {
    const d = g.getPath(gx, gy, gs, opts, lf.font).toPathData(2);
    if (d) parts.push(d);
  });
  return parts.join(' ');
}

/** Wraps by width (greedy, by words); a word wider than the width stays alone on its line. */
function wrapParagraph(
  words: string[],
  maxWidth: number | undefined,
  width: (s: string) => number,
): string[] {
  if (maxWidth === undefined) return [words.join(' ')];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && width(next) > maxWidth + 0.01) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

const px = (v: string | undefined): number | undefined => {
  const m = /^\s*(-?\d*\.?\d+)px\s*$/i.exec(v ?? '');
  return m ? Number(m[1]) : undefined;
};

/** Padding in px (px values only; anything else counts as 0). */
function paddingOf(style: Record<string, string>): { t: number; r: number; b: number; l: number } {
  const parts = (style['padding'] ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => px(p) ?? 0);
  const [a = 0, b = a, c = a, d = b] = parts;
  return {
    t: px(style['padding-top']) ?? a,
    r: px(style['padding-right']) ?? b,
    b: px(style['padding-bottom']) ?? c,
    l: px(style['padding-left']) ?? d,
  };
}

/** Layout without a render engine: `\n` (if `white-space` preserves it), the node's px width, line-height and alignment. */
function layoutWithoutRender(node: Node, lf: LoadedFont, st: TextStyle, text: string): Layout {
  const pad = paddingOf(node.style);
  const boxWidth = px(node.style['width']);
  const maxInner = boxWidth !== undefined ? Math.max(0, boxWidth - pad.l - pad.r) : undefined;
  const preserve = /^pre/.test(st.whiteSpace) || st.whiteSpace === 'break-spaces';
  const noWrap = st.whiteSpace === 'nowrap' || st.whiteSpace === 'pre';
  const measure = (s: string): number => advance(lf, s, st.size, st.letterSpacing);

  const paragraphs = preserve ? text.split(/\r?\n/) : [text.replace(/\s+/g, ' ').trim()];
  const lines: string[] = [];
  for (const p of paragraphs) {
    if (preserve) {
      lines.push(...(noWrap ? [p] : wrapParagraph(p.split(/ +/), maxInner, measure)));
    } else if (p) {
      lines.push(...wrapParagraph(p.split(' '), noWrap ? undefined : maxInner, measure));
    }
  }

  const upm = lf.font.unitsPerEm || 1000;
  const asc = (lf.font.ascender / upm) * st.size;
  const desc = (-lf.font.descender / upm) * st.size;
  const gap =
    (((lf.font.tables['hhea'] as { lineGap?: number } | undefined)?.lineGap ?? 0) / upm) * st.size;
  const lh = st.lineHeight ?? asc + desc + gap;

  const widths = lines.map(measure);
  const inner = maxInner ?? Math.max(0, ...widths);
  const width = boxWidth ?? inner + pad.l + pad.r;
  const height = px(node.style['height']) ?? lines.length * lh + pad.t + pad.b;
  const placed = lines.map((text, i) => {
    const free = inner - widths[i]!;
    const dx = st.align === 'center' ? free / 2 : st.align === 'right' ? free : 0;
    return {
      text,
      x: pad.l + dx,
      baseline: pad.t + i * lh + (lh - (asc + desc)) / 2 + asc,
    };
  });
  return { width, height, lines: placed };
}

/** Layout from the lines measured in the DOM (relative to the frame): made relative to the node. */
function layoutFromMeasure(l: LayoutNode): Layout | null {
  const lines = (l.lines ?? [])
    .map((ln) => ({
      text: ln.text.replace(/\s+$/, ''),
      x: ln.x - l.x,
      baseline: ln.y - l.y + ln.baseline,
    }))
    .filter((ln) => ln.text);
  return lines.length ? { width: l.width, height: l.height, lines } : null;
}

/** Position and compositing properties that the outline svg inherits from the text. */
const INHERIT_PROPS = new Set([
  'position',
  'left',
  'top',
  'right',
  'bottom',
  'inset',
  'z-index',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'align-self',
  'justify-self',
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  'grid-area',
  'grid-column',
  'grid-row',
  'opacity',
  'transform',
  'transform-origin',
  'mix-blend-mode',
  'filter',
]);

/* ---------------------------------------------------------------- conversion */

async function outlineOne(
  req: OutlineRequest,
  nodeId: string,
  notes: string[],
): Promise<{ node: Node; parentId: string; index: number }> {
  const found = findNode(req.doc, nodeId);
  if (!found) throw new OutlineError(`Node not found: "${nodeId}".`, 404);
  const { node } = found;
  if (node.type !== 'text' || node.text === undefined)
    throw new OutlineError(
      `"${nodeId}" is ${node.type}, not a text node: text_to_outlines only converts text (see get_tree_summary).`,
    );
  if (!found.parent)
    throw new OutlineError(
      `"${nodeId}" has no parent: only nodes inside a frame can be converted.`,
    );
  if (!node.text.trim()) throw new OutlineError(`"${nodeId}" has no text to convert.`);

  let measured: LayoutNode | undefined;
  if (req.render) {
    try {
      measured = await req.render.measure({
        doc: req.doc,
        docId: req.docId,
        nodeId,
        assetsDir: req.assetsDir,
      });
    } catch (e) {
      notes.push(
        `Render measurement failed (${e instanceof Error ? e.message : String(e)}): layout computed from the font.`,
      );
    }
  }
  const computed: Record<string, string | undefined> = { ...getComputedLike(req.doc, nodeId) };
  for (const [k, v] of Object.entries(measured?.style ?? {})) if (v) computed[k] = v;
  const st = textStyleOf(node, computed);
  const lf = await resolveTextFont(req.doc, req.assetsDir, st.families, st.weight, st.italic);

  const text = applyTransform(node.text, st.transform);
  let layout = measured ? layoutFromMeasure(measured) : null;
  if (layout) {
    layout.lines = layout.lines.map((l) => ({ ...l, text: applyTransform(l.text, st.transform) }));
    notes.push('Layout: lines measured in the render.');
  } else {
    layout = layoutWithoutRender(node, lf, st, text);
    if (!measured)
      notes.push('Layout: computed from the font (no render engine); check with get_screenshot.');
  }

  const missing = new Set<string>();
  const paths = layout.lines
    .map((l) => {
      for (const ch of l.text)
        if (!/\s/.test(ch) && lf.font.charToGlyphIndex(ch) === 0) missing.add(ch);
      return linePathData(lf, l.text, l.x, l.baseline, st);
    })
    .filter(Boolean);
  if (!paths.length)
    throw new OutlineError(`The font "${lf.label}" has no glyphs for the text of "${nodeId}".`);

  const width = round2(Math.max(layout.width, 1));
  const height = round2(Math.max(layout.height, 1));
  const vector: Vector = {
    viewBox: { x: 0, y: 0, width, height },
    paths: paths.map((d, i) => ({ id: `p${i + 1}`, d, fill: st.color })),
  };
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.style)) if (INHERIT_PROPS.has(k)) style[k] = v;
  style['width'] = `${width}px`;
  style['height'] = `${height}px`;
  const svgNode = createVectorNode(vector, { name: `${node.name} (outlines)`, style });

  notes.push(`${nodeId}: font ${lf.label}, ${st.size}px, ${paths.length} line(s).`);
  if (missing.size)
    notes.push(
      `Warning: the font lacks the characters ${[...missing].slice(0, 12).join(' ')}; they came out as an empty glyph (.notdef).`,
    );
  return { node: svgNode, parentId: found.parent.id, index: found.index };
}

/**
 * Ops that replace each text node with an outline svg node, in the same parent and index (one undo
 * entry). Throws `OutlineError` (400/404) on invalid input or when no font is found.
 */
export async function buildTextOutlineOps(req: OutlineRequest): Promise<OutlineResult> {
  if (!req.nodeIds.length) throw new OutlineError('Provide at least one text node.');
  const ops: Op[] = [];
  const nodeIds: string[] = [];
  const notes: string[] = [];
  for (const id of req.nodeIds) {
    const { node, parentId, index } = await outlineOne(req, id, notes);
    ops.push({ type: 'createNode', parentId, node, index }, { type: 'deleteNodes', nodeIds: [id] });
    nodeIds.push(node.id);
  }
  return { ops, nodeIds, notes };
}
