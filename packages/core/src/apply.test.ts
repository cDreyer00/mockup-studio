import { describe, expect, it } from 'vitest';
import { applyOp, applyOps } from './apply.js';
import { createDocument, createNodeFromTag, findNode } from './document.js';
import type { Op } from './ops.js';
import type { Document, Node } from './types.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

/** Documento com frame fr_aaaaaaaa [a, b, c(d)] e segunda página vazia. */
function fixture(): Document {
  const doc = createDocument('Teste', { id: 'doc_test0001' });
  doc.pages[0].id = 'pg_aaaaaaaa';
  const mk = (id: string, tag: string, children: Node[] = [], text?: string): Node => {
    const n = createNodeFromTag(tag, { children, text, styles: { color: 'red' } });
    n.id = id;
    return n;
  };
  const frame = createNodeFromTag('div', { isRoot: true, position: { x: 10, y: 20 } });
  frame.id = 'fr_aaaaaaaa';
  frame.children = [
    mk('el_aaaaaaa1', 'div'),
    mk('tx_bbbbbbb2', 'p', [], 'Olá'),
    mk('el_ccccccc3', 'section', [mk('el_ddddddd4', 'span')]),
  ];
  doc.pages[0].frames.push(frame);
  doc.pages.push({ id: 'pg_bbbbbbbb', name: 'Outra', frames: [], background: '#fff' });
  return doc;
}

function roundTrip(doc: Document, op: Op): { after: Document; inverse: Op[] } {
  const before = structuredClone(doc);
  const r = applyOp(doc, op);
  expect(strip(doc)).toEqual(strip(before)); // imutável
  const back = applyOps(r.doc, r.inverse);
  expect(strip(back.doc)).toStrictEqual(strip(doc));
  return { after: r.doc, inverse: r.inverse };
}

