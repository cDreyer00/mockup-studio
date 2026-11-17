import { createNodeFromTag, type EffectParamDef } from '@mockup/core';
import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import { buildEffectInsertOps, resolveEffectTarget } from './insert';
import { parseParamValue, snapNumber, withParam } from './params';

describe('buildEffectInsertOps', () => {
  it('background: createNode at index 0 and parent with position/isolation in a single apply', () => {
    const { doc, frame } = makeDoc();
    const plan = buildEffectInsertOps(doc, frame.id, 'mesh-gradient', { speed: 1 })!;
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0]).toEqual({
      type: 'updateStyles',
      changes: [{ nodeId: frame.id, set: { position: 'relative', isolation: 'isolate' } }],
    });
    const create = plan.ops[1]!;
    expect(create.type).toBe('createNode');
    if (create.type !== 'createNode') return;
    expect(create.index).toBe(0);
    expect(create.parentId).toBe(frame.id);
    expect(create.node.id).toBe(plan.nodeId);
    expect(create.node.effect).toEqual({ kind: 'mesh-gradient', params: { speed: 1 } });
    expect(create.node.style['z-index']).toBe('-1');
    expect(create.node.style.inset).toBe('0');
  });

  it('does not repeat what the parent already has', () => {
    const { doc, frame } = makeDoc();
    frame.style.position = 'absolute';
    frame.style.isolation = 'isolate';
    const plan = buildEffectInsertOps(doc, frame.id, 'grain', {})!;
    expect(plan.ops.map((o) => o.type)).toEqual(['createNode']);
  });

  it('only fills in what is missing', () => {
    const { doc, frame } = makeDoc();
    frame.style.position = 'fixed';
    const plan = buildEffectInsertOps(doc, frame.id, 'grain', {})!;
    expect(plan.ops[0]).toEqual({
      type: 'updateStyles',
      changes: [{ nodeId: frame.id, set: { isolation: 'isolate' } }],
    });
  });

  it('layer: 100% x 240px in flow, without touching the parent or index', () => {
    const { doc, frame } = makeDoc();
    const plan = buildEffectInsertOps(doc, frame.id, 'grain', {}, { asLayer: true })!;
    expect(plan.ops).toHaveLength(1);
    const create = plan.ops[0]!;
    if (create.type !== 'createNode') throw new Error('expected createNode');
    expect(create.index).toBeUndefined();
    expect(create.node.style.width).toBe('100%');
    expect(create.node.style.height).toBe('240px');
    expect(create.node.style.position).toBeUndefined();
  });

  it('nonexistent target returns null', () => {
    const { doc } = makeDoc();
    expect(buildEffectInsertOps(doc, 'nope', 'grain', {})).toBeNull();
  });
});

describe('resolveEffectTarget', () => {
  it('frame/element directly; leaf goes to its frame; with no selection, first frame', () => {
    const { doc, frame, a, b } = makeDoc();
    const pageId = doc.pages[0]!.id;
    expect(resolveEffectTarget(doc, [a.id], pageId)).toBe(a.id);
    expect(resolveEffectTarget(doc, [b.id], pageId)).toBe(frame.id);
    expect(resolveEffectTarget(doc, [], pageId)).toBe(frame.id);
    expect(resolveEffectTarget(doc, [], null)).toBe(frame.id);
  });
  it('without frames there is no target', () => {
    const { doc } = makeDoc();
    doc.pages[0]!.frames = [];
    expect(resolveEffectTarget(doc, [], null)).toBeNull();
  });
  it('selected effect node falls back to the frame', () => {
    const { doc, frame } = makeDoc();
    const fx = createNodeFromTag('div', { name: 'x' });
    fx.type = 'effect';
    frame.children.push(fx);
    expect(resolveEffectTarget(doc, [fx.id], null)).toBe(frame.id);
  });
});

describe('params', () => {
  const num = {
    name: 'speed',
    label: 'V',
    type: 'number',
    default: 1,
    min: 0,
    max: 3,
    step: 0.1,
    description: '',
  } as const;
  it('snapNumber rounds to the step and clamps', () => {
    expect(snapNumber(num, 0.3000000004)).toBe(0.3);
    expect(snapNumber(num, 9)).toBe(3);
    expect(snapNumber(num, -2)).toBe(0);
  });
  it('parseParamValue by type', () => {
    expect(parseParamValue(num, '1,25')).toBe(1.3);
    expect(parseParamValue(num, 'abc')).toBeNull();
    expect(parseParamValue(num, '')).toBeNull();
    const color = { ...num, type: 'color', default: '#fff' } as const;
    expect(parseParamValue(color, '#ABCDEF')).toBe('#abcdef');
    expect(parseParamValue(color, 'red')).toBeNull();
    const sel: EffectParamDef = { ...num, type: 'select', options: ['a', 'b'], default: 'a' };
    expect(parseParamValue(sel, 'b')).toBe('b');
    expect(parseParamValue(sel, 'c')).toBeNull();
  });
  it('withParam does not mutate', () => {
    const p = { a: 1 };
    expect(withParam(p, 'b', 2)).toEqual({ a: 1, b: 2 });
    expect(p).toEqual({ a: 1 });
  });
});
