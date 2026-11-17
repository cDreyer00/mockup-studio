import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import { createDocument, createNodeFromTag, findNode } from '../document.js';
import { parseDocument, serializeDocument } from '../schema.js';
import type { Document, Node } from '../types.js';
import { buildBooleanOps, buildFlattenOps, buildSetVectorOps, nodeBoxInParent } from './build.js';
import { fitVectorToContent } from './fit.js';
import { pathBounds } from './path.js';
import { createShapeVector, createVectorNode } from './shapes.js';
import { setVectorPaint, vectorToSvg } from './svg.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

const px = (n: number): string => `${n}px`;

/** Frame com [a (0,0 10x10), div, b (5,5 10x10, vermelho)]. */
function fixture(): { doc: Document; frame: Node } {
  const doc = createDocument('Teste', { id: 'doc_test0001' });
  const frame = createNodeFromTag('div', { isRoot: true, position: { x: 0, y: 0 } });
  frame.id = 'fr_aaaaaaaa';
  const a = createVectorNode(createShapeVector({ kind: 'rect', width: 10, height: 10 }), {
    id: 'sv_aaaaaaa1',
    name: 'A',
    style: { position: 'absolute', left: px(0), top: px(0), width: px(10), height: px(10), opacity: '0.5' },
  });
  const mid = createNodeFromTag('div', {});
  mid.id = 'el_mmmmmmm1';
  const b = createVectorNode(
    createShapeVector({ kind: 'rect', width: 10, height: 10 }, { fill: '#ff0000' }),
    {
      id: 'sv_bbbbbbb2',
      name: 'B',
      style: { position: 'absolute', left: px(5), top: px(5), width: px(10), height: px(10) },
    },
  );
  frame.children = [a, mid, b];
  doc.pages[0]!.frames.push(frame);
  return { doc, frame };
}

describe('nodeBoxInParent', () => {
  it('lê left/top/width/height em px', () => {
    const { doc } = fixture();
    expect(nodeBoxInParent(findNode(doc, 'sv_bbbbbbb2')!.node)).toEqual({
      x: 5,
      y: 5,
      width: 10,
      height: 10,
    });
  });
  it('usa o viewBox quando não há width/height', () => {
    const n = createVectorNode(createShapeVector({ kind: 'rect', width: 30, height: 20 }));
    expect(nodeBoxInParent(n)).toEqual({ x: 0, y: 0, width: 30, height: 20 });
  });
  it('null sem px nem viewBox', () => {
    const n = createNodeFromTag('div', {});
    n.style.width = '50%';
    expect(nodeBoxInParent(n)).toBeNull();
  });
});

describe('buildBooleanOps', () => {
  it('une dois svgs irmãos em um nó novo no índice do primeiro, com undo', () => {
    const { doc, frame } = fixture();
    const { ops, nodeId } = buildBooleanOps(doc, ['sv_bbbbbbb2', 'sv_aaaaaaa1'], 'union', {
      name: 'União',
    });
    const r = applyOps(doc, ops);
    const kids = findNode(r.doc, frame.id)!.node.children;
    expect(kids.map((k) => k.id)).toEqual([nodeId, 'el_mmmmmmm1']);
    const n = kids[0]!;
    expect(n.name).toBe('União');
    expect(n.style).toMatchObject({
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '15px',
      height: '15px',
      opacity: '0.5',
    });
    expect(n.vector!.viewBox).toEqual({ x: 0, y: 0, width: 15, height: 15 });
    expect(n.vector!.paths).toHaveLength(1);
    expect(n.vector!.paths[0]!.fill).toBe('#d9d9d9'); // tinta do nó de baixo
    expect(pathBounds(n.vector!.paths[0]!.d)).toMatchObject({ x: 0, y: 0, width: 15, height: 15 });
    expect(n.svg).toBe(vectorToSvg(n.vector!));
    expect(findNode(r.doc, 'sv_aaaaaaa1')).toBeUndefined();
    expect(findNode(r.doc, 'sv_bbbbbbb2')).toBeUndefined();

    const back = applyOps(r.doc, r.inverse);
    expect(strip(back.doc)).toStrictEqual(strip(doc));
  });

  it('o resultado fica em coordenadas do pai', () => {
    const { doc, frame } = fixture();
    const { ops } = buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2'], 'intersect');
    const n = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!;
    expect(n.style).toMatchObject({ left: '5px', top: '5px', width: '5px', height: '5px' });
  });

  it('respeita a escala caixa x viewBox', () => {
    const { doc, frame } = fixture();
    const a = findNode(doc, 'sv_aaaaaaa1')!.node;
    a.style.width = '20px';
    a.style.height = '20px';
    const { ops } = buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2'], 'union');
    const n = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!;
    expect(n.style).toMatchObject({ width: '20px', height: '20px' });
  });

  it('erros claros', () => {
    const { doc } = fixture();
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1'], 'union')).toThrow(/pelo menos 2/);
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'el_mmmmmmm1'], 'union')).toThrow(
      /não é um svg/,
    );
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'xx'], 'union')).toThrow(/não encontrado/);
    const o = createVectorNode(createShapeVector({ kind: 'rect', width: 4, height: 4 }), {
      id: 'sv_ccccccc3',
    });
    const inner = createNodeFromTag('div', { children: [o] });
    inner.id = 'el_iiiiiii1';
    findNode(doc, 'fr_aaaaaaaa')!.node.children.push(inner);
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_ccccccc3'], 'union')).toThrow(/irmãos/);
  });

  it('resultado vazio lança erro', () => {
    const { doc } = fixture();
    findNode(doc, 'sv_bbbbbbb2')!.node.style.left = '50px';
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2'], 'intersect')).toThrow(/vazio/);
  });
});

