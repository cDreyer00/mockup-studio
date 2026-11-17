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

/** Frame with [a (0,0 10x10), div, b (5,5 10x10, red)]. */
function fixture(): { doc: Document; frame: Node } {
  const doc = createDocument('Test', { id: 'doc_test0001' });
  const frame = createNodeFromTag('div', { isRoot: true, position: { x: 0, y: 0 } });
  frame.id = 'fr_aaaaaaaa';
  const a = createVectorNode(createShapeVector({ kind: 'rect', width: 10, height: 10 }), {
    id: 'sv_aaaaaaa1',
    name: 'A',
    style: {
      position: 'absolute',
      left: px(0),
      top: px(0),
      width: px(10),
      height: px(10),
      opacity: '0.5',
    },
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
  it('reads left/top/width/height in px', () => {
    const { doc } = fixture();
    expect(nodeBoxInParent(findNode(doc, 'sv_bbbbbbb2')!.node)).toEqual({
      x: 5,
      y: 5,
      width: 10,
      height: 10,
    });
  });
  it('uses the viewBox when there is no width/height', () => {
    const n = createVectorNode(createShapeVector({ kind: 'rect', width: 30, height: 20 }));
    expect(nodeBoxInParent(n)).toEqual({ x: 0, y: 0, width: 30, height: 20 });
  });
  it('null without px or viewBox', () => {
    const n = createNodeFromTag('div', {});
    n.style.width = '50%';
    expect(nodeBoxInParent(n)).toBeNull();
  });
});

describe('buildBooleanOps', () => {
  it('merges two sibling svgs into a new node at the index of the first, with undo', () => {
    const { doc, frame } = fixture();
    const { ops, nodeId } = buildBooleanOps(doc, ['sv_bbbbbbb2', 'sv_aaaaaaa1'], 'union', {
      name: 'Union',
    });
    const r = applyOps(doc, ops);
    const kids = findNode(r.doc, frame.id)!.node.children;
    expect(kids.map((k) => k.id)).toEqual([nodeId, 'el_mmmmmmm1']);
    const n = kids[0]!;
    expect(n.name).toBe('Union');
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
    expect(n.vector!.paths[0]!.fill).toBe('#d9d9d9'); // paint of the bottom node
    expect(pathBounds(n.vector!.paths[0]!.d)).toMatchObject({ x: 0, y: 0, width: 15, height: 15 });
    expect(n.svg).toBe(vectorToSvg(n.vector!));
    expect(findNode(r.doc, 'sv_aaaaaaa1')).toBeUndefined();
    expect(findNode(r.doc, 'sv_bbbbbbb2')).toBeUndefined();

    const back = applyOps(r.doc, r.inverse);
    expect(strip(back.doc)).toStrictEqual(strip(doc));
  });

  it('the result is in parent coordinates', () => {
    const { doc, frame } = fixture();
    const { ops } = buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2'], 'intersect');
    const n = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!;
    expect(n.style).toMatchObject({ left: '5px', top: '5px', width: '5px', height: '5px' });
  });

  it('respects the box x viewBox scale', () => {
    const { doc, frame } = fixture();
    const a = findNode(doc, 'sv_aaaaaaa1')!.node;
    a.style.width = '20px';
    a.style.height = '20px';
    const { ops } = buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2'], 'union');
    const n = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!;
    expect(n.style).toMatchObject({ width: '20px', height: '20px' });
  });

  it('clear errors', () => {
    const { doc } = fixture();
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1'], 'union')).toThrow(/at least 2/);
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'el_mmmmmmm1'], 'union')).toThrow(
      /is not an svg/,
    );
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'xx'], 'union')).toThrow(/not found/);
    const o = createVectorNode(createShapeVector({ kind: 'rect', width: 4, height: 4 }), {
      id: 'sv_ccccccc3',
    });
    const inner = createNodeFromTag('div', { children: [o] });
    inner.id = 'el_iiiiiii1';
    findNode(doc, 'fr_aaaaaaaa')!.node.children.push(inner);
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_ccccccc3'], 'union')).toThrow(/siblings/);
  });

  it('empty result throws an error', () => {
    const { doc } = fixture();
    findNode(doc, 'sv_bbbbbbb2')!.node.style.left = '50px';
    expect(() => buildBooleanOps(doc, ['sv_aaaaaaa1', 'sv_bbbbbbb2'], 'intersect')).toThrow(
      /empty/,
    );
  });
});

