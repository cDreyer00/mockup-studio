import { describe, expect, it } from 'vitest';
import { booleanPathData } from './boolean.js';
import { flattenPath, pathBounds, rectPathData } from './path.js';

/** Signed area summed over the subpaths (shoelace); holes have the opposite direction. */
function area(d: string): number {
  let total = 0;
  for (const poly of flattenPath(d)) {
    const p = poly.points;
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i]!;
      const [x2, y2] = p[(i + 1) % p.length]!;
      s += x1 * y2 - x2 * y1;
    }
    total += s / 2;
  }
  return Math.abs(total);
}

const a = { d: rectPathData(0, 0, 10, 10) };
const b = { d: rectPathData(5, 5, 10, 10) };

describe('booleanPathData', () => {
  it('union of two overlapping squares', () => {
    const d = booleanPathData('union', [a, b]);
    expect(area(d)).toBeCloseTo(175, 2);
    expect(pathBounds(d)).toMatchObject({ x: 0, y: 0, width: 15, height: 15 });
  });

  it('subtraction: first minus second', () => {
    const d = booleanPathData('subtract', [a, b]);
    expect(area(d)).toBeCloseTo(75, 2);
    expect(pathBounds(d)).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('intersection', () => {
    const d = booleanPathData('intersect', [a, b]);
    expect(area(d)).toBeCloseTo(25, 2);
    expect(pathBounds(d)).toMatchObject({ x: 5, y: 5, width: 5, height: 5 });
  });

  it('exclusion (xor)', () => {
    const d = booleanPathData('exclude', [a, b]);
    expect(area(d)).toBeCloseTo(150, 2);
  });

  it('applies the matrix of each item', () => {
    const moved = { d: rectPathData(0, 0, 10, 10), matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 } };
    expect(area(booleanPathData('intersect', [a, moved]))).toBeCloseTo(25, 2);
  });

  it('empty result returns an empty string', () => {
    const far = { d: rectPathData(100, 100, 5, 5) };
    expect(booleanPathData('intersect', [a, far])).toBe('');
  });

  it('flattens curves (circle) with area close to the real one', () => {
    const circle = {
      d: 'M 10 0 C 15.5 0 20 4.5 20 10 C 20 15.5 15.5 20 10 20 C 4.5 20 0 15.5 0 10 C 0 4.5 4.5 0 10 0 Z',
    };
    const d = booleanPathData('union', [circle, circle]);
    expect(area(d)).toBeGreaterThan(300);
    expect(area(d)).toBeLessThanOrEqual(Math.PI * 100);
    expect(d).not.toMatch(/C/);
  });

  it('throws with fewer than 2 items', () => {
    expect(() => booleanPathData('union', [a])).toThrow(/at least 2/);
  });
});
