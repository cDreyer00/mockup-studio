/**
 * Lógica do editor de grid do painel (pura, sem React): trilhas de `grid-template-columns`/`rows` como
 * rascunhos editáveis (`fr`, `px`, `%`, `auto`, `minmax(min, max)`), gaps e `place-items`.
 */
import { parseTrack, parseTrackList, serializeTrackList } from '@mockup/core';
import type { GridTrack } from '@mockup/core';

export type TrackUnit = 'fr' | 'px' | '%' | 'auto' | 'minmax' | 'css';

export const TRACK_UNITS: { value: TrackUnit; label: string }[] = [
  { value: 'fr', label: 'fr' },
  { value: 'px', label: 'px' },
  { value: '%', label: '%' },
  { value: 'auto', label: 'auto' },
  { value: 'minmax', label: 'minmax' },
  { value: 'css', label: 'CSS' },
];

/** Uma trilha na UI: `value` serve a fr/px/%/css; `min`/`max` só a `minmax`. */
export interface TrackDraft {
  unit: TrackUnit;
  value: string;
  min: string;
  max: string;
}

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

/** Texto de um limite de `minmax`/trilha: número puro vira px (`120` → `120px`; `0` fica `0`). */
export function normalizeTrackValue(text: string): string {
  const t = text.trim();
  if (t === '') return 'auto';
  if (NUMBER_RE.test(t)) return parseFloat(t) === 0 ? '0' : `${parseFloat(t)}px`;
  return parseTrack(t).value;
}

const amountText = (t: GridTrack): string => (t.amount === undefined ? '' : String(t.amount));

/** Trilha medida/parseada → rascunho. */
export function trackToDraft(t: GridTrack): TrackDraft {
  switch (t.kind) {
    case 'fr':
      return { unit: 'fr', value: amountText(t), min: '', max: '' };
    case 'px':
      return { unit: 'px', value: amountText(t), min: '', max: '' };
    case 'percent':
      return { unit: '%', value: amountText(t), min: '', max: '' };
    case 'auto':
      return { unit: 'auto', value: '', min: '', max: '' };
    case 'minmax':
      return { unit: 'minmax', value: '', min: t.min ?? 'auto', max: t.max ?? 'auto' };
    default:
      return { unit: 'css', value: t.value, min: '', max: '' };
  }
}

const numOr = (text: string, fallback: number): number => {
  const n = parseFloat(text);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
};

/** Rascunho → texto CSS normalizado da trilha. */
export function draftToCss(d: TrackDraft): string {
  switch (d.unit) {
    case 'fr':
      return parseTrack(`${numOr(d.value, 1)}fr`).value;
    case 'px':
      return parseTrack(`${numOr(d.value, 0)}px`).value;
    case '%':
      return parseTrack(`${numOr(d.value, 0)}%`).value;
    case 'auto':
      return 'auto';
    case 'minmax':
      return parseTrack(`minmax(${normalizeTrackValue(d.min)}, ${normalizeTrackValue(d.max)})`)
        .value;
    case 'css':
      return d.value.trim() === '' ? 'auto' : parseTrack(d.value).value;
  }
}

/** Trilhas de um `grid-template-*` como rascunhos (`repeat(n, x)` expandido). */
export function draftsFromStyle(value: string | undefined): TrackDraft[] {
  return parseTrackList(value).map(trackToDraft);
}

/** Rascunhos → valor do estilo (recompacta repetições); `undefined` quando não há trilhas. */
export function draftsToStyle(drafts: readonly TrackDraft[]): string | undefined {
  if (drafts.length === 0) return undefined;
  return serializeTrackList(drafts.map(draftToCss));
}

/** Troca a unidade tentando preservar o valor (fr↔px mantém o número; minmax aproveita o valor atual). */
export function changeUnit(d: TrackDraft, unit: TrackUnit): TrackDraft {
  if (unit === d.unit) return d;
  const css = draftToCss(d);
  const num = parseTrack(css).amount;
  const n = num !== undefined ? String(num) : '';
  switch (unit) {
    case 'fr':
      return { unit, value: n || '1', min: '', max: '' };
    case 'px':
      return { unit, value: n || '100', min: '', max: '' };
    case '%':
      return { unit, value: n || '50', min: '', max: '' };
    case 'auto':
      return { unit, value: '', min: '', max: '' };
    case 'minmax':
      // fr → minmax(0, Nfr); px → minmax(Npx, 1fr); outros → minmax(0, 1fr)
      if (d.unit === 'fr') return { unit, value: '', min: '0', max: css };
      if (d.unit === 'px') return { unit, value: '', min: css, max: '1fr' };
      return { unit, value: '', min: '0', max: '1fr' };
    case 'css':
      return { unit, value: css, min: '', max: '' };
  }
}

