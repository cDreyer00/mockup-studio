import { describe, expect, it } from 'vitest';
import { buildShapeNode, isShapeTool, lineFlips, shapeDragRect, shapeKindOf } from './shapeTool';

describe('shapeTool', () => {
  it('reconhece as ferramentas de forma', () => {
    expect(isShapeTool('ellipse')).toBe(true);
    expect(isShapeTool('pen')).toBe(false);
  });

  it('Shift: elipse quadrada e linha em 45 graus', () => {
    const r = shapeDragRect('ellipse', { x: 10, y: 10 }, { x: 40, y: 20 }, true);
    expect(r.w).toBe(30);
    expect(r.h).toBe(30);
    const l = shapeDragRect('line', { x: 0, y: 0 }, { x: 30, y: 2 }, true);
    expect(l.h).toBeCloseTo(0);
    const free = shapeDragRect('ellipse', { x: 10, y: 10 }, { x: 40, y: 20 }, false);
    expect(free).toMatchObject({ x: 10, y: 10, w: 30, h: 10 });
  });

  it('polígono com Alt vira estrela', () => {
    expect(shapeKindOf('polygon', true)).toBe('star');
    expect(shapeKindOf('ellipse', true)).toBe('ellipse');
  });

  it('detecta linha desenhada para trás', () => {
    const rect = { x: 0, y: 0, w: 20, h: 10 };
    expect(lineFlips({ x: 20, y: 0 }, rect)).toEqual({ x: true, y: false });
    expect(lineFlips({ x: 0, y: 10 }, rect)).toEqual({ x: false, y: true });
  });

  it('constrói nó svg com vetor, absoluto ou no fluxo', () => {
    const abs = buildShapeNode(
      'ellipse',
      { x: 5, y: 6, w: 40, h: 20 },
      { x: 5, y: 6 },
      { flow: false, x: 5, y: 6 },
    );
    expect(abs.type).toBe('svg');
    expect(abs.vector?.paths).toHaveLength(1);
    expect(abs.style.position).toBe('absolute');
    const flow = buildShapeNode('polygon', null, { x: 0, y: 0 }, { flow: true, x: 0, y: 0 });
    expect(flow.style.display).toBe('block');
    expect(flow.style.position).toBeUndefined();
  });
});
