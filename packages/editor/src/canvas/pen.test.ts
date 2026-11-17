import { describe, expect, it } from 'vitest';
import {
  PEN_EMPTY,
  addAnchor,
  canFinish,
  closePen,
  constrainAngle,
  dragLastHandles,
  isNearFirst,
  previewSegmentD,
  removeLastAnchor,
} from './pen';

const build = (pts: [number, number][]) =>
  pts.reduce((s, [x, y]) => addAnchor(s, { x, y }), PEN_EMPTY);

describe('pen', () => {
  it('appends anchors and ignores points that are too close', () => {
    let s = build([
      [0, 0],
      [10, 0],
    ]);
    expect(s.anchors).toHaveLength(2);
    expect(addAnchor(s, { x: 10.5, y: 0 }, { minGap: 2 })).toBe(s);
    s = addAnchor(s, { x: 20, y: 5 }, { minGap: 2 });
    expect(s.anchors).toHaveLength(3);
  });

  it('Shift constrains to multiples of 45 degrees', () => {
    const p = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 });
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(Math.hypot(10, 1));
    const s = addAnchor(build([[0, 0]]), { x: 10, y: 9 }, { shift: true });
    expect(s.anchors[1]!.x).toBeCloseTo(s.anchors[1]!.y);
  });

  it('dragging creates symmetric handles; Alt breaks the symmetry', () => {
    const s = dragLastHandles(
      build([
        [0, 0],
        [10, 10],
      ]),
      { x: 15, y: 10 },
    );
    expect(s.anchors[1]!.out).toEqual({ x: 15, y: 10 });
    expect(s.anchors[1]!.in).toEqual({ x: 5, y: 10 });
    const alt = dragLastHandles(s, { x: 20, y: 10 }, true);
    expect(alt.anchors[1]!.out).toEqual({ x: 20, y: 10 });
    expect(alt.anchors[1]!.in).toEqual({ x: 5, y: 10 });
  });

  it('closes only when clicking near the first anchor with 2 or more points', () => {
    expect(isNearFirst(build([[0, 0]]), { x: 0, y: 0 }, 5)).toBe(false);
    const s = build([
      [0, 0],
      [50, 0],
      [50, 50],
    ]);
    expect(isNearFirst(s, { x: 3, y: 2 }, 5)).toBe(true);
    expect(isNearFirst(s, { x: 30, y: 2 }, 5)).toBe(false);
    const c = closePen(s);
    expect(c.closed).toBe(true);
    expect(addAnchor(c, { x: 99, y: 99 })).toBe(c);
    expect(isNearFirst(c, { x: 0, y: 0 }, 5)).toBe(false);
  });

  it('canFinish requires 2 anchors; Backspace removes the last', () => {
    expect(canFinish(build([[0, 0]]))).toBe(false);
    const s = build([
      [0, 0],
      [5, 5],
    ]);
    expect(canFinish(s)).toBe(true);
    expect(removeLastAnchor(s).anchors).toHaveLength(1);
    expect(removeLastAnchor(PEN_EMPTY)).toBe(PEN_EMPTY);
  });

  it('preview: line, curve with handle and closing', () => {
    expect(previewSegmentD(PEN_EMPTY, { x: 1, y: 1 })).toBe('');
    const s = build([
      [0, 0],
      [10, 0],
    ]);
    expect(previewSegmentD(s, { x: 20, y: 5 })).toBe('M 10 0 L 20 5');
    const curved = dragLastHandles(s, { x: 14, y: 0 });
    expect(previewSegmentD(curved, { x: 20, y: 5 })).toBe('M 10 0 C 14 0 20 5 20 5');
    expect(previewSegmentD(s, { x: 20, y: 5 }, true)).toBe('M 10 0 L 0 0');
  });
});
