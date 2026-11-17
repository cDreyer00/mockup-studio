import { describe, expect, it } from 'vitest';
import { applyOps } from '@mockup/core';
import type { Document } from '@mockup/core';
import { buildGroupOps, buildNudgeOps, buildReorderOps, buildUngroupOps } from './actions';
import { getEntry, getNode } from './model/tree';
import { makeDoc } from './test/fixtures';

const childIds = (doc: Document, id: string) => getNode(doc, id)!.children.map((c) => c.id);

describe('actions (pure builders)', () => {
  it('nudge moves root frame and absolute child', () => {
    const { doc, frame, abs } = makeDoc();
    const next = applyOps(doc, buildNudgeOps(doc, [frame.id], 10, -5)).doc;
    expect(getNode(next, frame.id)!.position).toEqual({ x: 110, y: 45 });
    const n2 = applyOps(doc, buildNudgeOps(doc, [abs.id], 1, 1)).doc;
    expect(getNode(n2, abs.id)!.style).toMatchObject({ left: '11px', top: '21px' });
  });

  it('nudge on a child of a flex column reorders on the main axis', () => {
    const { doc, frame, a, b } = makeDoc();
    const next = applyOps(doc, buildNudgeOps(doc, [a.id], 0, 1)).doc;
    expect(childIds(next, frame.id).slice(0, 2)).toEqual([b.id, a.id]);
    expect(buildNudgeOps(doc, [a.id], 1, 0)).toEqual([]);
  });

  it('groups and ungroups preserving the order', () => {
    const { doc, frame, a, b, c } = makeDoc();
    const g = buildGroupOps(doc, [b.id, a.id])!;
    const grouped = applyOps(doc, g.ops).doc;
    expect(childIds(grouped, frame.id)[0]).toBe(g.groupId);
    expect(childIds(grouped, g.groupId)).toEqual([a.id, b.id]);
    expect(getNode(grouped, g.groupId)!.style['flex-direction']).toBe('column');
    const u = buildUngroupOps(grouped, [g.groupId])!;
    const back = applyOps(grouped, u.ops).doc;
    expect(childIds(back, frame.id)).toEqual(childIds(doc, frame.id));
    expect(getEntry(back, g.groupId)).toBeUndefined();
    expect(buildGroupOps(doc, [a.id, c.children[0]!.id])).toBeNull();
    expect(buildGroupOps(doc, [frame.id])).toBeNull();
  });

  it('reorders forward/backward', () => {
    const { doc, frame, a, abs } = makeDoc();
    const front = applyOps(doc, buildReorderOps(doc, [a.id], 'front')).doc;
    expect(childIds(front, frame.id).at(-1)).toBe(a.id);
    const back = applyOps(doc, buildReorderOps(doc, [abs.id], 'back')).doc;
    expect(childIds(back, frame.id)[0]).toBe(abs.id);
    const fwd = applyOps(doc, buildReorderOps(doc, [a.id], 'forward')).doc;
    expect(childIds(fwd, frame.id)[1]).toBe(a.id);
  });

  it('locked nodes are not affected', () => {
    const { doc, frame } = makeDoc();
    getNode(doc, frame.id)!.locked = true;
    expect(buildNudgeOps(doc, [frame.id], 1, 1)).toEqual([]);
  });
});
