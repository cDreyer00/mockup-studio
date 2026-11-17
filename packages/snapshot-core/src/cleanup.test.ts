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

/** Applies the plan and returns the resulting document. */
function run(doc: Document, id: string, opts = {}) {
  const plan = planCleanup(doc, id, opts);
  const next = plan.ops.length ? applyOps(doc, plan.ops).doc : doc;
  return { plan, next };
}

describe('planCleanup: removeEmpty', () => {
  it('removes empty divs, in cascade, and keeps those with visual presence', () => {
    const inner = el('div');
    const emptyParent = el('div', {}, [inner]);
    const spacer = el('div', { height: '16px' });
    const flexSpacer = el('div', { flex: '1 1 0%' });
    const bordered = el('div', { border: '1px solid red' });
    const noBorder = el('div', { border: '0px none rgb(0, 0, 0)' });
    const bg = el('div', { 'background-color': '#fff' });
    const img = createNodeFromTag('img', { src: '' });
    const br = createNodeFromTag('br');
    const keepText = el('div', {}, [txt('hello')]);
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

  it('never removes the node itself, even when empty', () => {
    const root = el('div');
    const doc = docWith(root);
    const plan = planCleanup(doc, root.id);
    expect(plan.ops).toEqual([]);
    expect(plan.removed).toBe(0);
  });

  it('a non-existent node throws an error', () => {
    expect(() => planCleanup(createDocument('x'), 'el_missing')).toThrow(/Node not found/);
  });
});

describe('planCleanup: unwrap', () => {
  it('unwraps neutral wrappers in a chain, preserving the order among siblings', () => {
    const leaf = txt('end');
    const w2 = el('div', { display: 'block', margin: '0px' }, [leaf]);
    const w1 = el('div', {}, [w2]);
    const before = txt('before');
    const after = txt('after');
    const root = frame({ width: '500px', height: '400px' }, [before, w1, after]);
    const { plan, next } = run(docWith(root), root.id, { removeEmpty: false, fluid: false });
    expect(plan.unwrapped).toBe(2);
    expect(next.pages[0]!.frames[0]!.children.map((c) => c.id)).toEqual([
      before.id,
      leaf.id,
      after.id,
    ]);
  });

  it('does not unwrap a wrapper with visual style, text, typography or flex', () => {
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
      mk({ width: '300px' }), // different from the child's width (absent)
    ];
    const root = frame({ width: '500px', height: '400px' }, kept);
    const { plan } = run(docWith(root), root.id, { removeEmpty: false, fluid: false });
    expect(plan.unwrapped).toBe(0);
  });

  it('a wrapper with the same width as its child is unwrapped; with 2 children it is not', () => {
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
  it('removes a width equal to the parent content (block, with padding and border); height with children becomes min-height', () => {
    const child = el('div', { width: '900px', height: '120px' }, [txt('x')]);
    const wrong = el('div', { width: '901px' }, [txt('y')]);
    const root = frame({ width: '1000px', height: '800px', padding: '0 50px' }, [child, wrong]);
    const { plan, next } = run(docWith(root), root.id, { removeEmpty: false, unwrap: false });
    expect(plan.fluid).toBe(2); // width + height of the child
    const c = findNode(next, child.id)!.node;
    expect(c.style.width).toBeUndefined();
    expect(c.style.height).toBeUndefined();
    expect(c.style['min-height']).toBe('120px');
    expect(findNode(next, wrong.id)!.node.style.width).toBe('901px');
    // the root does not change
    expect(next.pages[0]!.frames[0]!.style.width).toBe('1000px');
    expect(next.pages[0]!.frames[0]!.style.height).toBe('800px');
  });

  it('a flex column with a different align-items becomes align-self: stretch; row does not change', () => {
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
    // colCenter, row and colStretch (400 = root content) + a + c
    expect(plan.fluid).toBe(5);
  });

  it('does not convert images, absolute position, hidden overflow or height without children', () => {
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

describe('planCleanup: combined', () => {
  it('the ops come out in a valid sequence and do not change the original document', () => {
    const leaf = txt('content');
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
    // the redundant width goes away and the height becomes min-height: the inner div (with the text) stays
    const inner = top.children[0]!;
    expect(inner.style).toEqual({ 'min-height': '50px' });
    expect(inner.children[0]!.id).toBe(leaf.id);
  });

  it('with everything turned off returns an empty plan', () => {
    const root = frame({ width: '10px', height: '10px' }, [el('div')]);
    const plan = planCleanup(docWith(root), root.id, {
      removeEmpty: false,
      unwrap: false,
      fluid: false,
    });
    expect(plan).toEqual({ ops: [], removed: 0, unwrapped: 0, fluid: 0 });
  });
});
