import { describe, expect, it } from 'vitest';
import { booleanPathData } from './boolean.js';
import { flattenPath, pathBounds, rectPathData } from './path.js';

/** Área com sinal somada dos subpaths (shoelace); furos têm sentido oposto. */
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
  it('união de dois quadrados sobrepostos', () => {
    const d = booleanPathData('union', [a, b]);
    expect(area(d)).toBeCloseTo(175, 2);
    expect(pathBounds(d)).toMatchObject({ x: 0, y: 0, width: 15, height: 15 });
  });

  it('subtração: primeiro menos o segundo', () => {
    const d = booleanPathData('subtract', [a, b]);
    expect(area(d)).toBeCloseTo(75, 2);
    expect(pathBounds(d)).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('interseção', () => {
    const d = booleanPathData('intersect', [a, b]);
    expect(area(d)).toBeCloseTo(25, 2);
    expect(pathBounds(d)).toMatchObject({ x: 5, y: 5, width: 5, height: 5 });
  });

  it('exclusão (xor)', () => {
    const d = booleanPathData('exclude', [a, b]);
    expect(area(d)).toBeCloseTo(150, 2);
  });

  it('aplica a matriz de cada item', () => {
    const moved = { d: rectPathData(0, 0, 10, 10), matrix: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 } };
    expect(area(booleanPathData('intersect', [a, moved]))).toBeCloseTo(25, 2);
  });

  it('resultado vazio devolve string vazia', () => {
    const far = { d: rectPathData(100, 100, 5, 5) };
    expect(booleanPathData('intersect', [a, far])).toBe('');
  });

  it('achata curvas (círculo) com área próxima da real', () => {
    const circle = {
      d: 'M 10 0 C 15.5 0 20 4.5 20 10 C 20 15.5 15.5 20 10 20 C 4.5 20 0 15.5 0 10 C 0 4.5 4.5 0 10 0 Z',
    };
    const d = booleanPathData('union', [circle, circle]);
    expect(area(d)).toBeGreaterThan(300);
    expect(area(d)).toBeLessThanOrEqual(Math.PI * 100);
    expect(d).not.toMatch(/C/);
  });

  it('lança erro com menos de 2 itens', () => {
    expect(() => booleanPathData('union', [a])).toThrow(/pelo menos 2/);
  });
});
