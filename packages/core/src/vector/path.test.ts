import { describe, expect, it } from 'vitest';
import {
  normalizePathData,
  parsePathData,
  pathBounds,
  serializePathData,
  transformPathData,
} from './path.js';
import type { PathCommand } from './path.js';

const near = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6);

describe('parsePathData: relative commands', () => {
  it('m, l, h, v accumulate from the current point', () => {
    expect(parsePathData('m10 10 l5 5 h10 v-5')).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 15, y: 15 },
      { type: 'L', x: 25, y: 15 },
      { type: 'L', x: 25, y: 10 },
    ]);
  });

  it('relative c and q', () => {
    expect(parsePathData('M10 10 c1 2 3 4 5 6 q1 1 2 2')).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'C', x1: 11, y1: 12, x2: 13, y2: 14, x: 15, y: 16 },
      { type: 'Q', x1: 16, y1: 17, x: 17, y: 18 },
    ]);
  });

  it('relative a ends at the summed point', () => {
    const cmds = parsePathData('M10 10 a5 5 0 0 1 10 0');
    const last = cmds[cmds.length - 1]!;
    expect(last.type).toBe('C');
    if (last.type === 'C') {
      near(last.x, 20);
      near(last.y, 10);
    }
  });
});

describe('parsePathData: S and T', () => {
  it('S reflects the second control of the previous C', () => {
    const cmds = parsePathData('M0 0 C1 1 2 2 3 3 S5 5 6 6');
    expect(cmds[2]).toEqual({ type: 'C', x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
  });

  it('S without a previous C uses the current point as the first control', () => {
    const cmds = parsePathData('M1 1 S5 5 6 6');
    expect(cmds[1]).toEqual({ type: 'C', x1: 1, y1: 1, x2: 5, y2: 5, x: 6, y: 6 });
  });

  it('T reflects the control of the previous Q', () => {
    const cmds = parsePathData('M0 0 Q2 4 4 0 T8 0');
    expect(cmds[2]).toEqual({ type: 'Q', x1: 6, y1: -4, x: 8, y: 0 });
  });

  it('relative s and t', () => {
    const cmds = parsePathData('M0 0 C1 1 2 2 3 3 s2 2 3 3');
    expect(cmds[2]).toEqual({ type: 'C', x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
    const q = parsePathData('M0 0 Q2 4 4 0 t4 0');
    expect(q[2]).toEqual({ type: 'Q', x1: 6, y1: -4, x: 8, y: 0 });
  });
});

describe('parsePathData: implicit commands', () => {
  it('pairs after M become L', () => {
    expect(parsePathData('M0 0 10 10 20 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 20, y: 0 },
    ]);
  });

  it('relative m: the first pair is M and the following ones are relative l', () => {
    expect(parsePathData('m5 5 10 10 5 -5')).toEqual([
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 15, y: 15 },
      { type: 'L', x: 20, y: 10 },
    ]);
  });

  it('implicit repetition of l and h', () => {
    expect(parsePathData('M0 0 l1 1 2 2 h1 1')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 1 },
      { type: 'L', x: 3, y: 3 },
      { type: 'L', x: 4, y: 3 },
      { type: 'L', x: 5, y: 3 },
    ]);
  });
});

describe('parsePathData: arcs', () => {
  const endOf = (d: string): { x: number; y: number } => {
    const cmds = parsePathData(d);
    const last = cmds[cmds.length - 1] as Extract<PathCommand, { type: 'C' }>;
    return { x: last.x, y: last.y };
  };

  it('glued flags (a1 1 0 01 5 5)', () => {
    const e = endOf('M0 0 a1 1 0 01 5 5');
    near(e.x, 5);
    near(e.y, 5);
  });

  it('separate and absolute flags (A1 1 0 1 1 5 5)', () => {
    const e = endOf('M0 0 A1 1 0 1 1 5 5');
    near(e.x, 5);
    near(e.y, 5);
  });

  it('glued flags equal the separate ones', () => {
    expect(parsePathData('M0 0 a1 1 0 01 5 5')).toEqual(parsePathData('M0 0 a1 1 0 0 1 5 5'));
  });
});

describe('parsePathData: Z', () => {
  it('relative command after Z starts from the start of the subpath', () => {
    const cmds = parsePathData('M10 10 l5 0 l0 5 z l3 3');
    expect(cmds[cmds.length - 1]).toEqual({ type: 'L', x: 13, y: 13 });
    expect(cmds[cmds.length - 2]).toEqual({ type: 'M', x: 10, y: 10 });
  });

  it('relative m after Z starts from the start of the subpath', () => {
    const cmds = parsePathData('M10 10 L20 10 Z m5 5');
    expect(cmds[cmds.length - 1]).toEqual({ type: 'M', x: 15, y: 15 });
  });
});

describe('parsePathData: errors', () => {
  it.each(['M', 'L 1 2', 'M 0 0 L 1', 'M0 0 X1 1', '10 10'])('"%s" throws', (d) => {
    expect(() => parsePathData(d)).toThrow();
  });
});

describe('serializePathData / normalizePathData', () => {
  it('round trip keeps the commands', () => {
    const cmds = parsePathData('M0 0 L10 0 C10 5 5 10 0 10 Q0 5 0 0 Z');
    expect(parsePathData(serializePathData(cmds))).toEqual(cmds);
  });

  it('normalizes relative to absolute', () => {
    expect(normalizePathData('m1 1 l2 2')).toBe(serializePathData(parsePathData('M1 1 L3 3')));
  });

  it('respects the precision', () => {
    expect(serializePathData([{ type: 'M', x: 1.23456, y: 2 }], 2)).toBe('M 1.23 2');
  });
});

describe('transformPathData and pathBounds', () => {
  it('translate and scale', () => {
    const d = transformPathData('M0 0 L10 10', { a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 });
    expect(parsePathData(d)).toEqual([
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 25, y: 25 },
    ]);
  });

  it('pathBounds of lines and of a curve (real extremes)', () => {
    expect(pathBounds('M10 20 L30 50')).toMatchObject({ x: 10, y: 20, width: 20, height: 30 });
    const b = pathBounds('M0 0 C0 10 10 10 10 0');
    near(b.x, 0);
    near(b.width, 10);
    near(b.height, 7.5);
  });

  it('pathBounds of relatives with h/v', () => {
    expect(pathBounds('m5 5 h10 v10')).toMatchObject({ x: 5, y: 5, width: 10, height: 10 });
  });
});