describe('applyOp', () => {
  it('createNode (filho) + inverso', () => {
    const doc = fixture();
    const node = createNodeFromTag('h1', { text: 'Oi', styles: { fontSize: '20px' } });
    const { after } = roundTrip(doc, {
      type: 'createNode',
      parentId: 'fr_aaaaaaaa',
      node,
      index: 1,
    });
    const p = findNode(after, node.id)!;
    expect(p.index).toBe(1);
    expect(p.node.style).toEqual({ 'font-size': '20px' });
  });

  it('createNode frame raiz exige pageId e rejeita id duplicado', () => {
    const doc = fixture();
    const frame = createNodeFromTag('div', { isRoot: true });
    expect(() => applyOp(doc, { type: 'createNode', node: frame })).toThrow(/pageId/);
    const { after } = roundTrip(doc, { type: 'createNode', pageId: 'pg_bbbbbbbb', node: frame });
    expect(after.pages[1].frames).toHaveLength(1);
    const dup = { ...frame, id: 'el_aaaaaaa1' };
    expect(() => applyOp(doc, { type: 'createNode', pageId: 'pg_aaaaaaaa', node: dup })).toThrow(
      /Já existe/,
    );
    const r = applyOp(doc, { type: 'createNode', pageId: 'pg_bbbbbbbb', node: frame });
    expect(r.result).toEqual({ nodeIds: [frame.id] });
  });

  it('createNode: pai inexistente', () => {
    const node = createNodeFromTag('div');
    expect(() => applyOp(fixture(), { type: 'createNode', parentId: 'el_zz', node })).toThrow(
      'Nó "el_zz" não encontrado',
    );
  });

  it('deleteNodes ignora descendentes e restaura índices', () => {
    const doc = fixture();
    const { after } = roundTrip(doc, {
      type: 'deleteNodes',
      nodeIds: ['el_ddddddd4', 'el_ccccccc3', 'el_aaaaaaa1'],
    });
    expect(after.pages[0].frames[0].children.map((c) => c.id)).toEqual(['tx_bbbbbbb2']);
    roundTrip(doc, { type: 'deleteNodes', nodeIds: ['fr_aaaaaaaa'] });
  });

  it('moveNodes: reordenar, reparent e mover para raiz', () => {
    const doc = fixture();
    const re = roundTrip(doc, { type: 'moveNodes', nodeIds: ['el_aaaaaaa1'], index: 2 });
    expect(re.after.pages[0].frames[0].children.map((c) => c.id)).toEqual([
      'tx_bbbbbbb2',
      'el_ccccccc3',
      'el_aaaaaaa1',
    ]);
    roundTrip(doc, {
      type: 'moveNodes',
      nodeIds: ['el_aaaaaaa1', 'tx_bbbbbbb2'],
      parentId: 'el_ccccccc3',
      index: 0,
    });
    roundTrip(doc, {
      type: 'moveNodes',
      nodeIds: ['el_ddddddd4', 'el_aaaaaaa1'],
      parentId: 'fr_aaaaaaaa',
      index: 0,
    });
    const root = roundTrip(doc, {
      type: 'moveNodes',
      nodeIds: ['el_ccccccc3'],
      parentId: null,
      pageId: 'pg_bbbbbbbb',
    });
    expect(root.after.pages[1].frames[0].type).toBe('element');
  });

  it('moveNodes: reordenação múltipla dentro do mesmo pai é revertida', () => {
    const doc = fixture();
    roundTrip(doc, { type: 'moveNodes', nodeIds: ['el_ccccccc3', 'tx_bbbbbbb2'], index: 0 });
    roundTrip(doc, { type: 'moveNodes', nodeIds: ['el_aaaaaaa1', 'el_ccccccc3'], index: 0 });
  });

  it('moveNodes proíbe mover para dentro de si/descendente', () => {
    const doc = fixture();
    expect(() =>
      applyOp(doc, { type: 'moveNodes', nodeIds: ['el_ccccccc3'], parentId: 'el_ddddddd4' }),
    ).toThrow(/descendente/);
    expect(() =>
      applyOp(doc, { type: 'moveNodes', nodeIds: ['el_ccccccc3'], parentId: 'el_ccccccc3' }),
    ).toThrow(/si mesmo/);
  });

  it('updateStyles: forma changes e forma simples', () => {
    const doc = fixture();
    const a = roundTrip(doc, {
      type: 'updateStyles',
      changes: [
        { nodeId: 'el_aaaaaaa1', set: { backgroundColor: 'blue', color: 'green' }, unset: ['x-y'] },
      ],
    });
    expect(findNode(a.after, 'el_aaaaaaa1')!.node.style).toEqual({
      color: 'green',
      'background-color': 'blue',
    });
    const b = roundTrip(doc, {
      type: 'updateStyles',
      nodeIds: ['el_aaaaaaa1', 'tx_bbbbbbb2'],
      styles: { 'font-size': '10px' },
      unset: ['color'],
    });
    expect(findNode(b.after, 'tx_bbbbbbb2')!.node.style).toEqual({ 'font-size': '10px' });
    expect(() =>
      applyOp(doc, { type: 'updateStyles', nodeIds: ['el_aaaaaaa1'], styles: { '1x': 'a' } }),
    ).toThrow(/inválido/);
  });

  it('updateStyles: valor vazio remove a propriedade', () => {
    const doc = fixture();
    const r = roundTrip(doc, {
      type: 'updateStyles',
      nodeIds: ['el_aaaaaaa1'],
      styles: { color: '' },
    });
    expect(findNode(r.after, 'el_aaaaaaa1')!.node.style).toEqual({});
  });

  it('setText, setAttrs, renameNodes, setPosition, setNodeFlags', () => {
    const doc = fixture();
    const t = roundTrip(doc, {
      type: 'setText',
      changes: [{ nodeId: 'tx_bbbbbbb2', text: 'Novo' }],
    });
    expect(findNode(t.after, 'tx_bbbbbbb2')!.node.text).toBe('Novo');
    const at = roundTrip(doc, {
      type: 'setAttrs',
      changes: [{ nodeId: 'el_aaaaaaa1', set: { href: '#', alt: 'x' }, unset: ['nada'] }],
    });
    expect(findNode(at.after, 'el_aaaaaaa1')!.node.attrs).toEqual({ href: '#', alt: 'x' });
    expect(() =>
      applyOp(doc, { type: 'setAttrs', changes: [{ nodeId: 'el_aaaaaaa1', set: { style: 'a' } }] }),
    ).toThrow(/style/);
    const rn = roundTrip(doc, {
      type: 'renameNodes',
      changes: [{ nodeId: 'fr_aaaaaaaa', name: 'Hero' }],
    });
    expect(findNode(rn.after, 'fr_aaaaaaaa')!.node.name).toBe('Hero');
    const ps = roundTrip(doc, {
      type: 'setPosition',
      changes: [{ nodeId: 'fr_aaaaaaaa', position: { x: 5, y: 6 } }],
    });
    expect(findNode(ps.after, 'fr_aaaaaaaa')!.node.position).toEqual({ x: 5, y: 6 });
    const fl = roundTrip(doc, {
      type: 'setNodeFlags',
      changes: [{ nodeId: 'el_aaaaaaa1', locked: true, hidden: true }],
    });
    expect(findNode(fl.after, 'el_aaaaaaa1')!.node).toMatchObject({ locked: true, hidden: true });
  });

  it('duplicateNodes: cópia após o original, idMap determinístico', () => {
    const doc = fixture();
    const r = applyOp(doc, { type: 'duplicateNodes', nodeIds: ['el_ccccccc3'] });
    const idMap = r.result!.idMap as Record<string, string>;
    expect(Object.keys(idMap).sort()).toEqual(['el_ccccccc3', 'el_ddddddd4']);
    const kids = r.doc.pages[0].frames[0].children;
    expect(kids.map((c) => c.id)).toEqual([
      'el_aaaaaaa1',
      'tx_bbbbbbb2',
      'el_ccccccc3',
      idMap['el_ccccccc3'],
    ]);
    expect(kids[3].children[0].id).toBe(idMap['el_ddddddd4']);
    expect(r.result!.nodeIds).toEqual([idMap['el_ccccccc3']]);
    // reaplicar com a op completa gera exatamente os mesmos ids
    const full = r.result!.op as Op;
    const again = applyOp(doc, full);
    expect(strip(again.doc)).toEqual(strip(r.doc));
    // inverso
    expect(strip(applyOps(r.doc, r.inverse).doc)).toEqual(strip(doc));
  });

  it('duplicateNodes de frame raiz desloca x em 40', () => {
    const doc = fixture();
    const r = applyOp(doc, { type: 'duplicateNodes', nodeIds: ['fr_aaaaaaaa'] });
    expect(r.doc.pages[0].frames).toHaveLength(2);
    expect(r.doc.pages[0].frames[1].position).toEqual({ x: 50, y: 20 });
    expect(strip(applyOps(r.doc, r.inverse).doc)).toEqual(strip(doc));
  });

  it('páginas: create/rename/delete com restauração completa', () => {
    const doc = fixture();
    const c = roundTrip(doc, { type: 'createPage', pageId: 'pg_cccccccc', name: 'Nova', index: 0 });
    expect(c.after.pages[0].id).toBe('pg_cccccccc');
    roundTrip(doc, { type: 'renamePage', pageId: 'pg_aaaaaaaa', name: 'X' });
    const d = roundTrip(doc, { type: 'deletePage', pageId: 'pg_aaaaaaaa' });
    expect(d.after.pages).toHaveLength(1);
    expect(() => applyOp(d.after, { type: 'deletePage', pageId: 'pg_bbbbbbbb' })).toThrow(/última/);
    expect(() => applyOp(doc, { type: 'createPage', pageId: 'pg_aaaaaaaa', name: 'dup' })).toThrow(
      /Já existe/,
    );
  });

  it('setTokens: set/unset com restauração', () => {
    const doc = fixture();
    doc.tokens['--a'] = '1';
    const r = roundTrip(doc, { type: 'setTokens', set: { '--b': '2', '--a': '3' } });
    expect(r.after.tokens).toEqual({ '--a': '3', '--b': '2' });
    const u = roundTrip(doc, { type: 'setTokens', unset: ['--a', '--zz'] });
    expect(u.after.tokens).toEqual({});
  });

  it('atualiza meta.updatedAt', async () => {
    const doc = fixture();
    doc.meta.updatedAt = '2000-01-01T00:00:00.000Z';
    const r = applyOp(doc, { type: 'renamePage', pageId: 'pg_aaaaaaaa', name: 'Y' });
    expect(r.doc.meta.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

describe('applyOps', () => {
  it('aplica em sequência e o inverso desfaz tudo', () => {
    const doc = fixture();
    const r = applyOps(doc, [
      { type: 'renameNodes', changes: [{ nodeId: 'el_aaaaaaa1', name: 'A' }] },
      { type: 'deleteNodes', nodeIds: ['el_aaaaaaa1'] },
      { type: 'setTokens', set: { '--x': '1' } },
    ]);
    expect(r.results).toHaveLength(3);
    expect(strip(applyOps(r.doc, r.inverse).doc)).toEqual(strip(doc));
  });

  it('é atômico em caso de falha', () => {
    const doc = fixture();
    const before = structuredClone(doc);
    expect(() =>
      applyOps(doc, [
        { type: 'deleteNodes', nodeIds: ['el_aaaaaaa1'] },
        { type: 'deleteNodes', nodeIds: ['el_zz'] },
      ]),
    ).toThrow(/não encontrado/);
    expect(doc).toEqual(before);
  });
});