describe('buildFlattenOps', () => {
  it('um nó: junta os paths num só via setVector', () => {
    const { doc } = fixture();
    const a = findNode(doc, 'sv_aaaaaaa1')!.node;
    a.vector!.paths.push({ id: 'p2', d: 'M 20 20 L 30 30 L 20 30 Z', fill: '#000' });
    const { ops, nodeId } = buildFlattenOps(doc, ['sv_aaaaaaa1']);
    expect(nodeId).toBe('sv_aaaaaaa1');
    expect(ops[0]!.type).toBe('setVector');
    const r = applyOps(doc, ops);
    const n = findNode(r.doc, 'sv_aaaaaaa1')!.node;
    expect(n.vector!.paths).toHaveLength(1);
    expect(n.vector!.paths[0]!.fill).toBe('#d9d9d9');
    expect((n.vector!.paths[0]!.d.match(/M/g) ?? []).length).toBe(2);
    expect(n.svg).toBe(vectorToSvg(n.vector!));
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
  });

  it('dois nós: novo nó com os paths de ambos, cada um com sua tinta', () => {
    const { doc, frame } = fixture();
    const { ops, nodeId } = buildFlattenOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2']);
    const r = applyOps(doc, ops);
    const kids = findNode(r.doc, frame.id)!.node.children;
    expect(kids.map((k) => k.id)).toEqual([nodeId, 'el_mmmmmmm1']);
    expect(kids[0]!.vector!.paths.map((p) => p.fill)).toEqual(['#d9d9d9', '#ff0000']);
    expect(kids[0]!.style).toMatchObject({ width: '15px', height: '15px' });
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
  });
});

describe('fitVectorToContent', () => {
  it('ajusta o viewBox ao desenho mantendo-o parado na tela', () => {
    const v = {
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      paths: [{ id: 'p1', d: 'M 20 30 L 60 30 L 60 50 Z', fill: '#000' }],
    };
    const r = fitVectorToContent(v, { x: 200, y: 100, width: 200, height: 200 }); // escala 2
    expect(r.vector.viewBox).toEqual({ x: 20, y: 30, width: 40, height: 20 });
    expect(r.box).toEqual({ x: 240, y: 160, width: 80, height: 40 });
    expect(r.vector.raw).toBeUndefined();
  });

  it('padding padrão é metade do maior traço', () => {
    const v = {
      viewBox: { x: 0, y: 0, width: 10, height: 10 },
      paths: [{ id: 'p1', d: 'M 2 2 L 8 8', stroke: '#000', strokeWidth: 4 }],
    };
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(fitVectorToContent(v, box).vector.viewBox).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    expect(fitVectorToContent(v, box, { padding: 0 }).vector.viewBox).toEqual({
      x: 2,
      y: 2,
      width: 6,
      height: 6,
    });
  });

  it('sem paths devolve igual', () => {
    const v = { viewBox: { x: 0, y: 0, width: 10, height: 10 }, paths: [] };
    const box = { x: 1, y: 2, width: 3, height: 4 };
    expect(fitVectorToContent(v, box)).toEqual({ vector: v, box });
  });
});

describe('op setVector', () => {
  it('define vector e svg; o inverso restaura; null remove', () => {
    const { doc } = fixture();
    const v = setVectorPaint(createShapeVector({ kind: 'ellipse', width: 8, height: 8 }), {
      fill: '#00ff00',
    });
    const r = applyOps(doc, buildSetVectorOps('sv_aaaaaaa1', v));
    const n = findNode(r.doc, 'sv_aaaaaaa1')!.node;
    expect(n.vector).toEqual(v);
    expect(n.svg).toBe(vectorToSvg(v));
    expect(n.svg).toContain('#00ff00');
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));

    const rm = applyOps(r.doc, buildSetVectorOps('sv_aaaaaaa1', null));
    expect(findNode(rm.doc, 'sv_aaaaaaa1')!.node.vector).toBeUndefined();
    expect(strip(applyOps(rm.doc, rm.inverse).doc)).toStrictEqual(strip(r.doc));
  });

  it('serialize/parse preservam vector', () => {
    const { doc } = fixture();
    const back = parseDocument(serializeDocument(doc));
    expect(findNode(back, 'sv_bbbbbbb2')!.node.vector).toEqual(
      findNode(doc, 'sv_bbbbbbb2')!.node.vector,
    );
  });

  it('setAttrs num nó com vector regenera o svg', () => {
    const { doc } = fixture();
    const r = applyOps(doc, [
      { type: 'setAttrs', changes: [{ nodeId: 'sv_aaaaaaa1', attrs: { 'aria-label': 'ícone' } }] },
    ]);
    const n = findNode(r.doc, 'sv_aaaaaaa1')!.node;
    expect(n.svg).toBe(vectorToSvg(n.vector!));
  });
});
