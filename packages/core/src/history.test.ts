import { describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag } from './document.js';
import { History } from './history.js';
import type { Document } from './types.js';

function strip(doc: Document): unknown {
  const c = structuredClone(doc);
  c.meta.updatedAt = '';
  return c;
}

function base(): { doc: Document; pageId: string } {
  const doc = createDocument('H');
  return { doc, pageId: doc.pages[0].id };
}

describe('History', () => {
  it('apply/undo/redo and revision', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    expect(h.canUndo).toBe(false);
    const frame = createNodeFromTag('div', { isRoot: true });
    const r = h.apply([{ type: 'createNode', pageId, node: frame }], 'create');
    expect(r.appliedOps).toHaveLength(1);
    expect(h.revision).toBe(1);
    expect(h.doc.pages[0].frames).toHaveLength(1);
    const u = h.undo()!;
    expect(u.doc.pages[0].frames).toHaveLength(0);
    expect(u.ops[0].type).toBe('deleteNodes');
    expect(strip(h.doc)).toEqual(strip(doc));
    expect(h.canRedo).toBe(true);
    const rd = h.redo()!;
    expect(rd.doc.pages[0].frames[0].id).toBe(frame.id);
    expect(h.revision).toBe(3);
    expect(h.redo()).toBeNull();
  });

  it('a new action clears the redo stack', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    h.apply([{ type: 'renamePage', pageId, name: 'A' }]);
    h.undo();
    h.apply([{ type: 'renamePage', pageId, name: 'B' }]);
    expect(h.canRedo).toBe(false);
  });

  it('duplicate: redo keeps the same ids', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    const frame = createNodeFromTag('div', { isRoot: true });
    h.apply([{ type: 'createNode', pageId, node: frame }]);
    const r = h.apply([{ type: 'duplicateNodes', nodeIds: [frame.id] }]);
    const applied = r.appliedOps[0] as { idMap?: Record<string, string> };
    expect(applied.idMap).toBeDefined();
    const newId = applied.idMap![frame.id];
    h.undo();
    h.redo();
    expect(h.doc.pages[0].frames.map((f) => f.id)).toContain(newId);
  });

  it('respects limit', () => {
    const { doc, pageId } = base();
    const h = new History(doc, { limit: 2 });
    for (const n of ['A', 'B', 'C']) h.apply([{ type: 'renamePage', pageId, name: n }]);
    expect(h.undo()).not.toBeNull();
    expect(h.undo()).not.toBeNull();
    expect(h.undo()).toBeNull();
    expect(h.doc.pages[0].name).toBe('A');
  });

  it('replace/clear empty the stacks; a failure does not change state', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    h.apply([{ type: 'renamePage', pageId, name: 'A' }]);
    const rev = h.revision;
    expect(() => h.apply([{ type: 'deleteNodes', nodeIds: ['el_zz'] }])).toThrow();
    expect(h.revision).toBe(rev);
    h.replace(createDocument('Other'));
    expect(h.canUndo).toBe(false);
    expect(h.revision).toBeGreaterThan(rev);
    h.apply([{ type: 'renamePage', pageId: h.doc.pages[0].id, name: 'Z' }]);
    h.clear();
    expect(h.canUndo).toBe(false);
  });

  it('group: consecutive applications of the same group become one entry; undo reverts them all', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    const a = createNodeFromTag('div', { isRoot: true });
    const b = createNodeFromTag('div', { isRoot: true });
    const c = createNodeFromTag('div', { isRoot: true });
    h.apply([{ type: 'createNode', pageId, node: a }], 'a', { group: 't1' });
    const r = h.apply([{ type: 'createNode', pageId, node: b }], 'b', { group: 't1' });
    expect(r.merged).toBe(true);
    h.apply([{ type: 'renameNodes', changes: [{ nodeId: a.id, name: 'A2' }] }], 'c', {
      group: 't1',
    });
    expect(h.top?.ops).toHaveLength(3);
    expect(h.doc.pages[0].frames).toHaveLength(2);
    h.undo();
    expect(strip(h.doc)).toEqual(strip(doc));
    expect(h.canUndo).toBe(false);
    h.redo();
    expect(h.doc.pages[0].frames.map((f) => f.name)).toContain('A2');
    // after undo/redo the group closes: another application of the same group is a new entry
    h.apply([{ type: 'createNode', pageId, node: c }], 'd', { group: 't1' });
    h.undo();
    expect(h.doc.pages[0].frames).toHaveLength(2);
  });

  it('group: an application without a group in the middle breaks the merge; closeGroup ends it', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    const n = () => createNodeFromTag('div', { isRoot: true });
    h.apply([{ type: 'createNode', pageId, node: n() }], undefined, { group: 'g' });
    h.apply([{ type: 'createNode', pageId, node: n() }]);
    const r = h.apply([{ type: 'createNode', pageId, node: n() }], undefined, { group: 'g' });
    expect(r.merged).toBe(false);
    h.closeGroup('g');
    const r2 = h.apply([{ type: 'createNode', pageId, node: n() }], undefined, { group: 'g' });
    expect(r2.merged).toBe(false);
    expect(h.doc.pages[0].frames).toHaveLength(4);
  });
});
