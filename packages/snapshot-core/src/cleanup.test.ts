import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createDocument,
  createNodeFromTag,
  findNode,
  type Document,
  type Node,
} from '@mockup/core';
import { planCleanup } from './cleanup.js';

const el = (
  tag: string,
  style: Record<string, string> = {},
  children: Node[] = [],
  name?: string,
) => createNodeFromTag(tag, { name, styles: style, children });
const txt = (text: string, style: Record<string, string> = {}) =>
  createNodeFromTag('span', { text, styles: style });

function docWith(root: Node): Document {
  const doc = createDocument('t');
  doc.pages[0]!.frames.push(root);
  return doc;
}

function frame(style: Record<string, string>, children: Node[]): Node {
  return createNodeFromTag('div', { isRoot: true, styles: style, children });
}

/** Aplica o plano e devolve o documento resultante. */
function run(doc: Document, id: string, opts = {}) {
  const plan = planCleanup(doc, id, opts);
  const next = plan.ops.length ? applyOps(doc, plan.ops).doc : doc;
  return { plan, next };
}

describe('planCleanup: removeEmpty', () => {
  it('remove divs vazios, em cascata, e preserva os com presença visual', () => {
    const inner = el('div');
    const emptyParent = el('div', {}, [inner]);
    const spacer = el('div', { height: '16px' });
    const flexSpacer = el('div', { flex: '1 1 0%' });
    const bordered = el('div', { border: '1px solid red' });
    const noBorder = el('div', { border: '0px none rgb(0, 0, 0)' });
    const bg = el('div', { 'background-color': '#fff' });
    const img = createNodeFromTag('img', { src: '' });
    const br = createNodeFromTag('br');
    const keepText = el('div', {}, [txt('olá')]);
    const root = frame({ width: '1000px', height: '800px' }, [
      emptyParent,
      spacer,
      flexSpacer,
      bordered,
      noBorder,
      bg,
      img,
      br,
      keepText,
    ]);
    const doc = docWith(root);
    const { plan, next } = run(doc, root.id, { unwrap: false, fluid: false });
    expect(plan.removed).toBe(3); // emptyParent + inner + noBorder
    expect(plan.unwrapped).toBe(0);
    const ids = next.pages[0]!.frames[0]!.children.map((c) => c.id);
    expect(ids).toEqual([spacer.id, flexSpacer.id, bordered.id, bg.id, img.id, br.id, keepText.id]);
  });

  it('nunca remove o próprio nó, mesmo vazio', () => {
    const root = el('div');
    const doc = docWith(root);
    const plan = planCleanup(doc, root.id);
    expect(plan.ops).toEqual([]);
    expect(plan.removed).toBe(0);
  });

  it('nó inexistente lança erro', () => {
    expect(() => planCleanup(createDocument('x'), 'el_nao')).toThrow(/não encontrado/);
  });
});

describe('planCleanup: unwrap', () => {
  it('desembrulha wrappers neutros em cadeia, preservando a ordem entre irmãos', () => {
    const leaf = txt('fim');
    const w2 = el('div', { display: 'block', margin: '0px' }, [leaf]);
    const w1 = el('div', {}, [w2]);
    const before = txt('antes');
    const after = txt('depois');
    const root = frame({ width: '500px', height: '400px' }, [before, w1, after]);
    const { plan, next } = run(docWith(root), root.id, { removeEmpty: false, fluid: false });
    expect(plan.unwrapped).toBe(2);
    expect(next.pages[0]!.frames[0]!.children.map((c) => c.id)).toEqual([
      before.id,
      leaf.id,
      after.id,
    ]);
  });

  it('não desembrulha wrapper com estilo visual, texto, tipografia ou flex', () => {
    const mk = (style: Record<string, string>) => el('div', style, [txt('x')]);
    const kept = [
      mk({ padding: '8px' }),
      mk({ background: '#fff' }),
      mk({ color: 'red' }),
      mk({ display: 'flex' }),
      mk({ position: 'relative' }),
      mk({ overflow: 'hidden' }),
      mk({ opacity: '0.5' }),
      mk({ margin: '0 auto' }),
      mk({ width: '300px' }), // diferente da largura do filho (ausente)
    ];
    const root = frame({ width: '500px', height: '400px' }, kept);
    const { plan } = run(docWith(root), root.id, { removeEmpty: false, fluid: false });
    expect(plan.unwrapped).toBe(0);
  });

  it('wrapper com width igual à do filho é desembrulhado; com 2 filhos não', () => {
    const child = el('div', { width: '200px' }, [txt('a')]);
    const w = el('div', { width: '200px' }, [child]);
    const two = el('div', {}, [txt('a'), txt('b')]);
    const root = frame({ width: '500px', height: '400px' }, [w, two]);
    const { plan, next } = run(docWith(root), root.id, { removeEmpty: false, fluid: false });
    expect(plan.unwrapped).toBe(1);
    expect(findNode(next, w.id)).toBeUndefined();
    expect(findNode(next, child.id)?.parent?.id).toBe(root.id);
  });
});