export const newTrack = (): TrackDraft => ({ unit: 'fr', value: '1', min: '', max: '' });

export const addTrack = (drafts: readonly TrackDraft[]): TrackDraft[] => [...drafts, newTrack()];

export const removeTrack = (drafts: readonly TrackDraft[], index: number): TrackDraft[] =>
  drafts.filter((_, i) => i !== index);

export const updateTrack = (
  drafts: readonly TrackDraft[],
  index: number,
  patch: Partial<TrackDraft>,
): TrackDraft[] => drafts.map((d, i) => (i === index ? { ...d, ...patch } : d));

/* ------------------------------ gaps ------------------------------ */

export interface StyleChange {
  set: Record<string, string>;
  unset: string[];
}

export interface Gaps {
  /** `column-gap` efetivo (declaração própria ou do shorthand `gap`). */
  col: string | undefined;
  row: string | undefined;
  /** Valor único quando colunas e linhas são iguais (`undefined` se sem gap, `null` se diferentes). */
  both: string | undefined | null;
}

/** Gaps efetivos de um estilo (`gap: <row> [<col>]`, `row-gap`, `column-gap`). */
export function readGaps(style: Record<string, string | undefined>): Gaps {
  const tokens = (style.gap ?? '').trim().split(/\s+/).filter(Boolean);
  const col = style['column-gap'] ?? tokens[1] ?? tokens[0];
  const row = style['row-gap'] ?? tokens[0];
  return { col, row, both: col === row ? col : null };
}

const present = (style: Record<string, string | undefined>, keys: string[]): string[] =>
  keys.filter((k) => style[k] !== undefined);

/** Delta para definir o gap das colunas, das linhas ou dos dois (`value` vazio remove). */
export function gapDelta(
  style: Record<string, string | undefined>,
  axis: 'both' | 'col' | 'row',
  value: string,
): StyleChange {
  const v = value.trim();
  const g = readGaps(style);
  const col = axis === 'row' ? g.col : v;
  const row = axis === 'col' ? g.row : v;
  const all = ['gap', 'column-gap', 'row-gap'];
  if (!col && !row) return { set: {}, unset: present(style, all) };
  if (col === row) return { set: { gap: col! }, unset: present(style, ['column-gap', 'row-gap']) };
  const set: Record<string, string> = {};
  if (col) set['column-gap'] = col;
  if (row) set['row-gap'] = row;
  return {
    set,
    unset: present(style, ['gap', ...(col ? [] : ['column-gap']), ...(row ? [] : ['row-gap'])]),
  };
}

/* ------------------------------ place-items ------------------------------ */

export interface PlaceItems {
  align: string | undefined;
  justify: string | undefined;
}

/** `align-items`/`justify-items` efetivos (inclui o shorthand `place-items: <align> [<justify>]`). */
export function readPlaceItems(style: Record<string, string | undefined>): PlaceItems {
  const tokens = (style['place-items'] ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    align: style['align-items'] ?? tokens[0],
    justify: style['justify-items'] ?? tokens[1] ?? tokens[0],
  };
}

/** Delta para `align-items`/`justify-items`; expande o shorthand `place-items` se existir. */
export function placeItemsDelta(
  style: Record<string, string | undefined>,
  which: 'align' | 'justify',
  value: string,
): StyleChange {
  const key = which === 'align' ? 'align-items' : 'justify-items';
  const v = value.trim();
  if (style['place-items'] === undefined) {
    return v === '' ? { set: {}, unset: present(style, [key]) } : { set: { [key]: v }, unset: [] };
  }
  const cur = readPlaceItems(style);
  const align = which === 'align' ? v : cur.align;
  const justify = which === 'justify' ? v : cur.justify;
  const set: Record<string, string> = {};
  if (align) set['align-items'] = align;
  if (justify) set['justify-items'] = justify;
  return {
    set,
    unset: [
      'place-items',
      ...present(style, ['align-items', 'justify-items']).filter((k) => set[k] === undefined),
    ],
  };
}
