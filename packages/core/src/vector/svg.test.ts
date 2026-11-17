import { describe, expect, it } from 'vitest';
import { flattenPath, normalizePathData, pathBounds, parsePathData, serializePathData } from './path.js';
import {
  editVector,
  generateVectorSvg,
  isVectorEditable,
  setVectorPaint,
  svgToVector,
  vectorPreserveAspectRatio,
  vectorToSvg,
} from './svg.js';

const LUCIDE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

describe('svgToVector', () => {
  it('importa um ícone Lucide resolvendo estilos herdados e preservando raw', () => {
    const v = svgToVector(LUCIDE);
    expect(v.viewBox).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(v.paths).toHaveLength(1);
    const p = v.paths[0]!;
    expect(p.fill).toBe('none');
    expect(p.stroke).toBe('currentColor');
    expect(p.strokeWidth).toBe(2);
    expect(p.strokeLinecap).toBe('round');
    expect(p.strokeLinejoin).toBe('round');
    expect(pathBounds(p.d)).toMatchObject({ x: 4, y: 6, width: 16, height: 11 });
    expect(v.raw).toBeTruthy();
    expect(vectorToSvg(v)).toBe(v.raw);
  });

  it('regenera o markup com a nova cor após setVectorPaint e remove raw', () => {
    const v = svgToVector(LUCIDE);
    const painted = setVectorPaint(v, { stroke: '#ff0000' });
    expect(painted.raw).toBeUndefined();
    expect(vectorToSvg(painted)).toContain('#ff0000');
    expect(vectorToSvg(painted)).not.toContain('currentColor');
    const edited = editVector(v, { viewBox: { x: 0, y: 0, width: 48, height: 48 } });
    expect(edited.raw).toBeUndefined();
    expect(vectorToSvg(edited)).toContain('48');
  });

  it('extrai circle, rect e g com transform', () => {
    const v = svgToVector(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(10 20)" fill="red"><circle cx="10" cy="10" r="5"/><rect x="0" y="0" width="20" height="10" stroke="blue"/></g></svg>',
    );
    expect(isVectorEditable(v)).toBe(true);
    expect(v.paths).toHaveLength(2);
    expect(v.paths[0]!.fill).toBe('red');
    expect(pathBounds(v.paths[0]!.d)).toMatchObject({ x: 15, y: 25, width: 10, height: 10 });
    expect(pathBounds(v.paths[1]!.d)).toMatchObject({ x: 10, y: 20, width: 20, height: 10 });
    expect(v.paths[1]!.stroke).toBe('blue');
    expect(vectorToSvg(v)).toBe(v.raw);
  });

  it.each(['filter', 'mask', 'clipPath'])('SVG com %s não é simples: paths vazios e raw preservado', (tag) => {
    const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><${tag} id="x"><rect width="5" height="5"/></${tag}></defs><path d="M0 0 L10 10" ${tag === 'filter' ? 'filter' : tag === 'mask' ? 'mask' : 'clip-path'}="url(#x)"/></svg>`;
    const v = svgToVector(markup);
    expect(v.paths).toEqual([]);
    expect(v.raw).toBeTruthy();
    expect(isVectorEditable(v)).toBe(false);
    expect(vectorToSvg(v)).toBe(v.raw);
  });
});

describe('path data', () => {
  const samples = [
    'M10 10 h 20 v 20 h -20 z',
    'm 5 5 l 10 0 l 0 10 z m 20 0 l 5 5 l -5 5 z',
    'M0 0 C 10 0 20 10 20 20 s -10 10 -20 0',
    'M0 0 Q 10 20 20 0 t 20 0',
    'M0 10 A 10 10 0 0 1 20 10 A 10 10 0 0 1 0 10 Z',
    'M0 0 H 10 V 10 H 0 Z',
  ];

  it.each(samples)('ida e volta mantém a geometria: %s', (d) => {
    const again = serializePathData(parsePathData(d));
    const b1 = pathBounds(d);
    const b2 = pathBounds(again);
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(b2[k]).toBeCloseTo(b1[k], 2);
    const p1 = flattenPath(d).flatMap((p) => p.points);
    const p2 = flattenPath(again).flatMap((p) => p.points);
    expect(p2).toHaveLength(p1.length);
    p1.forEach((pt, i) => {
      expect(p2[i]![0]).toBeCloseTo(pt[0], 2);
      expect(p2[i]![1]).toBeCloseTo(pt[1], 2);
    });
    expect(normalizePathData(again)).toBe(again);
  });

  it('H/V viram L e arcos viram cúbicas', () => {
    expect(serializePathData(parsePathData('M0 0 H 10 V 5'))).not.toMatch(/[HV]/);
    expect(serializePathData(parsePathData('M0 10 A 10 10 0 0 1 20 10'))).toMatch(/C/);
  });
});

describe('preserveAspectRatio', () => {
  const base = { viewBox: { x: 0, y: 0, width: 10, height: 10 }, paths: [{ id: 'p1', d: 'M0 0L1 1' }] };

  it('markup gerado usa "none" por padrão e respeita attrs', () => {
    expect(generateVectorSvg(base)).toContain('preserveAspectRatio="none"');
    const m = generateVectorSvg({ ...base, attrs: { preserveAspectRatio: 'xMinYMin slice' } });
    expect(m).toContain('preserveAspectRatio="xMinYMin slice"');
    expect(m.match(/preserveAspectRatio/g)).toHaveLength(1);
  });

  it('importação grava xMidYMid meet quando ausente e preserva o existente', () => {
    expect(svgToVector(LUCIDE).attrs?.preserveAspectRatio).toBe('xMidYMid meet');
    const v = svgToVector('<svg viewBox="0 0 4 4" preserveAspectRatio="none"><path d="M0 0L1 1"/></svg>');
    expect(v.attrs?.preserveAspectRatio).toBe('none');
  });

  it('um ícone importado regenerado mantém meet', () => {
    const v = editVector(svgToVector(LUCIDE), {});
    expect(vectorToSvg(v)).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  it('vectorPreserveAspectRatio', () => {
    expect(vectorPreserveAspectRatio(base)).toBe('none');
    expect(vectorPreserveAspectRatio({ ...base, attrs: { preserveAspectRatio: 'xMinYMax slice' } })).toEqual({
      align: 'xMinYMax',
      slice: true,
    });
    expect(vectorPreserveAspectRatio(svgToVector(LUCIDE))).toEqual({ align: 'xMidYMid', slice: false });
    expect(
      vectorPreserveAspectRatio(svgToVector('<svg viewBox="0 0 4 4" preserveAspectRatio="none"><path d="M0 0L1 1"/></svg>')),
    ).toBe('none');
    // raw tem prioridade sobre attrs
    expect(
      vectorPreserveAspectRatio({
        ...base,
        raw: '<svg viewBox="0 0 4 4" preserveAspectRatio="none"/>',
        attrs: { preserveAspectRatio: 'xMidYMid meet' },
      }),
    ).toBe('none');
  });
});
