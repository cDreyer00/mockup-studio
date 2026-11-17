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
  const title = createNodeFromTag('p', { name: 'Title', text: 'Hello {{name}} #{{$number}}' });
  const card = createNodeFromTag('div', { name: 'Card', children: [title] });
  const holder = createNodeFromTag('section', { name: 'Lista', children: [card] });
  const data = Array.from({ length: count }, (_, i) => ({ name: `Person ${i}` }));
  return { rep: createRepeaterFrom(holder, data), title };
}

describe('NodeView: repeater', () => {
  it('20 items generate 20 copies of the template with the template id', () => {
    const { rep, title } = makeRepeater(20);
    const card = rep.children[0]!;
    const { container } = render(<NodeView node={rep} />);
    expect(container.querySelectorAll(`[data-node-id="${card.id}"]`)).toHaveLength(20);
    const titles = container.querySelectorAll(`[data-node-id="${title.id}"]`);
    expect(titles).toHaveLength(20);
    expect(titles[0]!.textContent).toBe('Hello Person 0 #1');
    expect(titles[19]!.textContent).toBe('Hello Person 19 #20');
    // no expanded id (with ~) reaches the DOM
    expect(container.innerHTML).not.toContain('~');
  });

  it('the repeater renders as the container (own tag and id)', () => {
    const { rep } = makeRepeater(2);
    const { container } = render(<NodeView node={rep} />);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe('SECTION');
    expect(el.getAttribute('data-node-id')).toBe(rep.id);
  });

  it('without data shows the template once', () => {
    const { rep, title } = makeRepeater(0);
    const { container } = render(<NodeView node={rep} />);
    expect(container.querySelectorAll(`[data-node-id="${title.id}"]`)).toHaveLength(1);
  });

  it('the template preview applies to all copies', () => {
    const { rep, title } = makeRepeater(3);
    ui.setPreview({ [title.id]: { style: { color: 'rgb(255, 0, 0)' } } });
    const { container } = render(<NodeView node={rep} />);
    const els = container.querySelectorAll<HTMLElement>(`[data-node-id="${title.id}"]`);
    expect([...els].map((e) => e.style.color)).toEqual(Array(3).fill('rgb(255, 0, 0)'));
  });

  it('inline editing shows the raw text only on item 0', () => {
    const { rep, title } = makeRepeater(3);
    ui.editText(title.id);
    const { container } = render(<NodeView node={rep} />);
    const editors = container.querySelectorAll('[data-testid="text-editor"]');
    expect(editors).toHaveLength(1);
    expect(editors[0]!.textContent).toBe('Hello {{name}} #{{$number}}');
    expect(container.textContent).toContain('Hello Person 1 #2');
  });

  it('withRawEditing swaps only item 0 for the raw node', () => {
    const { rep, title } = makeRepeater(2);
    const out = withRawEditing(rep, title.id);
    expect(out.map((n) => baseNodeId(n.id))).toEqual([rep.children[0]!.id, rep.children[0]!.id]);
    expect(out[0]!.children[0]!.text).toBe(title.text);
    expect(out[1]!.children[0]!.text).toBe('Hello Person 1 #2');
  });
});
