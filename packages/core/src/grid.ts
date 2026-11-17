/**
 * CSS Grid como layout de primeira classe: trilhas, gaps, áreas e posicionamento de filhos.
 *
 * Tudo aqui é puro (sem DOM, sem Node): interpreta e gera os valores CSS de `grid-template-*`,
 * `gap`, `grid-template-areas` e `grid-column`/`grid-row`/`grid-area`, e converte coordenadas em
 * células a partir das trilhas medidas (`LayoutGrid`).
 */
import type { LayoutGrid, LayoutRect, LayoutTrack } from './layout.js';

/* ====================================================================== */
/* Trilhas                                                                 */
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
 * Uma trilha (`grid-template-columns`/`rows`). `value` é o texto CSS normalizado da trilha inteira
 * (`1fr`, `200px`, `minmax(120px, 1fr)`); `min`/`max` só existem em `minmax`; `amount` é o número de
 * `fr`, `px` ou `%`.
 */
export interface GridTrack {
  kind: GridTrackKind;
  value: string;
  min?: string;
  max?: string;
  amount?: number;
}

/** Trilha em entrada: texto CSS (`"1fr"`), número (px) ou o objeto já tipado. */
export type GridTrackInput = string | number | GridTrack;

/** Limite de repetições expandidas por `repeat(n, ...)`; acima disso a trilha vira `other`. */
const MAX_REPEAT = 200;

const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
const FR_RE = new RegExp(`^(${NUM})fr$`, 'i');
const PX_RE = new RegExp(`^(${NUM})px$`, 'i');
const PERCENT_RE = new RegExp(`^(${NUM})%$`);

/** Divide em tokens no nível superior (fora de parênteses) por espaço; `[nomes]` de linha são descartados. */
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

/** Corpo de `fn(...)` (sem os parênteses externos) ou `null`. */
function fnBody(token: string, name: string): string | null {
  const m = new RegExp(`^${name}\\(([\\s\\S]*)\\)$`, 'i').exec(token.trim());
  return m ? m[1]!.trim() : null;
}

const fmtNum = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Normaliza o espaçamento de uma lista de argumentos (`a,b` e `a ,  b` viram `a, b`). */
function normArgs(parts: string[]): string {
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).join(', ');
}

/** Classifica um token de trilha (um único tamanho, sem `repeat`). */
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
 * Lista de trilhas de um `grid-template-columns`/`rows`. Expande `repeat(n, ...)`; `repeat(auto-fill|auto-fit, ...)`,
 * `subgrid` e `masonry` viram uma trilha `other` com o texto preservado. Nomes de linha (`[a]`) são descartados.
 * `none`, vazio e `undefined` dão lista vazia.
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

/** Texto CSS de uma trilha de entrada (número = px). */
function trackText(t: GridTrackInput): string {
  if (typeof t === 'number') return `${fmtNum(t)}px`;
  if (typeof t === 'string') return parseTrack(t).value;
  return t.value;
}

/** Trilhas → CSS; recompacta repetições iguais em `repeat(n, x)`. Lista vazia vira `none`. */
export function serializeTrackList(tracks: GridTrackInput[]): string {
  const texts = tracks.map((t) => (typeof t === 'object' ? t.value : trackText(t)));
  const kinds = tracks.map((t) => (typeof t === 'object' ? t.kind : parseTrack(trackText(t)).kind));
  if (texts.length === 0) return 'none';
  const parts: string[] = [];
  let i = 0;
  while (i < texts.length) {
    let j = i + 1;
    // `other` pode ser um `repeat(auto-fill, ...)` inteiro: nunca é recompactado
    while (kinds[i] !== 'other' && j < texts.length && texts[j] === texts[i]) j++;
    parts.push(j - i >= 2 ? `repeat(${j - i}, ${texts[i]})` : texts[i]!);
    i = j;
  }
  return parts.join(' ');
}

/** `repeat(n, minmax(0, 1fr))`: n colunas/linhas iguais (o `grid-cols-n` do Tailwind). */
export function equalTracks(n: number): string {
  const count = Math.max(1, Math.floor(n));
  return `repeat(${count}, minmax(0, 1fr))`;
}

/* ====================================================================== */
/* Áreas nomeadas                                                          */
/* ====================================================================== */

const AREA_NAME_RE = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

/**
 * Valida as linhas de `grid-template-areas` (`["header header", "side main"]`): todas com o mesmo número de
 * células, nomes válidos (ou `.` para célula vazia) e cada área formando um retângulo. Devolve as linhas
 * normalizadas (células separadas por um espaço) e lança `Error` em português se algo estiver inválido.
 */
