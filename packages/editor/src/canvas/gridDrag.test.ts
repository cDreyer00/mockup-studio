import { describe, expect, it } from 'vitest';
import type { LayoutGrid } from '@mockup/core';
import {
  clampPlacement,
  currentPlacement,
  deltaChangesStyle,
  dropPlacement,
  placementDelta,
  placementRect,
  resizeSpan,
} from './gridDrag';

/** 3 colunas de 100 (gap 10) a partir de x=20 e 2 linhas de 50 (gap 10) a partir de y=40. */
const grid: LayoutGrid = {
  columns: [
    { start: 20, size: 100 },
    { start: 130, size: 100 },
    { start: 240, size: 100 },
  ],
  rows: [
    { start: 40, size: 50 },
    { start: 100, size: 50 },
  ],
  columnGap: 10,
  rowGap: 10,
};

describe('dropPlacement', () => {
  it('acha a célula sob o ponteiro e mantém a extensão', () => {
    expect(dropPlacement(grid, { x: 150, y: 120 }, { columnSpan: 1, rowSpan: 1 })).toEqual({
      column: 2,
      row: 2,
      columnSpan: 1,
      rowSpan: 1,
    });
  });
  it('recua o início quando a extensão passaria do fim', () => {
    expect(dropPlacement(grid, { x: 300, y: 50 }, { columnSpan: 2, rowSpan: 1 })).toEqual({
      column: 2,
      row: 1,
      columnSpan: 2,
      rowSpan: 1,
    });
  });
  it('devolve null fora do grid', () => {
    expect(dropPlacement(grid, { x: 5, y: 50 }, { columnSpan: 1, rowSpan: 1 })).toBeNull();
    expect(dropPlacement(grid, { x: 50, y: 500 }, { columnSpan: 1, rowSpan: 1 })).toBeNull();
  });
  it('em um gap escolhe a trilha mais próxima', () => {
    expect(dropPlacement(grid, { x: 124, y: 50 }, { columnSpan: 1, rowSpan: 1 })?.column).toBe(1);
    expect(dropPlacement(grid, { x: 127, y: 50 }, { columnSpan: 1, rowSpan: 1 })?.column).toBe(2);
  });
});

describe('clampPlacement', () => {
  it('limita extensão e início às trilhas existentes', () => {
    expect(clampPlacement(grid, { column: 3, row: 2, columnSpan: 5, rowSpan: 4 })).toEqual({
      column: 1,
      row: 1,
      columnSpan: 3,
      rowSpan: 2,
    });
  });
});

describe('currentPlacement', () => {
  const rect = { x: 130, y: 100, w: 210, h: 50 };
  it('usa o estilo declarado', () => {
    expect(currentPlacement(grid, rect, { 'grid-column': '2 / span 2', 'grid-row': '2' })).toEqual({
      column: 2,
      row: 2,
      columnSpan: 2,
      rowSpan: 1,
    });
  });
  it('completa o automático com a caixa renderizada', () => {
    expect(currentPlacement(grid, rect, {})).toEqual({
      column: 2,
      row: 2,
      columnSpan: 2,
      rowSpan: 1,
    });
  });
});

describe('resizeSpan', () => {
  const start = { column: 1, row: 1, columnSpan: 1, rowSpan: 1 };
  it('estica pela borda direita até a trilha mais próxima', () => {
    expect(resizeSpan(grid, start, 'e', { x: 225, y: 60 })).toEqual({ ...start, columnSpan: 2 });
    expect(resizeSpan(grid, start, 'e', { x: 400, y: 60 })).toEqual({ ...start, columnSpan: 3 });
  });
  it('estica pela borda inferior sem mexer nas colunas', () => {
    expect(resizeSpan(grid, start, 's', { x: 5000, y: 145 })).toEqual({ ...start, rowSpan: 2 });
  });
  it('nunca fica abaixo de 1', () => {
    const wide = { ...start, columnSpan: 3 };
    expect(resizeSpan(grid, wide, 'e', { x: 0, y: 60 })).toEqual({ ...start, columnSpan: 1 });
  });
});

describe('placementRect', () => {
  it('cobre a extensão inteira', () => {
    expect(placementRect(grid, { column: 2, row: 1, columnSpan: 2, rowSpan: 2 })).toEqual({
      x: 130,
      y: 40,
      w: 210,
      h: 110,
    });
  });
});

describe('placementDelta', () => {
  it('grava grid-column/grid-row e remove grid-area', () => {
    const d = placementDelta(
      { 'grid-area': 'main' },
      { column: 2, row: 1, columnSpan: 2, rowSpan: 1 },
    );
    expect(d.set).toEqual({ 'grid-column': '2 / span 2', 'grid-row': '1' });
    expect(d.unset).toEqual(['grid-area']);
  });
  it('remove as formas longas -start/-end ao gravar grid-column/grid-row', () => {
    const d = placementDelta(
      {
        'grid-column-start': '2',
        'grid-column-end': 'span 2',
        'grid-row-start': '1',
        'grid-row-end': '3',
      },
      { column: 3, row: 2, columnSpan: 1, rowSpan: 1 },
    );
    expect(d.set).toEqual({ 'grid-column': '3', 'grid-row': '2' });
    expect(d.unset.sort()).toEqual([
      'grid-column-end',
      'grid-column-start',
      'grid-row-end',
      'grid-row-start',
    ]);
  });
  it('preserva o que não está no patch', () => {
    const d = placementDelta({ 'grid-column': '2 / span 2', 'grid-row': '1' }, { row: 2 });
    expect(d.set).toEqual({ 'grid-column': '2 / span 2', 'grid-row': '2' });
    expect(d.unset).toEqual([]);
  });
  it('null volta ao automático', () => {
    const d = placementDelta({ 'grid-column': '2', 'grid-row': '1' }, { column: null, row: null });
    expect(d.set).toEqual({});
    expect(d.unset.sort()).toEqual(['grid-column', 'grid-row']);
  });
  it('extensão sem início vira span', () => {
    expect(placementDelta({}, { columnSpan: 2 }).set).toEqual({ 'grid-column': 'span 2' });
    expect(placementDelta({}, { columnSpan: 1 }).set).toEqual({});
  });
  it('detecta quando nada muda', () => {
    const style = { 'grid-column': '2', 'grid-row': '1' };
    expect(deltaChangesStyle(style, placementDelta(style, { column: 2, row: 1 }))).toBe(false);
    expect(deltaChangesStyle(style, placementDelta(style, { column: 3 }))).toBe(true);
  });
});
