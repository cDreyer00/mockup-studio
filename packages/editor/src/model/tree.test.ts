import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import { getChain, getEntry, haveSameParent, isAncestor, pxValue, topLevel } from './tree';

describe('tree', () => {
  it('indexes parent, index and depth', () => {
    const { doc, frame, c } = makeDoc();
    const c1 = c.children[0]!;
    expect(getEntry(doc, frame.id)).toMatchObject({ parentId: null, index: 0, depth: 0 });
    expect(getEntry(doc, c1.id)).toMatchObject({ parentId: c.id, index: 0, depth: 2 });
    expect(getChain(doc, c1.id).map((n) => n.id)).toEqual([frame.id, c.id, c1.id]);
    expect(isAncestor(doc, frame.id, c1.id)).toBe(true);
    expect(isAncestor(doc, c1.id, frame.id)).toBe(false);
  });

  it('topLevel removes descendants and sorts by document order', () => {
    const { doc, a, c } = makeDoc();
    expect(topLevel(doc, [c.children[0]!.id, c.id, a.id, 'nada'])).toEqual([a.id, c.id]);
  });

  it('haveSameParent', () => {
    const { doc, a, b, c } = makeDoc();
    expect(haveSameParent(doc, [a.id, b.id])).toBe(true);
    expect(haveSameParent(doc, [a.id, c.children[0]!.id])).toBe(false);
  });

  it('pxValue', () => {
    expect(pxValue('12px')).toBe(12);
    expect(pxValue('12')).toBe(12);
    expect(pxValue('-1.5px')).toBe(-1.5);
    expect(pxValue('50%')).toBeUndefined();
    expect(pxValue('auto')).toBeUndefined();
  });
});