export function validateGridAreas(areas: string[]): string[][] {
  if (areas.length === 0) throw new Error('areas precisa de ao menos uma linha, ex.: ["a b"].');
  const rows = areas.map((r) => r.trim().split(/\s+/).filter(Boolean));
  const width = rows[0]!.length;
  rows.forEach((cells, y) => {
    if (cells.length === 0) throw new Error(`A linha ${y + 1} de areas está vazia.`);
    if (cells.length !== width) {
      throw new Error(
        `Todas as linhas de areas precisam ter o mesmo número de células: a linha 1 tem ${width} e a linha ${y + 1} tem ${cells.length}.`,
      );
    }
    for (const c of cells) {
      if (!/^\.+$/.test(c) && !AREA_NAME_RE.test(c)) {
        throw new Error(
          `Nome de área inválido: "${c}". Use letras, números, "-" ou "_" (ou "." para célula vazia).`,
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
        `A área "${name}" não forma um retângulo (células separadas ou em L). Cada nome precisa ocupar um bloco contínuo.`,
      );
    }
  }
  return rows.map((cells) => cells.map((c) => (/^\.+$/.test(c) ? '.' : c)));
}

/** Linhas de áreas → valor de `grid-template-areas` (`"header header" "side main"`). */
export function serializeGridAreas(areas: string[]): string {
  return validateGridAreas(areas)
    .map((cells) => `"${cells.join(' ')}"`)
    .join(' ');
}

/** `grid-template-areas` → linhas (`["header header", "side main"]`); `none`/vazio dão lista vazia. */
export function parseGridAreas(value: string | undefined): string[] {
  const v = (value ?? '').trim();
  if (v === '' || /^none$/i.test(v)) return [];
  const rows: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) rows.push((m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' '));
  return rows;
}

/** Nomes das áreas declaradas em `grid-template-areas`, sem repetição, na ordem de aparição. */
export function gridAreaNames(value: string | undefined): string[] {
  const names: string[] = [];
  for (const row of parseGridAreas(value)) {
    for (const c of row.split(' ')) if (c && !/^\.+$/.test(c) && !names.includes(c)) names.push(c);
  }
  return names;
}

/* ====================================================================== */
/* Estilos do contêiner                                                    */
/* ====================================================================== */

/** `columns`/`rows`: número (`repeat(n, minmax(0, 1fr))`), texto CSS ou lista de trilhas. */
export type GridTemplateInput = number | string | GridTrackInput[];

export interface GridContainerOptions {
  columns: GridTemplateInput;
  rows?: GridTemplateInput;
  /** Número (px) ou texto CSS (`"16px"`, `"16px 24px"`). */
  gap?: number | string;
  columnGap?: number | string;
  rowGap?: number | string;
  /** Linhas de `grid-template-areas`, ex.: `["header header", "side main"]`. */
  areas?: string[];
  placeItems?: string;
  autoFlow?: string;
}

function templateValue(input: GridTemplateInput, label: string): string {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 1)
      throw new Error(`${label} precisa ser um inteiro >= 1.`);
    return equalTracks(input);
  }
  if (typeof input === 'string') {
    const v = input.trim();
    if (v === '') throw new Error(`${label} está vazio. Ex.: 3, "1fr 2fr" ou ["200px", "1fr"].`);
    return v;
  }
  if (input.length === 0) throw new Error(`${label} precisa de ao menos uma trilha.`);
  return serializeTrackList(input);
}

const gapText = (g: number | string): string =>
  typeof g === 'number' ? `${fmtNum(g)}px` : g.trim();

/**
 * Estilos CSS de um contêiner grid (`display: grid` + trilhas, gaps, áreas, alinhamento e fluxo).
 * Só emite o que foi pedido. Com `gap` e `columnGap`/`rowGap` juntos, expande em `column-gap`/`row-gap`.
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

/** O estilo descreve um contêiner grid (`display: grid` ou `inline-grid`)? */
export function isGridContainer(style: Record<string, string | undefined>): boolean {
  const d = (style.display ?? '').trim().toLowerCase();
  return d === 'grid' || d === 'inline-grid';
}

/** Número de trilhas declaradas em `grid-template-columns`/`rows` (`repeat(auto-fill, ...)` conta como 1). */
export function trackCount(
  style: Record<string, string | undefined>,
  axis: 'columns' | 'rows',
): number {
  return parseTrackList(style[`grid-template-${axis}`]).length;
}

/* ====================================================================== */
/* Posicionamento dos filhos                                               */
/* ====================================================================== */

/** Posição de um filho no grid; colunas e linhas começam em 1. */
export interface GridPlacement {
  column?: number;
  row?: number;
  columnSpan?: number;
  rowSpan?: number;
  /** Nome de `grid-area` (área nomeada). */
  area?: string;
}

function axisValue(start: number | undefined, span: number | undefined): string | undefined {
  if (start === undefined && span === undefined) return undefined;
  if (start === undefined) return `span ${span}`;
  return span !== undefined && span > 1 ? `${start} / span ${span}` : String(start);
}

function checkLine(n: number | undefined, label: string): void {
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
    throw new Error(`${label} precisa ser um inteiro >= 1 (as linhas do grid começam em 1).`);
  }
}

