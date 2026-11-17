import { describe, expect, it } from 'vitest';
import { applyOps, createNodeFromTag } from '@mockup/core';
import type { Document, Page } from '@mockup/core';
import { getEntry, getNode } from '../model/tree';
import { makeDoc } from '../test/fixtures';
import { computeDropOps, flattenTree, nextPageName, rangeBetween } from './layersLogic';

const kids = (doc: Document, id: string) => getNode(doc, id)!.children.map((c) => c.id);

function setup() {
  const base = makeDoc();
  const f2 = createNodeFromTag('div', { isRoot: true, name: 'F2', position: { x: 900, y: 0 } });
  base.doc.pages[0]!.frames.push(f2);
  return { ...base, f2 };
}

describe('flattenTree', () => {
  it('respects collapsed nodes', () => {
    const { doc, frame, c } = setup();
    const page = doc.pages[0]!;
    const all = flattenTree(page, new Set()).map((r) => r.id);
    expect(all).toContain(c.children[0]!.id);
    const part = flattenTree(page, new Set([c.id]));
    expect(part.map((r) => r.id)).not.toContain(c.children[0]!.id);
    expect(part.find((r) => r.id === c.id)).toMatchObject({ hasChildren: true, expanded: false });
    expect(flattenTree(page, new Set([frame.id])).map((r) => r.id)).toEqual([
      frame.id,
      page.frames[1]!.id,
    ]);
  });
});

