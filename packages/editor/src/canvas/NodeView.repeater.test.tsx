// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { baseNodeId, createNodeFromTag, createRepeaterFrom } from '@mockup/core';
import type { Node } from '@mockup/core';
import { ui, useUi } from '../state/uiStore';
import { NodeView, withRawEditing } from './NodeView';

afterEach(() => {
  cleanup();
  useUi.setState({ editingTextId: null, preview: {} });
});

function makeRepeater(count: number): { rep: Node; title: Node } {
  const title = createNodeFromTag('p', { name: 'Título', text: 'Olá {{nome}} #{{$number}}' });
  const card = createNodeFromTag('div', { name: 'Card', children: [title] });
  const holder = createNodeFromTag('section', { name: 'Lista', children: [card] });
  const data = Array.from({ length: count }, (_, i) => ({ nome: `Pessoa ${i}` }));
  return { rep: createRepeaterFrom(holder, data), title };
}

describe('NodeView: repetidor', () => {
  it('20 itens geram 20 cópias do template com o id do template', () => {
    const { rep, title } = makeRepeater(20);
    const card = rep.children[0]!;
    const { container } = render(<NodeView node={rep} />);
    expect(container.querySelectorAll(`[data-node-id="${card.id}"]`)).toHaveLength(20);
    const titles = container.querySelectorAll(`[data-node-id="${title.id}"]`);
    expect(titles).toHaveLength(20);
    expect(titles[0]!.textContent).toBe('Olá Pessoa 0 #1');
    expect(titles[19]!.textContent).toBe('Olá Pessoa 19 #20');
    // nenhum id expandido (com ~) chega ao DOM
    expect(container.innerHTML).not.toContain('~');
  });

  it('o repetidor renderiza como o contêiner (tag e id próprios)', () => {
    const { rep } = makeRepeater(2);
    const { container } = render(<NodeView node={rep} />);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe('SECTION');
    expect(el.getAttribute('data-node-id')).toBe(rep.id);
  });

  it('sem dados mostra o template uma vez', () => {
    const { rep, title } = makeRepeater(0);
    const { container } = render(<NodeView node={rep} />);
    expect(container.querySelectorAll(`[data-node-id="${title.id}"]`)).toHaveLength(1);
  });

  it('a prévia do template vale para todas as cópias', () => {
    const { rep, title } = makeRepeater(3);
    ui.setPreview({ [title.id]: { style: { color: 'rgb(255, 0, 0)' } } });
    const { container } = render(<NodeView node={rep} />);
    const els = container.querySelectorAll<HTMLElement>(`[data-node-id="${title.id}"]`);
    expect([...els].map((e) => e.style.color)).toEqual(Array(3).fill('rgb(255, 0, 0)'));
  });

  it('edição inline mostra o texto cru só no item 0', () => {
    const { rep, title } = makeRepeater(3);
    ui.editText(title.id);
    const { container } = render(<NodeView node={rep} />);
    const editors = container.querySelectorAll('[data-testid="text-editor"]');
    expect(editors).toHaveLength(1);
    expect(editors[0]!.textContent).toBe('Olá {{nome}} #{{$number}}');
    expect(container.textContent).toContain('Olá Pessoa 1 #2');
  });

  it('withRawEditing troca só o item 0 pelo nó cru', () => {
    const { rep, title } = makeRepeater(2);
    const out = withRawEditing(rep, title.id);
    expect(out.map((n) => baseNodeId(n.id))).toEqual([rep.children[0]!.id, rep.children[0]!.id]);
    expect(out[0]!.children[0]!.text).toBe(title.text);
    expect(out[1]!.children[0]!.text).toBe('Olá Pessoa 1 #2');
  });
});
