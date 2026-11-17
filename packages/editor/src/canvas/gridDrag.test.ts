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

/** 3 columns of 100 (gap 10) starting at x=20 and 2 rows of 50 (gap 10) starting at y=40. */
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
  it('finds the cell under the pointer and keeps the extent', () => {
    expect(dropPlacement(grid, { x: 150, y: 120 }, { columnSpan: 1, rowSpan: 1 })).toEqual({
      column: 2,
      row: 2,
      columnSpan: 1,
      rowSpan: 1,
    });
  });
  it('moves the start back when the extent would go past the end', () => {
    expect(dropPlacement(grid, { x: 300, y: 50 }, { columnSpan: 2, rowSpan: 1 })).toEqual({
      column: 2,
      row: 1,
      columnSpan: 2,
      rowSpan: 1,
    });
  });
  it('returns null outside the grid', () => {
    expect(dropPlacement(grid, { x: 5, y: 50 }, { columnSpan: 1, rowSpan: 1 })).toBeNull();
    expect(dropPlacement(grid, { x: 50, y: 500 }, { columnSpan: 1, rowSpan: 1 })).toBeNull();
  });
  it('in a gap picks the nearest track', () => {
    expect(dropPlacement(grid, { x: 124, y: 50 }, { columnSpan: 1, rowSpan: 1 })?.column).toBe(1);
    expect(dropPlacement(grid, { x: 127, y: 50 }, { columnSpan: 1, rowSpan: 1 })?.column).toBe(2);
  });
});

describe('clampPlacement', () => {
  it('limits extent and start to the existing tracks', () => {
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
  it('uses the declared style', () => {
    expect(currentPlacement(grid, rect, { 'grid-column': '2 / span 2', 'grid-row': '2' })).toEqual({
      column: 2,
      row: 2,
      columnSpan: 2,
      rowSpan: 1,
    });
  });
  it('fills in the automatic one with the rendered box', () => {
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
  it('stretches by the right edge to the nearest track', () => {
    expect(resizeSpan(grid, start, 'e', { x: 225, y: 60 })).toEqual({ ...start, columnSpan: 2 });
    expect(resizeSpan(grid, start, 'e', { x: 400, y: 60 })).toEqual({ ...start, columnSpan: 3 });
  });
  it('stretches by the bottom edge without touching the columns', () => {
    expect(resizeSpan(grid, start, 's', { x: 5000, y: 145 })).toEqual({ ...start, rowSpan: 2 });
  });
  it('never goes below 1', () => {
    const wide = { ...start, columnSpan: 3 };
    expect(resizeSpan(grid, wide, 'e', { x: 0, y: 60 })).toEqual({ ...start, columnSpan: 1 });
  });
});

describe('placementRect', () => {
  it('covers the whole extent', () => {
    expect(placementRect(grid, { column: 2, row: 1, columnSpan: 2, rowSpan: 2 })).toEqual({
      x: 130,
      y: 40,
      w: 210,
      h: 110,
    });
  });
});

describe('placementDelta', () => {
  it('writes grid-column/grid-row and removes grid-area', () => {
    const d = placementDelta(
      { 'grid-area': 'main' },
      { column: 2, row: 1, columnSpan: 2, rowSpan: 1 },
    );
    expect(d.set).toEqual({ 'grid-column': '2 / span 2', 'grid-row': '1' });
    expect(d.unset).toEqual(['grid-area']);
  });
  it('removes the long forms -start/-end when writing grid-column/grid-row', () => {
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
  it('preserves what is not in the patch', () => {
    const d = placementDelta({ 'grid-column': '2 / span 2', 'grid-row': '1' }, { row: 2 });
    expect(d.set).toEqual({ 'grid-column': '2 / span 2', 'grid-row': '2' });
    expect(d.unset).toEqual([]);
  });
  it('null goes back to automatic', () => {
    const d = placementDelta({ 'grid-column': '2', 'grid-row': '1' }, { column: null, row: null });
    expect(d.set).toEqual({});
    expect(d.unset.sort()).toEqual(['grid-column', 'grid-row']);
  });
  it('extent without a start becomes span', () => {
    expect(placementDelta({}, { columnSpan: 2 }).set).toEqual({ 'grid-column': 'span 2' });
    expect(placementDelta({}, { columnSpan: 1 }).set).toEqual({});
  });
  it('detects when nothing changes', () => {
    const style = { 'grid-column': '2', 'grid-row': '1' };
    expect(deltaChangesStyle(style, placementDelta(style, { column: 2, row: 1 }))).toBe(false);
    expect(deltaChangesStyle(style, placementDelta(style, { column: 3 }))).toBe(true);
  });
});