describe('rangeBetween / nextPageName', () => {
  it('range in both directions', () => {
    const v = ['a', 'b', 'c', 'd'];
    expect(rangeBetween(v, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(v, 'c', 'a')).toEqual(['a', 'b', 'c']);
    expect(rangeBetween(v, null, 'c')).toEqual(['c']);
  });
  it('next free name', () => {
    const p = (name: string) => ({ name }) as Page;
    expect(nextPageName([p('Page 1')])).toBe('Page 2');
    expect(nextPageName([p('Page 1'), p('Page 3')])).toBe('Page 4');
    expect(nextPageName([p('A'), p('Page 3')])).toBe('Page 4');
    expect(nextPageName([p('A'), p('Page 2')])).toBe('Page 3');
  });
});

describe('computeDropOps', () => {
  it('same parent, downwards and upwards', () => {
    const { doc, frame, a, b, c, abs } = setup();
    const down = applyOps(doc, computeDropOps(doc, [a.id], { id: c.id, zone: 'after' })!).doc;
    expect(kids(down, frame.id)).toEqual([b.id, c.id, a.id, abs.id]);
    const up = applyOps(doc, computeDropOps(doc, [c.id], { id: a.id, zone: 'before' })!).doc;
    expect(kids(up, frame.id)).toEqual([c.id, a.id, b.id, abs.id]);
    const multi = applyOps(
      doc,
      computeDropOps(doc, [b.id, a.id], { id: abs.id, zone: 'before' })!,
    ).doc;
    expect(kids(multi, frame.id)).toEqual([c.id, a.id, b.id, abs.id]);
  });

  it('into another parent (and a root frame loses its position)', () => {
    const { doc, a, c, f2 } = setup();
    const r = applyOps(doc, computeDropOps(doc, [a.id], { id: c.id, zone: 'inside' })!).doc;
    expect(kids(r, c.id)).toEqual([c.children[0]!.id, a.id]);
    const ops = computeDropOps(doc, [f2.id], { id: c.id, zone: 'inside' })!;
    const r2 = applyOps(doc, ops).doc;
    expect(getEntry(r2, f2.id)!.parentId).toBe(c.id);
    expect(getNode(r2, f2.id)!.position).toBeUndefined();
  });

  it('to the page root with measured position and size', () => {
    const { doc, a, frame } = setup();
    const page = doc.pages[0]!;
    const ops = computeDropOps(doc, [a.id], { rootOfPage: page.id, index: 0 }, () => ({
      x: 120.4,
      y: 80,
      w: 50,
      h: 20,
    }))!;
    const r = applyOps(doc, ops).doc;
    expect(r.pages[0]!.frames[0]!.id).toBe(a.id);
    expect(r.pages[0]!.frames[1]!.id).toBe(frame.id);
    const n = getNode(r, a.id)!;
    expect(n.position).toEqual({ x: 120, y: 80 });
    expect(n.style.width).toBe('10px');
    expect(n.style.height).toBe('20px');
    const fb = computeDropOps(doc, [a.id], { rootOfPage: page.id })!;
    expect(getNode(applyOps(doc, fb).doc, a.id)!.position).toEqual({ x: 0, y: 0 });
  });

  it('text/image dropped on the root get a wrapping frame, in the same place (one undo)', () => {
    const { doc, a, b, c, abs, frame } = setup();
    const img = createNodeFromTag('img', {
      name: 'Photo',
      src: 'x.png',
      styles: { position: 'absolute', left: '5px', top: '6px', width: '30px', height: '20px' },
      position: { x: 5, y: 6 },
    });
    frame.children.push(img); // before any getNode (the index is cached per document)
    const rects: Record<string, { x: number; y: number; w: number; h: number }> = {
      [a.id]: { x: 100, y: 50, w: 10, h: 18 },
      [b.id]: { x: 100, y: 76, w: 80, h: 18 },
      [img.id]: { x: 105, y: 56, w: 30, h: 20 },
    };
    const page = doc.pages[0]!;
    const ops = computeDropOps(
      doc,
      [a.id, b.id, img.id],
      { rootOfPage: page.id, index: 0 },
      (id) => rects[id] ?? null,
    )!;
    const r = applyOps(doc, ops);
    const frames = r.doc.pages[0]!.frames;
    // element goes directly (keeps type: element); text and image end up inside new frames
    expect(frames.map((f) => f.type)).toEqual(['element', 'frame', 'frame', 'frame', 'frame']);
    expect(frames[0]!.id).toBe(a.id);
    expect(frames[3]!.id).toBe(frame.id);
    const textFrame = frames[1]!;
    expect(textFrame.children.map((c) => c.id)).toEqual([b.id]);
    expect(textFrame.name).toBe('B');
    expect(textFrame.position).toEqual({ x: 76, y: 52 });
    expect(textFrame.style).toMatchObject({ width: '128px', height: '66px', padding: '24px' });
    const imgFrame = frames[2]!;
    expect(imgFrame.children.map((c) => c.id)).toEqual([img.id]);
    expect(imgFrame.position).toEqual({ x: 81, y: 32 });
    const movedImg = getNode(r.doc, img.id)!;
    expect(movedImg.position).toBeUndefined();
    expect(movedImg.style).toEqual({ width: '30px', height: '20px' });
    expect(kids(r.doc, frame.id)).toEqual([c.id, abs.id]);
    // a single inverse restores the original document
    const back = applyOps(r.doc, r.inverse).doc;
    expect(back.pages).toEqual(doc.pages);
  });

  it('reorders root frames adjusting the index', () => {
    const { doc, frame, f2 } = setup();
    const r = applyOps(doc, computeDropOps(doc, [frame.id], { id: f2.id, zone: 'after' })!).doc;
    expect(r.pages[0]!.frames.map((f) => f.id)).toEqual([f2.id, frame.id]);
  });

  it('refuses to drop into itself, a descendant or a node without children', () => {
    const { doc, frame, c, b } = setup();
    expect(computeDropOps(doc, [frame.id], { id: c.id, zone: 'inside' })).toBeNull();
    expect(computeDropOps(doc, [c.id], { id: c.id, zone: 'inside' })).toBeNull();
    expect(computeDropOps(doc, [frame.id], { id: c.children[0]!.id, zone: 'before' })).toBeNull();
    expect(computeDropOps(doc, [c.id], { id: b.id, zone: 'inside' })).toBeNull();
  });
});
