import { describe, expect, it } from 'vitest';
import { fitLineBox, groupLines, measureGridTracks, pickFrame } from './measure';
import type { GridComputed } from './measure';
import { makeDoc } from '../test/fixtures';

const ch = (c: string, x: number, y: number, w = 6, h = 16) => ({
  ch: c,
  x,
  y,
  width: w,
  height: h,
});

describe('groupLines', () => {
  it('groups characters by line and trims spaces at the ends', () => {
    const lines = groupLines([
      ch('O', 0, 0),
      ch('i', 6, 0),
      ch(' ', 12, 0),
      ch('t', 0, 20),
      ch('u', 6, 20),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: 'Oi', x: 0, y: 0, width: 18, height: 16 });
    expect(lines[1]).toMatchObject({ text: 'tu', y: 20, width: 12 });
  });

  it('ignores characters without a box and tolerates small top variations', () => {
    const lines = groupLines([
      ch('a', 0, 0),
      { ch: ' ', x: 6, y: 0, width: 0, height: 0 },
      ch('b', 6, 1),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('ab');
  });

  it('new line when x goes backwards at roughly the same height', () => {
    const lines = groupLines([ch('a', 50, 0), ch('b', 0, 0)]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('fitLineBox', () => {
  it('centers the baseline in the line box', () => {
    const r = fitLineBox(
      { x: 0, y: 10, width: 10, height: 20, text: 'x' },
      { ascent: 16, descent: 4 },
      30,
    );
    expect(r).toEqual({ y: 5, height: 30, baseline: 21 });
  });
  it('normal line-height uses the content area', () => {
    const r = fitLineBox(
      { x: 0, y: 10, width: 10, height: 20, text: 'x' },
      { ascent: 16, descent: 4 },
      null,
    );
    expect(r).toEqual({ y: 10, height: 20, baseline: 16 });
  });
});

describe('pickFrame', () => {
  it('finds the root frame of the node and the page background', () => {
    const { doc, frame, a } = makeDoc();
    doc.pages[0]!.background = '#123456';
    expect(pickFrame(doc, a.id)).toMatchObject({ frame: { id: frame.id }, background: '#123456' });
    expect(pickFrame(doc, frame.id)?.frame.id).toBe(frame.id);
    expect(pickFrame(doc, 'nao_existe')).toBeNull();
  });
});

describe('measureGridTracks', () => {
  const cs = (over: Partial<GridComputed> = {}): GridComputed => ({
    display: 'grid',
    gridTemplateColumns: '200px 200px 200px',
    gridTemplateRows: '100px 100px',
    columnGap: '16px',
    rowGap: '8px',
    borderLeftWidth: '0px',
    borderTopWidth: '0px',
    paddingLeft: '0px',
    paddingTop: '0px',
    ...over,
  });
  const rect = { x: 10, y: 20, width: 632, height: 208 };

  it('positions the resolved tracks in the content box, relative to the frame', () => {
    const g = measureGridTracks(cs(), rect)!;
    expect(g.columns).toEqual([
      { start: 10, size: 200 },
      { start: 226, size: 200 },
      { start: 442, size: 200 },
    ]);
    expect(g.rows).toEqual([
      { start: 20, size: 100 },
      { start: 128, size: 100 },
    ]);
    expect(g.columnGap).toBe(16);
    expect(g.rowGap).toBe(8);
  });

  it('subtracts the border and padding at the start', () => {
    const g = measureGridTracks(
      cs({
        borderLeftWidth: '2px',
        paddingLeft: '24px',
        borderTopWidth: '1px',
        paddingTop: '16px',
      }),
      rect,
    )!;
    expect(g.columns[0]).toEqual({ start: 36, size: 200 });
    expect(g.rows[0]).toEqual({ start: 37, size: 100 });
  });

  it('accepts inline-grid, line names, fractional values and normal gap', () => {
    const g = measureGridTracks(
      cs({
        display: 'inline-grid',
        gridTemplateColumns: '[a] 33.5px [b] 66.25px',
        gridTemplateRows: 'none',
        columnGap: 'normal',
        rowGap: 'normal',
      }),
      rect,
    )!;
    expect(g.columns).toEqual([
      { start: 10, size: 33.5 },
      { start: 43.5, size: 66.25 },
    ]);
    expect(g.rows).toEqual([]);
    expect(g.columnGap).toBe(0);
  });

  it('a node that is not a grid returns undefined', () => {
    expect(measureGridTracks(cs({ display: 'flex' }), rect)).toBeUndefined();
    expect(measureGridTracks(cs({ display: 'block' }), rect)).toBeUndefined();
  });
});