/** Estilos de posicionamento: `grid-column`/`grid-row` (`2 / span 2`) ou `grid-area` (área nomeada). */
export function gridPlacementStyles(p: GridPlacement): Record<string, string> {
  if (p.area !== undefined && p.area.trim() !== '') {
    const area = p.area.trim();
    if (!AREA_NAME_RE.test(area)) {
      throw new Error(`Nome de área inválido: "${area}". Use letras, números, "-" ou "_".`);
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

/** Lê `grid-column`, `grid-row`, `grid-area` e as formas longas (`grid-column-start`...) de um estilo. */
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
        // `grid-area: 2` vale a linha de início da linha (row-start) e repete o resto como `auto`
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
/* Tamanho das trilhas sem DOM                                             */
/* ====================================================================== */

interface Sizing {
  /** Tamanho fixo em px (px e %). */
  fixed?: number;
  /** Peso fr (fr, auto, min/max-content, fit-content, other e minmax com máximo flexível). */
  weight?: number;
  /** Piso em px (mínimo de `minmax`). */
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
      // auto, min/max-content, fit-content, other: sem DOM não há medida de conteúdo; contam como 1fr
      return { weight: 1, floor: 0 };
  }
}

/**
 * Tamanho de cada trilha em px, sem DOM: `px` e `%` (do espaço disponível) são fixos, `fr` divide o
 * restante (descontados os gaps) por peso, e `auto`/`min-content`/`max-content`/`fit-content` contam como
 * 1fr. `minmax` respeita o piso em px. É uma aproximação para o fallback quando não há render.
 */
export function resolveTrackSizes(tracks: GridTrack[], available: number, gap = 0): number[] {
  const n = tracks.length;
  if (n === 0) return [];
  const sizing = tracks.map((t) => sizingOf(t, available));
  const sizes = sizing.map((s) => s.fixed ?? 0);
  const flexible = sizing.map((s, i) => (s.weight !== undefined ? i : -1)).filter((i) => i >= 0);
  const pinned = new Set<number>();
  const free0 = available - gap * (n - 1) - sizes.reduce((a, b) => a + b, 0);
  // repete: trilhas flexíveis cujo piso passa da parte proporcional ficam no piso e saem do rateio
  for (let pass = 0; pass <= flexible.length; pass++) {
    const open = flexible.filter((i) => !pinned.has(i));
    const pinnedTotal = [...pinned].reduce((a, i) => a + sizing[i]!.floor, 0);
    const free = Math.max(0, free0 - pinnedTotal);
    const totalWeight = open.reduce((a, i) => a + sizing[i]!.weight!, 0);
    // soma dos fatores < 1: só essa fração do espaço livre é distribuída
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

/** Posições e tamanhos (`LayoutTrack`) a partir dos tamanhos resolvidos, com o início em `origin`. */
export function layoutTracks(sizes: number[], gap = 0, origin = 0): LayoutTrack[] {
  let pos = origin;
  return sizes.map((size) => {
    const t = { start: pos, size };
    pos += size + gap;
    return t;
  });
}

/* ====================================================================== */
/* Células (para o editor e para o get_layout)                             */
/* ====================================================================== */

/** Célula 1-based: coluna e linha. */
export interface GridCell {
  column: number;
  row: number;
}

/** Célula com extensão: início e quantas trilhas ocupa. */
export interface GridSpan extends GridCell {
  columnSpan: number;
  rowSpan: number;
}

/** Índice (0-based) da trilha que contém `pos`; em gaps, a trilha mais próxima; `-1` fora do grid. */
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

/** Célula (1-based) sob o ponto `(x, y)` (mesmo sistema de coordenadas das trilhas); `null` fora do grid. */
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
 * Início e extensão (em trilhas) de um retângulo sobre o grid: a borda inicial encaixa no início da trilha
 * mais próximo e a final, no fim mais próximo (usado ao esticar um filho pelas alças). `null` sem trilhas.
 */
export function spanFromRect(grid: LayoutGrid, rect: LayoutRect): GridSpan | null {
  if (grid.columns.length === 0 || grid.rows.length === 0) return null;
  const c0 = nearestEdge(grid.columns, rect.x, false);
  const c1 = Math.max(c0, nearestEdge(grid.columns, rect.x + rect.width, true));
  const r0 = nearestEdge(grid.rows, rect.y, false);
  const r1 = Math.max(r0, nearestEdge(grid.rows, rect.y + rect.height, true));
  return { column: c0 + 1, row: r0 + 1, columnSpan: c1 - c0 + 1, rowSpan: r1 - r0 + 1 };
}

/** Retângulo (mesmo sistema das trilhas) coberto por uma célula e sua extensão; `null` se fora do grid. */
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
/* Texto compacto das trilhas medidas                                      */
/* ====================================================================== */

const round1 = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * Linha compacta das trilhas medidas, usada por `get_layout`:
 * `grid cols 0+200,216+200 rows 0+100 gap 16/16` (cada trilha é `início+tamanho` em px).
 */
export function formatGridTracks(grid: LayoutGrid): string {
  const list = (tracks: LayoutTrack[]): string =>
    tracks.length === 0 ? '-' : tracks.map((t) => `${round1(t.start)}+${round1(t.size)}`).join(',');
  return `grid cols ${list(grid.columns)} rows ${list(grid.rows)} gap ${round1(grid.columnGap)}/${round1(grid.rowGap)}`;
}
