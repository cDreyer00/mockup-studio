import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import {
  computeInsertIndex,
  distanceGuides,
  fitRect,
  isNoopReorder,
  marqueeHits,
  rectsIntersect,
  resizeRect,
  resolveClickTarget,
  resolveDoubleClick,
  resolveFlowInsert,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
} from './geometry';
import type { Rect } from './geometry';

describe('resolveClickTarget', () => {
  const { doc, frame, a, b, c, abs } = makeDoc();
  const c1 = c.children[0]!;

  it('no selection: direct child of the frame', () => {
    expect(resolveClickTarget(doc, c1.id, [], {})).toBe(c.id);
    expect(resolveClickTarget(doc, a.id, [], {})).toBe(a.id);
  });
  it('clicking the frame itself selects the frame', () => {
    expect(resolveClickTarget(doc, frame.id, [], {})).toBe(frame.id);
  });
  it('with a selected sibling, the click picks the sibling (selection level)', () => {
    expect(resolveClickTarget(doc, b.id, [a.id], {})).toBe(b.id);
    expect(resolveClickTarget(doc, c1.id, [a.id], {})).toBe(c.id);
    expect(resolveClickTarget(doc, abs.id, [b.id], {})).toBe(abs.id);
  });
  it('selected frame: clicking a descendant selects the direct child', () => {
    expect(resolveClickTarget(doc, c1.id, [frame.id], {})).toBe(c.id);
  });
  it('deep selects the target itself', () => {
    expect(resolveClickTarget(doc, c1.id, [], { deep: true })).toBe(c1.id);
  });
  it('locked nodes fall back to the selectable ancestor', () => {
    const locked = structuredClone(doc);
    const lc = locked.pages[0]!.frames[0]!.children[2]!;
    lc.locked = true;
    expect(resolveClickTarget(locked, lc.children[0]!.id, [], { deep: true })).toBe(
      locked.pages[0]!.frames[0]!.id,
    );
    expect(resolveClickTarget(locked, lc.children[0]!.id, [], {})).toBe(
      locked.pages[0]!.frames[0]!.id,
    );
  });
  it('locked frame: nothing selectable', () => {
    const locked = structuredClone(doc);
    locked.pages[0]!.frames[0]!.locked = true;
    expect(resolveClickTarget(locked, a.id, [], {})).toBeNull();
  });
});

describe('resolveDoubleClick', () => {
  const { doc, b, c } = makeDoc();
  const c1 = c.children[0]!;
  it('goes down one level', () => {
    expect(resolveDoubleClick(doc, c1.id, [c.id])).toEqual({ select: c1.id, edit: null });
  });
  it('selected text enters editing', () => {
    expect(resolveDoubleClick(doc, b.id, [b.id])).toEqual({ select: null, edit: b.id });
  });
  it('no selection in the chain: selects the direct child', () => {
    expect(resolveDoubleClick(doc, c1.id, [])).toEqual({ select: c.id, edit: null });
  });
});

describe('computeInsertIndex', () => {
  const col: Rect[] = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 0, y: 108, w: 100, h: 100 },
    { x: 0, y: 216, w: 100, h: 100 },
  ];
  it('column: before/after by the center', () => {
    expect(computeInsertIndex(col, { x: 50, y: 10 }, 'column')).toBe(0);
    expect(computeInsertIndex(col, { x: 50, y: 90 }, 'column')).toBe(1);
    expect(computeInsertIndex(col, { x: 50, y: 400 }, 'column')).toBe(3);
  });
  it('row', () => {
    const row = col.map((r, i) => ({ x: i * 108, y: 0, w: 100, h: 100 }));
    expect(computeInsertIndex(row, { x: 120, y: 50 }, 'row')).toBe(1);
    expect(computeInsertIndex(row, { x: 200, y: 50 }, 'row')).toBe(2);
  });
  it('ignores the moved nodes', () => {
    expect(computeInsertIndex(col, { x: 50, y: 250 }, 'column', [1])).toBe(2);
    expect(computeInsertIndex(col, { x: 50, y: 5 }, 'column', [0])).toBe(1);
  });
  it('no siblings: 0', () => {
    expect(computeInsertIndex([], { x: 0, y: 0 }, 'row')).toBe(0);
  });
  it('resolveFlowInsert converts to the post-removal index', () => {
    const sib = col.map((rect, index) => ({ index, rect }));
    // dragging item 0 to after item 1 (gap 2) → index 1 after removing 0
    const r = resolveFlowInsert(sib, { x: 50, y: 290 }, 'column', [0]);
    expect(r.gap).toBe(3);
    expect(r.moveIndex).toBe(2);
    expect(r.line?.y).toBe(200 + 8 + 108);
    const same = resolveFlowInsert(sib, { x: 50, y: 5 }, 'column', [1]);
    expect(isNoopReorder([1], same.moveIndex)).toBe(false);
    const stay = resolveFlowInsert(sib, { x: 50, y: 160 }, 'column', [2]);
    expect(isNoopReorder([2], stay.moveIndex)).toBe(true);
  });
});

