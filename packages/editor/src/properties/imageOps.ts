/** Lógica pura da seção "Imagem": monta os deltas de estilo (sem tocar em DOM, store ou rede). */
import {
  CLIP_PATH_PRESETS,
  IMAGE_FILTERS,
  OBJECT_POSITION_PRESETS,
  composeImageFilters,
  mergeImageFilters,
  normalizeObjectPosition,
  parseImageFilters,
  resolveClipPath,
} from '@mockup/core';
import type { ImageFilterName } from '@mockup/core';
import type { StyleDelta } from './shared';

/** Valores de filtro conhecidos (o que o painel mostra); funções desconhecidas ficam de fora. */
export function filterValues(filter: string | undefined): Partial<Record<ImageFilterName, number>> {
  return parseImageFilters(filter).filters;
}

/** Delta de `filter` ao mudar um filtro (`null` volta ao neutro); preserva funções desconhecidas. */
export function filterDelta(
  current: string | undefined,
  name: ImageFilterName,
  value: number | null,
): StyleDelta | null {
  const next = mergeImageFilters(current, { [name]: value });
  if (next === (current ?? '')) return null;
  return next ? { set: { filter: next } } : { unset: ['filter'] };
}

/** Valor de `filter` com o filtro trocado, para a prévia ao vivo (`''` = nenhum). */
export function filterPreview(
  current: string | undefined,
  name: ImageFilterName,
  value: number,
): string {
  return mergeImageFilters(current, { [name]: value });
}

/** "Restaurar": zera todos os filtros do painel e mantém o resto (`drop-shadow`, `url()`...). */
export function resetFiltersDelta(current: string | undefined): StyleDelta | null {
  if (!current) return null;
  const { rest } = parseImageFilters(current);
  const next = composeImageFilters({}, rest);
  if (next === current) return null;
  return next ? { set: { filter: next } } : { unset: ['filter'] };
}

/** Algum filtro do painel está fora do neutro? */
export function hasActiveFilters(filter: string | undefined): boolean {
  const f = filterValues(filter);
  return IMAGE_FILTERS.some((d) => f[d.name] !== undefined && f[d.name] !== d.neutral);
}

/** Delta de `clip-path` a partir de um preset (`circle`), `none`/vazio (remove) ou CSS livre. */
export function clipPathDelta(value: string): StyleDelta {
  const css = resolveClipPath(value);
  return css ? { set: { 'clip-path': css } } : { unset: ['clip-path'] };
}

/** Atalhos de posição em grade 3x3 (linha a linha) com o valor CSS de cada um. */
export const POSITION_GRID: { key: string; value: string }[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
].map((key) => ({ key, value: OBJECT_POSITION_PRESETS[key]! }));

/** Delta de `object-position` (aceita nome do preset ou CSS). */
export function objectPositionDelta(value: string): StyleDelta {
  const v = normalizeObjectPosition(value);
  return v ? { set: { 'object-position': v } } : { unset: ['object-position'] };
}

/** Posição atual normalizada para comparar com a grade (`center` → `50% 50%`). */
export function positionKey(value: string | undefined | null): string | null {
  if (value === undefined) return 'center';
  if (value === null) return null;
  const v = normalizeObjectPosition(value).replace(/\s+/g, ' ');
  return POSITION_GRID.find((p) => p.value === v)?.key ?? null;
}

export const CLIP_PRESET_KEYS = Object.keys(CLIP_PATH_PRESETS);