describe('planCleanup: fluid', () => {
  it('remove width igual ao conteúdo do pai (bloco, com padding e border); height com filhos vira min-height', () => {
    const child = el('div', { width: '900px', height: '120px' }, [txt('x')]);
    const wrong = el('div', { width: '901px' }, [txt('y')]);
    const root = frame({ width: '1000px', height: '800px', padding: '0 50px' }, [child, wrong]);
    const { plan, next } = run(docWith(root), root.id, { removeEmpty: false, unwrap: false });
    expect(plan.fluid).toBe(2); // width + height do child
    const c = findNode(next, child.id)!.node;
    expect(c.style.width).toBeUndefined();
    expect(c.style.height).toBeUndefined();
    expect(c.style['min-height']).toBe('120px');
    expect(findNode(next, wrong.id)!.node.style.width).toBe('901px');
    // a raiz não muda
    expect(next.pages[0]!.frames[0]!.style.width).toBe('1000px');
    expect(next.pages[0]!.frames[0]!.style.height).toBe('800px');
  });

  it('flex coluna com align-items diferente vira align-self: stretch; row não muda', () => {
    const a = el('div', { width: '400px' }, [txt('a')]);
    const colCenter = el(
      'div',
      { display: 'flex', 'flex-direction': 'column', 'align-items': 'center', width: '400px' },
      [a],
    );
    const b = el('div', { width: '400px' }, [txt('b')]);
    const row = el('div', { display: 'flex', width: '400px' }, [b]);
    const c = el('div', { width: '400px' }, [txt('c')]);
    const colStretch = el('div', { display: 'flex', 'flex-direction': 'column', width: '400px' }, [
      c,
    ]);
    const root = frame({ width: '400px', height: '800px' }, [colCenter, row, colStretch]);
    const { plan, next } = run(docWith(root), root.id, { removeEmpty: false, unwrap: false });
    const A = findNode(next, a.id)!.node;
    expect(A.style.width).toBeUndefined();
    expect(A.style['align-self']).toBe('stretch');
    expect(findNode(next, b.id)!.node.style.width).toBe('400px');
    const C = findNode(next, c.id)!.node;
    expect(C.style.width).toBeUndefined();
    expect(C.style['align-self']).toBeUndefined();
    // colCenter, row e colStretch (400 = conteúdo da raiz) + a + c
    expect(plan.fluid).toBe(5);
  });

  it('não converte imagens, posição absoluta, overflow oculto nem height sem filhos', () => {
    const img = createNodeFromTag('img', { src: '', styles: { width: '500px', height: '200px' } });
    const abs = el('div', { width: '500px', position: 'absolute' }, [txt('a')]);
    const clip = el('div', { height: '100px', overflow: 'hidden' }, [txt('a')]);
    const empty = el('div', { height: '100px' });
    const root = frame({ width: '500px', height: '800px' }, [img, abs, clip, empty]);
    const { plan } = run(docWith(root), root.id, { removeEmpty: false, unwrap: false });
    expect(plan.fluid).toBe(0);
    expect(plan.ops).toEqual([]);
  });
});

describe('planCleanup: combinado', () => {
  it('as ops saem em sequência válida e não alteram o documento original', () => {
    const leaf = txt('conteúdo');
    const wrapper = el('div', {}, [el('div', { width: '600px', height: '50px' }, [leaf])]);
    const root = frame({ width: '600px', height: '500px' }, [el('div'), wrapper]);
    const doc = docWith(root);
    const snapshot = JSON.stringify(doc);
    const { plan, next } = run(doc, root.id);
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(plan.removed).toBe(1);
    expect(plan.unwrapped).toBe(1);
    expect(plan.fluid).toBe(2);
    const top = next.pages[0]!.frames[0]!;
    expect(top.children).toHaveLength(1);
    // a largura redundante sai e a altura vira min-height: o div interno (com o texto) fica
    const inner = top.children[0]!;
    expect(inner.style).toEqual({ 'min-height': '50px' });
    expect(inner.children[0]!.id).toBe(leaf.id);
  });

  it('com tudo desligado devolve plano vazio', () => {
    const root = frame({ width: '10px', height: '10px' }, [el('div')]);
    const plan = planCleanup(docWith(root), root.id, {
      removeEmpty: false,
      unwrap: false,
      fluid: false,
    });
    expect(plan).toEqual({ ops: [], removed: 0, unwrapped: 0, fluid: 0 });
  });
});
