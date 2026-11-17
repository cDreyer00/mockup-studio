import { describe, expect, it } from 'vitest';
import type { Vector } from '@mockup/core';
import {
  deleteAnchors,
  flatSubpaths,
  hitSegment,
  insertAnchor,
  isSmooth,
  loadModel,
  modelToVector,
  moveAnchors,
  moveHandle,
  toggleSmooth,
} from './vectorEdit';

const vec: Vector = {
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
  paths: [{ id: 'p1', d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z', fill: '#fff' }],
  raw: '<svg/>',
};

describe('vectorEdit', () => {
  it('carrega âncoras e regenera o d, removendo raw', () => {
    const m = loadModel(vec);
    expect(flatSubpaths(m)[0]!.anchors).toHaveLength(4);
    expect(flatSubpaths(m)[0]!.closed).toBe(true);
    const out = modelToVector(vec, m);
    expect(out.raw).toBeUndefined();
    expect(out.paths[0]!.fill).toBe('#fff');
  });

  it('move âncoras', () => {
    const m = moveAnchors(loadModel(vec), [{ s: 0, i: 1 }], 5, -5);
    const a = flatSubpaths(m)[0]!.anchors;
    expect(a[1]).toMatchObject({ x: 105, y: -5 });
    expect(a[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('mover alça acompanha a oposta; Alt quebra', () => {
    const base = toggleSmooth(loadModel(vec), { s: 0, i: 1 });
    expect(isSmooth(flatSubpaths(base)[0]!.anchors[1]!)).toBe(true);
    const sym = moveHandle(base, { s: 0, i: 1 }, 'out', { x: 100, y: 30 });
    expect(flatSubpaths(sym)[0]!.anchors[1]!.in!.y).toBeCloseTo(-30);
    const alt = moveHandle(base, { s: 0, i: 1 }, 'out', { x: 100, y: 30 }, true);
    expect(flatSubpaths(alt)[0]!.anchors[1]!.in).toEqual(flatSubpaths(base)[0]!.anchors[1]!.in);
  });

  it('apaga âncoras e o subpath some com menos de 2', () => {
    const m = deleteAnchors(loadModel(vec), [{ s: 0, i: 0 }]);
    expect(flatSubpaths(m)[0]!.anchors).toHaveLength(3);
    const none = deleteAnchors(m, [
      { s: 0, i: 0 },
      { s: 0, i: 1 },
    ]);
    expect(none.paths).toHaveLength(0);
  });

  it('acha o segmento e insere âncora mantendo a forma', () => {
    const m = loadModel(vec);
    const hit = hitSegment(m, { x: 50, y: 2 }, 5)!;
    expect(hit).toMatchObject({ s: 0, seg: 0 });
    expect(hit.t).toBeCloseTo(0.5, 1);
    expect(hitSegment(m, { x: 50, y: 50 }, 5)).toBeNull();
    const a = flatSubpaths(insertAnchor(m, hit.s, hit.seg, hit.t))[0]!.anchors;
    expect(a).toHaveLength(5);
    expect(a[1]!.x).toBeCloseTo(50, 0);
    expect(a[1]!.y).toBeCloseTo(0);
  });
});
