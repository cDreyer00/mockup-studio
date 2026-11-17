import { describe, expect, it } from 'vitest';
import { applyOp } from '@mockup/core';
import { makeDoc } from '../test/fixtures';
import { shareStructure } from './share';

describe('shareStructure', () => {
  it('reuses equal subtrees and replaces only the changed path', () => {
    const { doc, a, b } = makeDoc();
    const next = applyOp(doc, {
      type: 'updateStyles',
      nodeIds: [a.id],
      styles: { width: '20px' },
    }).doc;
    const shared = shareStructure(doc, next);
    const f0 = doc.pages[0]!.frames[0]!;
    const f1 = shared.pages[0]!.frames[0]!;
    expect(f1).not.toBe(f0);
    expect(f1.children[0]).not.toBe(f0.children[0]);
    expect(f1.children[0]!.style.width).toBe('20px');
    expect(f1.children[1]).toBe(f0.children[1]);
    expect(f1.children[1]!.id).toBe(b.id);
    expect(shared.tokens).toBe(doc.tokens);
  });

  it('returns the previous one when nothing changed', () => {
    const { doc } = makeDoc();
    expect(shareStructure(doc, JSON.parse(JSON.stringify(doc)))).toBe(doc);
  });

  it('detects removed keys', () => {
    expect(shareStructure({ a: 1, b: 2 } as Record<string, number>, { a: 1 })).toEqual({ a: 1 });
  });
});
