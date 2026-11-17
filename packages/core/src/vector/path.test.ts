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

describe('parsePathData: comandos relativos', () => {
  it('m, l, h, v acumulam a partir do ponto corrente', () => {
    expect(parsePathData('m10 10 l5 5 h10 v-5')).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 15, y: 15 },
      { type: 'L', x: 25, y: 15 },
      { type: 'L', x: 25, y: 10 },
    ]);
  });

  it('c e q relativos', () => {
    expect(parsePathData('M10 10 c1 2 3 4 5 6 q1 1 2 2')).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'C', x1: 11, y1: 12, x2: 13, y2: 14, x: 15, y: 16 },
      { type: 'Q', x1: 16, y1: 17, x: 17, y: 18 },
    ]);
  });

  it('a relativo termina no ponto somado', () => {
    const cmds = parsePathData('M10 10 a5 5 0 0 1 10 0');
    const last = cmds[cmds.length - 1]!;
    expect(last.type).toBe('C');
    if (last.type === 'C') {
      near(last.x, 20);
      near(last.y, 10);
    }
  });
});

describe('parsePathData: S e T', () => {
  it('S reflete o segundo controle da C anterior', () => {
    const cmds = parsePathData('M0 0 C1 1 2 2 3 3 S5 5 6 6');
    expect(cmds[2]).toEqual({ type: 'C', x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
  });

  it('S sem C anterior usa o ponto corrente como primeiro controle', () => {
    const cmds = parsePathData('M1 1 S5 5 6 6');
    expect(cmds[1]).toEqual({ type: 'C', x1: 1, y1: 1, x2: 5, y2: 5, x: 6, y: 6 });
  });

  it('T reflete o controle da Q anterior', () => {
    const cmds = parsePathData('M0 0 Q2 4 4 0 T8 0');
    expect(cmds[2]).toEqual({ type: 'Q', x1: 6, y1: -4, x: 8, y: 0 });
  });

  it('s e t relativos', () => {
    const cmds = parsePathData('M0 0 C1 1 2 2 3 3 s2 2 3 3');
    expect(cmds[2]).toEqual({ type: 'C', x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
    const q = parsePathData('M0 0 Q2 4 4 0 t4 0');
    expect(q[2]).toEqual({ type: 'Q', x1: 6, y1: -4, x: 8, y: 0 });
  });
});

describe('parsePathData: comandos implícitos', () => {
  it('pares depois de M viram L', () => {
    expect(parsePathData('M0 0 10 10 20 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 20, y: 0 },
    ]);
  });

  it('m relativo: o primeiro par é M e os seguintes são l relativos', () => {
    expect(parsePathData('m5 5 10 10 5 -5')).toEqual([
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 15, y: 15 },
      { type: 'L', x: 20, y: 10 },
    ]);
  });

  it('repetição implícita de l e h', () => {
    expect(parsePathData('M0 0 l1 1 2 2 h1 1')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: 1 },
      { type: 'L', x: 3, y: 3 },
      { type: 'L', x: 4, y: 3 },
      { type: 'L', x: 5, y: 3 },
    ]);
  });
});

describe('parsePathData: arcos', () => {
  const endOf = (d: string): { x: number; y: number } => {
    const cmds = parsePathData(d);
    const last = cmds[cmds.length - 1] as Extract<PathCommand, { type: 'C' }>;
    return { x: last.x, y: last.y };
  };

  it('flags coladas (a1 1 0 01 5 5)', () => {
    const e = endOf('M0 0 a1 1 0 01 5 5');
    near(e.x, 5);
    near(e.y, 5);
  });

  it('flags separadas e absolutas (A1 1 0 1 1 5 5)', () => {
    const e = endOf('M0 0 A1 1 0 1 1 5 5');
    near(e.x, 5);
    near(e.y, 5);
  });

  it('flags coladas equivalem às separadas', () => {
    expect(parsePathData('M0 0 a1 1 0 01 5 5')).toEqual(parsePathData('M0 0 a1 1 0 0 1 5 5'));
  });
});

describe('parsePathData: Z', () => {
  it('comando relativo depois de Z parte do início do subpath', () => {
    const cmds = parsePathData('M10 10 l5 0 l0 5 z l3 3');
    expect(cmds[cmds.length - 1]).toEqual({ type: 'L', x: 13, y: 13 });
    expect(cmds[cmds.length - 2]).toEqual({ type: 'M', x: 10, y: 10 });
  });

  it('m relativo depois de Z parte do início do subpath', () => {
    const cmds = parsePathData('M10 10 L20 10 Z m5 5');
    expect(cmds[cmds.length - 1]).toEqual({ type: 'M', x: 15, y: 15 });
  });
});

describe('parsePathData: erros', () => {
  it.each(['M', 'L 1 2', 'M 0 0 L 1', 'M0 0 X1 1', '10 10'])('"%s" lança', (d) => {
    expect(() => parsePathData(d)).toThrow();
  });
});

describe('serializePathData / normalizePathData', () => {
  it('ida e volta mantém os comandos', () => {
    const cmds = parsePathData('M0 0 L10 0 C10 5 5 10 0 10 Q0 5 0 0 Z');
    expect(parsePathData(serializePathData(cmds))).toEqual(cmds);
  });

  it('normaliza relativos para absolutos', () => {
    expect(normalizePathData('m1 1 l2 2')).toBe(serializePathData(parsePathData('M1 1 L3 3')));
  });

  it('respeita a precisão', () => {
    expect(serializePathData([{ type: 'M', x: 1.23456, y: 2 }], 2)).toBe('M 1.23 2');
  });
});

describe('transformPathData e pathBounds', () => {
  it('translate e escala', () => {
    const d = transformPathData('M0 0 L10 10', { a: 2, b: 0, c: 0, d: 2, e: 5, f: 5 });
    expect(parsePathData(d)).toEqual([
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 25, y: 25 },
    ]);
  });

  it('pathBounds de retas e de curva (extremos reais)', () => {
    expect(pathBounds('M10 20 L30 50')).toMatchObject({ x: 10, y: 20, width: 20, height: 30 });
    const b = pathBounds('M0 0 C0 10 10 10 10 0');
    near(b.x, 0);
    near(b.width, 10);
    near(b.height, 7.5);
  });

  it('pathBounds de relativos com h/v', () => {
    expect(pathBounds('m5 5 h10 v10')).toMatchObject({ x: 5, y: 5, width: 10, height: 10 });
  });
});
