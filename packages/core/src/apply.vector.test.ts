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

describe('setAttrs viewBox em svg com vetor', () => {
  it('sincroniza vector.viewBox e desfaz', () => {
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

  it.each(['0 0 10', '0 0 0 10', 'a b c d', '0 0 -5 5'])('viewBox inválido "%s" falha', (vb) => {
    expect(() =>
      applyOp(docWithSvg(true, V), {
        type: 'setAttrs',
        changes: [{ nodeId: 'sv_aaaaaaa1', set: { viewBox: vb } }],
      }),
    ).toThrow(/viewBox inválido/);
  });

  it('unset de viewBox falha', () => {
    expect(() =>
      applyOp(docWithSvg(true, V), {
        type: 'setAttrs',
        changes: [{ nodeId: 'sv_aaaaaaa1', unset: ['viewBox'] }],
      }),
    ).toThrow(/viewBox/);
  });
});

describe('setVector: path data inválido', () => {
  it.each(['M', 'L 1 2', 'M 0 0 L 1'])('"%s" falha com mensagem clara', (d) => {
    expect(() =>
      applyOp(docWithSvg(false), {
        type: 'setVector',
        changes: [{ nodeId: 'sv_aaaaaaa1', vector: { ...V, paths: [{ id: 'p1', d }] } }],
      }),
    ).toThrow(/Path data inválido em "d"/);
  });

  it('path válido passa', () => {
    expect(() =>
      applyOp(docWithSvg(false), {
        type: 'setVector',
        changes: [{ nodeId: 'sv_aaaaaaa1', vector: V }],
      }),
    ).not.toThrow();
  });
});

describe('setVector: inverso exato', () => {
  it('nó sem markup volta sem node.svg nem vector', () => {
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

  it('nó com vetor volta ao vetor e markup anteriores', () => {
    const doc = docWithSvg(true, V);
    const r = applyOp(doc, {
      type: 'setVector',
      changes: [{ nodeId: 'sv_aaaaaaa1', vector: { ...V, paths: [{ id: 'p2', d: 'M0 0H5' }] } }],
    });
    expect(strip(applyOps(r.doc, r.inverse).doc)).toStrictEqual(strip(doc));
  });
});
