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
  it('apply/undo/redo e revision', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    expect(h.canUndo).toBe(false);
    const frame = createNodeFromTag('div', { isRoot: true });
    const r = h.apply([{ type: 'createNode', pageId, node: frame }], 'criar');
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

  it('nova ação limpa a pilha de redo', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    h.apply([{ type: 'renamePage', pageId, name: 'A' }]);
    h.undo();
    h.apply([{ type: 'renamePage', pageId, name: 'B' }]);
    expect(h.canRedo).toBe(false);
  });

  it('duplicate: redo mantém os mesmos ids', () => {
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

  it('respeita limit', () => {
    const { doc, pageId } = base();
    const h = new History(doc, { limit: 2 });
    for (const n of ['A', 'B', 'C']) h.apply([{ type: 'renamePage', pageId, name: n }]);
    expect(h.undo()).not.toBeNull();
    expect(h.undo()).not.toBeNull();
    expect(h.undo()).toBeNull();
    expect(h.doc.pages[0].name).toBe('A');
  });

  it('replace/clear limpam as pilhas; falha não altera estado', () => {
    const { doc, pageId } = base();
    const h = new History(doc);
    h.apply([{ type: 'renamePage', pageId, name: 'A' }]);
    const rev = h.revision;
    expect(() => h.apply([{ type: 'deleteNodes', nodeIds: ['el_zz'] }])).toThrow();
    expect(h.revision).toBe(rev);
    h.replace(createDocument('Outro'));
    expect(h.canUndo).toBe(false);
    expect(h.revision).toBeGreaterThan(rev);
    h.apply([{ type: 'renamePage', pageId: h.doc.pages[0].id, name: 'Z' }]);
    h.clear();
    expect(h.canUndo).toBe(false);
  });
});