describe('resizeRect', () => {
  const r: Rect = { x: 10, y: 10, w: 100, h: 50 };
  it('handle se / nw', () => {
    expect(resizeRect(r, 'se', 20, 10)).toEqual({ x: 10, y: 10, w: 120, h: 60 });
    expect(resizeRect(r, 'nw', 10, 5)).toEqual({ x: 20, y: 15, w: 90, h: 45 });
  });
  it('edge handles only move one axis', () => {
    expect(resizeRect(r, 'e', 30, 99)).toEqual({ x: 10, y: 10, w: 130, h: 50 });
    expect(resizeRect(r, 'n', 99, -10)).toEqual({ x: 10, y: 0, w: 100, h: 60 });
  });
  it('minimum size 1', () => {
    expect(resizeRect(r, 'se', -500, -500)).toMatchObject({ w: 1, h: 1 });
    expect(resizeRect(r, 'w', 500, 0)).toMatchObject({ x: 109, w: 1 });
  });
  it('fromCenter (Alt)', () => {
    expect(resizeRect(r, 'e', 10, 0, { fromCenter: true })).toEqual({ x: 0, y: 10, w: 120, h: 50 });
  });
  it('keepRatio (Shift)', () => {
    const k = resizeRect(r, 'se', 100, 0, { keepRatio: true });
    expect(k.w / k.h).toBeCloseTo(2);
    const e = resizeRect(r, 'e', 100, 0, { keepRatio: true });
    expect(e.w).toBe(200);
    expect(e.h).toBe(100);
    expect(e.y).toBe(-15);
  });
});

describe('marquee', () => {
  it('intersection', () => {
    const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });
  it('marqueeHits', () => {
    const items = [
      { id: 'a', rect: { x: 0, y: 0, w: 100, h: 100 } },
      { id: 'b', rect: { x: 200, y: 0, w: 100, h: 100 } },
    ];
    expect(marqueeHits(items, { x: 50, y: 50, w: 100, h: 10 })).toEqual(['a']);
    expect(marqueeHits(items, { x: 50, y: 50, w: 200, h: 10 })).toEqual(['a', 'b']);
  });
});

describe('distanceGuides', () => {
  it('horizontal gap', () => {
    const g = distanceGuides({ x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 20, w: 50, h: 50 });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ axis: 'h', value: 50, x1: 100, x2: 150, y1: 45 });
  });
  it('gaps on both axes (diagonal)', () => {
    const g = distanceGuides({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 40, w: 10, h: 10 });
    expect(g.map((x) => [x.axis, x.value]).sort()).toEqual([
      ['h', 20],
      ['v', 30],
    ]);
  });
  it('contained: 4 inner distances and scale', () => {
    const g = distanceGuides({ x: 0, y: 0, w: 200, h: 100 }, { x: 20, y: 10, w: 100, h: 50 }, 2);
    expect(g.map((x) => x.value)).toEqual([10, 40, 5, 20]);
  });
});

describe('viewport', () => {
  it('screen ↔ world are inverses', () => {
    const vp = { x: 30, y: -20, z: 2 };
    const p = { x: 123, y: 45 };
    expect(screenToWorld(vp, worldToScreen(vp, p))).toEqual(p);
  });
  it('zoom at the pointer keeps the point fixed', () => {
    const vp = { x: 10, y: 20, z: 1 };
    const next = zoomAtPoint(vp, 2, 100, 100);
    expect(worldToScreen(next, screenToWorld(vp, { x: 100, y: 100 }))).toEqual({ x: 100, y: 100 });
    expect(zoomAtPoint(vp, 999, 0, 0).z).toBe(16);
    expect(zoomAtPoint(vp, 0.0001, 0, 0).z).toBe(0.02);
  });
  it('fitRect centers and respects the maximum zoom', () => {
    const vp = fitRect({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 800 }, 60, 1);
    expect(vp.z).toBe(1);
    expect(vp.x).toBe(450);
    expect(vp.y).toBe(350);
    const big = fitRect({ x: 100, y: 0, w: 2000, h: 500 }, { w: 1000, h: 800 }, 60, 1);
    expect(big.z).toBeCloseTo(880 / 2000);
    expect(worldToScreen(big, { x: 1100, y: 250 })).toEqual({ x: 500, y: 400 });
  });
});