describe('buildFlattenOps', () => {
  it('one node: merges the paths into one via setVector', () => {
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

  it('two nodes: new node with the paths of both, each with its own paint', () => {
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

describe('position, stroke scale and preserveAspectRatio', () => {
  /** Two 24x24 icons (stroke 2, dashed "2 1") displayed at 48px, side by side. */
  function icons(extra: Record<string, string> = {}): { doc: Document; frame: Node } {
    const doc = createDocument('Test', { id: 'doc_test0002' });
    const frame = createNodeFromTag('div', { isRoot: true, position: { x: 0, y: 0 } });
    frame.id = 'fr_bbbbbbbb';
    const mk = (id: string, left: number): Node =>
      createVectorNode(
        {
          viewBox: { x: 0, y: 0, width: 24, height: 24 },
          paths: [
            {
              id: 'p1',
              d: 'M 4 4 L 20 4 L 20 20 L 4 20 Z',
              fill: 'none',
              stroke: '#111',
              strokeWidth: 2,
              strokeDasharray: '2 1',
            },
          ],
        },
        {
          id,
          style: {
            position: 'absolute',
            left: px(left),
            top: '0px',
            width: '48px',
            height: '48px',
            ...extra,
          },
        },
      );
    frame.children = [mk('sv_icon0001', 0), mk('sv_icon0002', 20)];
    doc.pages[0]!.frames.push(frame);
    return { doc, frame };
  }

  it('flatten scales strokeWidth and strokeDasharray by the matrix', () => {
    const { doc, frame } = icons();
    const { ops } = buildFlattenOps(doc, ['sv_icon0001', 'sv_icon0002']);
    const n = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!;
    expect(n.vector!.paths[0]!.strokeWidth).toBe(4);
    expect(n.vector!.paths[0]!.strokeDasharray).toBe('4 2');
    // the pad uses the scaled stroke: drawing box (8..40) + 2 on each side
    expect(n.style).toMatchObject({ left: '6px', top: '6px' });
  });

  it('boolean scales the paint of the first path', () => {
    const { doc, frame } = icons();
    const { ops } = buildBooleanOps(doc, ['sv_icon0001', 'sv_icon0002'], 'union');
    const p = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!.vector!.paths[0]!;
    expect(p.strokeWidth).toBe(4);
    expect(p.strokeDasharray).toBe('4 2');
  });

  it('a flattened node on its own node does not scale the stroke', () => {
    const { doc } = icons();
    const { ops } = buildFlattenOps(doc, ['sv_icon0001']);
    const r = applyOps(doc, ops);
    expect(findNode(r.doc, 'sv_icon0001')!.node.vector!.paths[0]!.strokeWidth).toBe(2);
  });

  it('in-flow node without a measured box throws a clear error', () => {
    const { doc } = icons();
    const n = findNode(doc, 'sv_icon0002')!.node;
    delete n.style['position'];
    expect(() => buildBooleanOps(doc, ['sv_icon0001', 'sv_icon0002'], 'union')).toThrow(
      /in flow.*before the boolean operation/,
    );
    expect(() => buildFlattenOps(doc, ['sv_icon0001', 'sv_icon0002'])).toThrow(
      /in flow.*before flattening/,
    );
  });

  it('in-flow node with a measured box uses the box and sets the parent to relative', () => {
    const { doc, frame } = icons();
    const n = findNode(doc, 'sv_icon0002')!.node;
    delete n.style['position'];
    delete n.style['left'];
    const { ops } = buildFlattenOps(doc, ['sv_icon0001', 'sv_icon0002'], {
      boxes: { sv_icon0002: { x: 100, y: 50, width: 24, height: 24 } },
    });
    const r = applyOps(doc, ops);
    const out = findNode(r.doc, frame.id)!.node;
    expect(out.style['position']).toBe('relative');
    const res = out.children[0]!;
    expect(res.style).toMatchObject({
      position: 'absolute',
      left: '6px',
      top: '6px',
      width: '116px',
    });
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
  });

  it('page root: uses node.position and not left/top/position', () => {
    const doc = createDocument('Test', { id: 'doc_test0003' });
    const mk = (id: string, x: number): Node => {
      const n = createVectorNode(createShapeVector({ kind: 'rect', width: 10, height: 10 }), {
        id,
        style: { width: '10px', height: '10px' },
      });
      n.position = { x, y: 7 };
      return n;
    };
    doc.pages[0]!.frames.push(mk('sv_root0001', 100), mk('sv_root0002', 105));
    const { ops, nodeId } = buildBooleanOps(doc, ['sv_root0001', 'sv_root0002'], 'union');
    const n = findNode(applyOps(doc, ops).doc, nodeId)!.node;
    expect(n.position).toEqual({ x: 100, y: 7 });
    expect(n.style['position']).toBeUndefined();
    expect(n.style['left']).toBeUndefined();
    expect(n.style).toMatchObject({ width: '15px', height: '10px' });
  });

  it('none stretches; meet/slice use uniform scale and alignment', () => {
    const run = (
      par: string | null,
      raw?: string,
    ): { x: number; y: number; width: number; height: number } => {
      const doc = createDocument('Test', { id: 'doc_test0004' });
      const frame = createNodeFromTag('div', { isRoot: true, position: { x: 0, y: 0 } });
      frame.id = 'fr_cccccccc';
      const mk = (id: string, left: number): Node =>
        createVectorNode(
          {
            viewBox: { x: 0, y: 0, width: 10, height: 10 },
            paths: [{ id: 'p1', d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', fill: '#000' }],
            ...(par ? { attrs: { preserveAspectRatio: par } } : {}),
            ...(raw ? { raw } : {}),
          },
          {
            id,
            style: {
              position: 'absolute',
              left: px(left),
              top: '0px',
              width: '40px',
              height: '20px',
            },
          },
        );
      frame.children = [mk('sv_par00001', 0), mk('sv_par00002', 0)];
      doc.pages[0]!.frames.push(frame);
      const { ops } = buildFlattenOps(doc, ['sv_par00001', 'sv_par00002']);
      const n = findNode(applyOps(doc, ops).doc, frame.id)!.node.children[0]!;
      return {
        x: parseFloat(n.style['left']!),
        y: parseFloat(n.style['top']!),
        width: parseFloat(n.style['width']!),
        height: parseFloat(n.style['height']!),
      };
    };
    expect(run(null)).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(run('none')).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    // meet: scale 2, 20x20 drawing centered in the 40x20 box
    expect(run('xMidYMid meet')).toEqual({ x: 10, y: 0, width: 20, height: 20 });
    expect(run('xMinYMid meet')).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(run('xMaxYMid meet')).toEqual({ x: 20, y: 0, width: 20, height: 20 });
    // slice: scale 4, drawing 40x40, centered on y (10 left over upward)
    expect(run('xMidYMid slice')).toEqual({ x: 0, y: -10, width: 40, height: 40 });
    // imported (raw) without preserveAspectRatio: browser default, xMidYMid meet
    expect(run(null, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')).toEqual(
      {
        x: 10,
        y: 0,
        width: 20,
        height: 20,
      },
    );
  });
});

describe('fitVectorToContent', () => {
  it('fits the viewBox to the drawing keeping it still on screen', () => {
    const v = {
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      paths: [{ id: 'p1', d: 'M 20 30 L 60 30 L 60 50 Z', fill: '#000' }],
    };
    const r = fitVectorToContent(v, { x: 200, y: 100, width: 200, height: 200 }); // scale 2
    expect(r.vector.viewBox).toEqual({ x: 20, y: 30, width: 40, height: 20 });
    expect(r.box).toEqual({ x: 240, y: 160, width: 80, height: 40 });
    expect(r.vector.raw).toBeUndefined();
  });

  it('default padding is half of the largest stroke', () => {
    const v = {
      viewBox: { x: 0, y: 0, width: 10, height: 10 },
      paths: [{ id: 'p1', d: 'M 2 2 L 8 8', stroke: '#000', strokeWidth: 4 }],
    };
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(fitVectorToContent(v, box).vector.viewBox).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(fitVectorToContent(v, box, { padding: 0 }).vector.viewBox).toEqual({
      x: 2,
      y: 2,
      width: 6,
      height: 6,
    });
  });

  it('without paths returns it unchanged', () => {
    const v = { viewBox: { x: 0, y: 0, width: 10, height: 10 }, paths: [] };
    const box = { x: 1, y: 2, width: 3, height: 4 };
    expect(fitVectorToContent(v, box)).toEqual({ vector: v, box });
  });
});

describe('op setVector', () => {
  it('sets vector and svg; the inverse restores; null removes', () => {
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

  it('serialize/parse preserve vector', () => {
    const { doc } = fixture();
    const back = parseDocument(serializeDocument(doc));
    expect(findNode(back, 'sv_bbbbbbb2')!.node.vector).toEqual(
      findNode(doc, 'sv_bbbbbbb2')!.node.vector,
    );
  });

  it('setAttrs on a node with vector regenerates the svg', () => {
    const { doc } = fixture();
    const r = applyOps(doc, [
      { type: 'setAttrs', changes: [{ nodeId: 'sv_aaaaaaa1', attrs: { 'aria-label': 'icon' } }] },
    ]);
    const n = findNode(r.doc, 'sv_aaaaaaa1')!.node;
    expect(n.svg).toBe(vectorToSvg(n.vector!));
  });
});
