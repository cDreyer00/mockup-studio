// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createNode, createNodeFromTag } from '@mockup/core';
import type { Node } from '@mockup/core';
import { daemon } from '../client/daemon';
import type { ApplyAck } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { NodeView, RenderDocContext } from './NodeView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useUi.setState({ editingTextId: null });
});

function editText(node: Node, typed: string): HTMLElement {
  ui.editText(node.id);
  render(<NodeView node={node} />);
  const el = screen.getByTestId('text-editor');
  el.textContent = typed;
  fireEvent.keyDown(el, { key: 'Enter' });
  return el;
}

const ack = { revision: 1 } as unknown as ApplyAck;

describe('NodeView: edição de texto inline', () => {
  it('texto com quebra de linha inclui white-space: pre-wrap na mesma chamada', async () => {
    const apply = vi.spyOn(daemon, 'applySafe').mockResolvedValue(ack);
    const node = createNodeFromTag('p', { text: 'a' });
    editText(node, 'linha 1\nlinha 2');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([
      { type: 'setText', changes: [{ nodeId: node.id, text: 'linha 1\nlinha 2' }] },
      { type: 'updateStyles', changes: [{ nodeId: node.id, set: { 'white-space': 'pre-wrap' } }] },
    ]);
    await act(async () => {});
    expect(useUi.getState().editingTextId).toBeNull();
  });

  it('não mexe em white-space já definido nem em texto de uma linha', () => {
    const apply = vi.spyOn(daemon, 'applySafe').mockResolvedValue(ack);
    const node = createNodeFromTag('p', { text: 'a', styles: { 'white-space': 'pre' } });
    editText(node, 'x\ny');
    expect(apply.mock.calls[0]![0]).toHaveLength(1);
    cleanup();
    const plain = createNodeFromTag('p', { text: 'a' });
    editText(plain, 'só uma');
    expect(apply.mock.calls[1]![0]).toEqual([
      { type: 'setText', changes: [{ nodeId: plain.id, text: 'só uma' }] },
    ]);
  });

  it('se o setText falhar, a edição continua aberta e pode confirmar de novo', async () => {
    const apply = vi.spyOn(daemon, 'applySafe').mockResolvedValueOnce(null).mockResolvedValue(ack);
    const node = createNodeFromTag('p', { text: 'a' });
    const el = editText(node, 'novo');
    await act(async () => {});
    expect(useUi.getState().editingTextId).toBe(node.id);
    expect(el.textContent).toBe('novo');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(apply).toHaveBeenCalledTimes(2);
    await act(async () => {});
    expect(useUi.getState().editingTextId).toBeNull();
  });
});

describe('NodeView: SVG com var()', () => {
  const svgNode = createNode({
    tag: 'svg',
    id: 'sv_icon0001',
    name: 'Ícone',
    svg: '<svg width="4" height="4"><circle r="2" style="fill:var(--brand)"/></svg>',
  });
  const docWith = (theme?: string) => {
    const doc = createDocument('Teste', { id: 'doc_svgvar01' });
    doc.tokens = { '--brand': '#111111' };
    doc.themes = [{ name: 'dark', overrides: { '--brand': '#eeeeee' } }];
    doc.pages[0].frames.push(
      createNode({
        tag: 'div',
        type: 'frame',
        id: 'fr_root0001',
        name: 'Raiz',
        attrs: theme ? { 'data-theme': theme } : {},
        children: [svgNode],
      }),
    );
    return doc;
  };
  const markup = () => {
    const src = (document.querySelector('[data-node-id="sv_icon0001"]') as HTMLImageElement).src;
    return decodeURIComponent(src.slice(src.indexOf(',') + 1));
  };

  afterEach(() => useDoc.setState({ doc: null }));

  it('na página de render usa o documento do contexto e o tema do frame', () => {
    render(
      <RenderDocContext.Provider value={docWith('dark')}>
        <NodeView node={svgNode} />
      </RenderDocContext.Provider>,
    );
    expect(markup()).toContain('fill:#eeeeee');
    expect(markup()).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('no canvas lê do store e acompanha a troca de tema sem mudar o nó', () => {
    useDoc.setState({ doc: docWith() });
    render(<NodeView node={svgNode} />);
    expect(markup()).toContain('fill:#111111');
    act(() => useDoc.setState({ doc: docWith('dark') }));
    expect(markup()).toContain('fill:#eeeeee');
  });
});
