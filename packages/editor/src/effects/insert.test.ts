import { createNodeFromTag, type EffectParamDef } from '@mockup/core';
import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import { buildEffectInsertOps, resolveEffectTarget } from './insert';
import { parseParamValue, snapNumber, withParam } from './params';

describe('buildEffectInsertOps', () => {
  it('fundo: createNode no índice 0 e pai com position/isolation num único apply', () => {
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

  it('não repete o que o pai já tem', () => {
    const { doc, frame } = makeDoc();
    frame.style.position = 'absolute';
    frame.style.isolation = 'isolate';
    const plan = buildEffectInsertOps(doc, frame.id, 'grain', {})!;
    expect(plan.ops.map((o) => o.type)).toEqual(['createNode']);
  });

  it('só completa o que falta', () => {
    const { doc, frame } = makeDoc();
    frame.style.position = 'fixed';
    const plan = buildEffectInsertOps(doc, frame.id, 'grain', {})!;
    expect(plan.ops[0]).toEqual({
      type: 'updateStyles',
      changes: [{ nodeId: frame.id, set: { isolation: 'isolate' } }],
    });
  });

  it('camada: 100% x 240px no fluxo, sem mexer no pai nem índice', () => {
    const { doc, frame } = makeDoc();
    const plan = buildEffectInsertOps(doc, frame.id, 'grain', {}, { asLayer: true })!;
    expect(plan.ops).toHaveLength(1);
    const create = plan.ops[0]!;
    if (create.type !== 'createNode') throw new Error('esperado createNode');
    expect(create.index).toBeUndefined();
    expect(create.node.style.width).toBe('100%');
    expect(create.node.style.height).toBe('240px');
    expect(create.node.style.position).toBeUndefined();
  });

  it('alvo inexistente devolve null', () => {
    const { doc } = makeDoc();
    expect(buildEffectInsertOps(doc, 'nope', 'grain', {})).toBeNull();
  });
});

describe('resolveEffectTarget', () => {
  it('frame/element direto; folha vai para o frame; sem seleção, primeiro frame', () => {
    const { doc, frame, a, b } = makeDoc();
    const pageId = doc.pages[0]!.id;
    expect(resolveEffectTarget(doc, [a.id], pageId)).toBe(a.id);
    expect(resolveEffectTarget(doc, [b.id], pageId)).toBe(frame.id);
    expect(resolveEffectTarget(doc, [], pageId)).toBe(frame.id);
    expect(resolveEffectTarget(doc, [], null)).toBe(frame.id);
  });
  it('sem frames não há alvo', () => {
    const { doc } = makeDoc();
    doc.pages[0]!.frames = [];
    expect(resolveEffectTarget(doc, [], null)).toBeNull();
  });
  it('nó de efeito selecionado cai no frame', () => {
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
  it('snapNumber arredonda ao passo e limita', () => {
    expect(snapNumber(num, 0.3000000004)).toBe(0.3);
    expect(snapNumber(num, 9)).toBe(3);
    expect(snapNumber(num, -2)).toBe(0);
  });
  it('parseParamValue por tipo', () => {
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
  it('withParam não muta', () => {
    const p = { a: 1 };
    expect(withParam(p, 'b', 2)).toEqual({ a: 1, b: 2 });
    expect(p).toEqual({ a: 1 });
  });
});
