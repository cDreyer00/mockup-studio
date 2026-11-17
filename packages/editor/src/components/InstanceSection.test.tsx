// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOp } from '@mockup/core';
import type { Document, Op, PropDef } from '@mockup/core';
import { daemon } from '../client/daemon';
import { getNode } from '../model/tree';
import { PropertiesPanel } from '../properties/PropertiesPanel';
import { useDoc, withView } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeComponentDoc } from '../test/fixtures';
import { InstanceSection } from './InstanceSection';

const PROPS: PropDef[] = [
  { name: 'label', type: 'string', default: '' },
  { name: 'variant', type: 'enum', options: ['default', 'outline'], default: 'default' },
  { name: 'count', type: 'number', default: 1 },
  { name: 'active', type: 'boolean', default: false },
  { name: 'tint', type: 'color', default: '#000000' },
  { name: 'content', type: 'slot' },
];

let apply: ReturnType<typeof vi.spyOn>;
const lastOps = (): Op[] => apply.mock.calls.at(-1)![0] as Op[];

function setup(): { doc: Document; ids: string[]; textId: string } {
  const f = makeComponentDoc();
  const doc = applyOp(f.doc, {
    type: 'updateComponent',
    componentId: f.componentId,
    props: PROPS,
  }).doc;
  useDoc.setState(withView(doc));
  return { doc, ids: f.instanceIds, textId: f.main.textId };
}

const field = (name: string): HTMLElement => screen.getByTestId(`instance-prop-${name}`);

beforeEach(() => {
  apply = vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUi.setState({ selection: [] });
  useDoc.setState({ doc: null, rawDoc: null });
});

describe('InstanceSection', () => {
  it('aparece no painel para a instância selecionada, com o nome do componente', () => {
    const { ids } = setup();
    ui.select([ids[1]!]);
    render(<PropertiesPanel />);
    expect(screen.getByTestId('instance-component-name').textContent).toBe('Card');
    expect(screen.getByTestId('instance-slot-content')).toBeTruthy();
  });

  it('cada tipo de prop tem o controle certo e gera setInstanceProps', () => {
    const { ids } = setup();
    const id = ids[1]!;
    const node = getNode(useDoc.getState().doc!, id)!;
    render(<InstanceSection node={node} />);

    // string
    const label = field('label').querySelector('input')!;
    expect(label.value).toBe('B');
    fireEvent.focus(label);
    fireEvent.change(label, { target: { value: 'Salvar' } });
    fireEvent.blur(label);
    expect(lastOps()).toEqual([
      { type: 'setInstanceProps', changes: [{ nodeId: id, set: { label: 'Salvar' } }] },
    ]);

    // enum (select); voltar ao padrão remove a prop
    const select = field('variant').querySelector('select')!;
    fireEvent.change(select, { target: { value: 'outline' } });
    expect(lastOps()).toEqual([
      { type: 'setInstanceProps', changes: [{ nodeId: id, set: { variant: 'outline' } }] },
    ]);
    fireEvent.change(select, { target: { value: 'default' } });
    expect(lastOps()).toEqual([
      { type: 'setInstanceProps', changes: [{ nodeId: id, unset: ['variant'] }] },
    ]);

    // number
    const num = field('count').querySelector('input')!;
    fireEvent.focus(num);
    fireEvent.change(num, { target: { value: '3' } });
    fireEvent.blur(num);
    expect(lastOps()).toEqual([
      { type: 'setInstanceProps', changes: [{ nodeId: id, set: { count: 3 } }] },
    ]);

    // boolean
    const toggle = field('active').querySelector<HTMLInputElement>('input[type=checkbox]')!;
    fireEvent.click(toggle);
    expect(lastOps()).toEqual([
      { type: 'setInstanceProps', changes: [{ nodeId: id, set: { active: true } }] },
    ]);

    // color (texto do ColorInput)
    const color = field('tint').querySelector<HTMLInputElement>('input.text-input')!;
    fireEvent.focus(color);
    fireEvent.change(color, { target: { value: '#ff0000' } });
    fireEvent.blur(color);
    expect(lastOps()).toEqual([
      { type: 'setInstanceProps', changes: [{ nodeId: id, set: { tint: '#ff0000' } }] },
    ]);
  });

  it('Restaurar e Enviar ao principal só com overrides; Destacar gera replaceNode', () => {
    const { doc, ids, textId } = setup();
    const id = ids[0]!;
    render(<InstanceSection node={getNode(useDoc.getState().doc!, id)!} />);
    expect(screen.getByTestId<HTMLButtonElement>('instance-reset').disabled).toBe(true);
    expect(screen.getByTestId<HTMLButtonElement>('instance-push').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('instance-detach'));
    expect(lastOps()[0]!.type).toBe('replaceNode');
    cleanup();

    // Com um override no texto da instância, os dois botões ficam ativos.
    const withOv = applyOp(doc, {
      type: 'setInstanceOverrides',
      changes: [{ nodeId: id, overrides: { [textId]: { text: 'Outro' } } }],
    }).doc;
    useDoc.setState(withView(withOv));
    render(<InstanceSection node={getNode(useDoc.getState().doc!, id)!} />);
    expect(screen.getByTestId<HTMLButtonElement>('instance-reset').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('instance-reset'));
    expect(lastOps()).toEqual([
      { type: 'setInstanceOverrides', changes: [{ nodeId: id, overrides: null }] },
    ]);
    fireEvent.click(screen.getByTestId('instance-push'));
    expect(lastOps().map((o) => o.type)).toEqual(['updateComponent', 'setInstanceOverrides']);
  });
});
