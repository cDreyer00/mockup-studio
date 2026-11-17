import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply.js';
import { createDocument, createNodeFromTag, findNode } from './document.js';
import type { Document, Vector } from './types.js';
import { generateVectorSvg } from './vector/svg.js';

const V: Vector = {
  viewBox: { x: 0, y: 0, width: 24, height: 24 },
  paths: [{ id: 'p1', d: 'M0 0L10 10', stroke: '#000' }],
};

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

function docWithSvg(withMarkup: boolean, vector?: Vector): Document {
  const doc = createDocument('T', { id: 'doc_test0001' });
  const frame = createNodeFromTag('div', { isRoot: true });
  frame.id = 'fr_aaaaaaaa';
  const n = createNodeFromTag('svg', {});
  n.id = 'sv_aaaaaaa1';
  if (withMarkup && vector) {
    n.vector = structuredClone(vector);
    n.svg = generateVectorSvg(vector);
  } else delete n.svg;
  frame.children = [n];
  doc.pages[0].frames.push(frame);
  return doc;
}

const node = (d: Document) => findNode(d, 'sv_aaaaaaa1')!.node;

describe('setAttrs viewBox on an svg with a vector', () => {
  it('syncs vector.viewBox and undoes', () => {
    const doc = docWithSvg(true, V);
    const r = applyOp(doc, {
      type: 'setAttrs',
      changes: [{ nodeId: 'sv_aaaaaaa1', set: { viewBox: '0 0 48 32' } }],
    });
    expect(node(r.doc).vector!.viewBox).toEqual({ x: 0, y: 0, width: 48, height: 32 });
    expect(node(r.doc).svg).toContain('viewBox="0 0 48 32"');
    const back = applyOps(r.doc, r.inverse).doc;
    expect(node(back).vector!.viewBox).toEqual(V.viewBox);
    expect(node(back).svg).toBe(node(doc).svg);
  });

  it.each(['0 0 10', '0 0 0 10', 'a b c d', '0 0 -5 5'])('invalid viewBox "%s" fails', (vb) => {
    expect(() =>
      applyOp(docWithSvg(true, V), {
        type: 'setAttrs',
        changes: [{ nodeId: 'sv_aaaaaaa1', set: { viewBox: vb } }],
      }),
    ).toThrow(/Invalid viewBox/);
  });

  it('unset of viewBox fails', () => {
    expect(() =>
      applyOp(docWithSvg(true, V), {
        type: 'setAttrs',
        changes: [{ nodeId: 'sv_aaaaaaa1', unset: ['viewBox'] }],
      }),
    ).toThrow(/viewBox/);
  });
});

describe('setVector: invalid path data', () => {
  it.each(['M', 'L 1 2', 'M 0 0 L 1'])('"%s" fails with a clear message', (d) => {
    expect(() =>
      applyOp(docWithSvg(false), {
        type: 'setVector',
        changes: [{ nodeId: 'sv_aaaaaaa1', vector: { ...V, paths: [{ id: 'p1', d }] } }],
      }),
    ).toThrow(/Invalid path data in "d"/);
  });

  it('valid path passes', () => {
    expect(() =>
      applyOp(docWithSvg(false), {
        type: 'setVector',
        changes: [{ nodeId: 'sv_aaaaaaa1', vector: V }],
      }),
    ).not.toThrow();
  });
});

describe('setVector: exact inverse', () => {
  it('node without markup returns without node.svg or vector', () => {
    const doc = docWithSvg(false);
    expect(node(doc).svg).toBeUndefined();
    const r = applyOp(doc, {
      type: 'setVector',
      changes: [{ nodeId: 'sv_aaaaaaa1', vector: V }],
    });
    expect(node(r.doc).svg).toBeTruthy();
    const back = applyOps(r.doc, r.inverse).doc;
    expect(node(back).svg).toBeUndefined();
    expect(node(back).vector).toBeUndefined();
    expect(strip(back)).toStrictEqual(strip(doc));
  });

  it('node with a vector returns to the previous vector and markup', () => {
    const doc = docWithSvg(true, V);
    const r = applyOp(doc, {
      type: 'setVector',
      changes: [{ nodeId: 'sv_aaaaaaa1', vector: { ...V, paths: [{ id: 'p2', d: 'M0 0H5' }] } }],
    });
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
  });
});
