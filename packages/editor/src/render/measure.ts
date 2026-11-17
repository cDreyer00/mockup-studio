/** Funções puras da medição da página de render (testáveis sem navegador). */
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

/** Propriedades de `LayoutStyle` lidas do `getComputedStyle`. */
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

/** Frame raiz (e página) que contém o nó; `null` se o nó não existe no documento. */
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
 * Agrupa retângulos de caracteres em linhas: caracteres cujo topo difere menos que a tolerância (e
 * que seguem na mesma direção) ficam juntos. Caracteres sem caixa (espaços colapsados) são ignorados.
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
 * Aplica o line box à linha medida (a caixa do texto é a área de conteúdo da fonte): devolve o
 * retângulo com a altura do line box, centrado, e a baseline a partir do topo dele.
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

/** Valores do `getComputedStyle` de um contêiner grid, como strings (já resolvidos pelo navegador). */
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

/** Tamanhos resolvidos (`"200px 200px"`, com nomes de linha opcionais) → início/tamanho a partir de `origin`. */
function tracksFrom(template: string, origin: number, gap: number): LayoutTrack[] {
  const sizes = parseTrackList(template).map((t) => (t.kind === 'px' ? (t.amount ?? 0) : 0));
  return layoutTracks(sizes, gap, origin);
}

/**
 * Trilhas medidas de um contêiner `display: grid`/`inline-grid`, relativas ao frame: lê as trilhas
 * resolvidas em px (`grid-template-columns`/`rows` do computed style) e posiciona-as na caixa de conteúdo
 * (retângulo do nó menos borda e padding). `undefined` se o nó não é grid.
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
