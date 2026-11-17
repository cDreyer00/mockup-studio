// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeDoc, useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeBigDoc } from '../test/fixtures';
import { Canvas } from './Canvas';

afterEach(() => {
  cleanup();
  useDoc.setState({ doc: null, activeDocId: null });
  useUi.setState({ selection: [], hoverId: null, preview: {} });
});

describe('Canvas', () => {
  it('renders the frames and only updates the changed node', () => {
    const doc = makeBigDoc(2, 50);
    useDoc.setState({ doc, activeDocId: doc.id });
    const { getByTestId } = render(<Canvas />);
    const world = getByTestId('canvas-world');
    expect(world.querySelectorAll('[data-node-id]').length).toBe(100);
    expect(getByTestId(`frame-label-${doc.pages[0]!.frames[0]!.id}`)).toBeTruthy();

    const mutated = new Set<string>();
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const id = (r.target as Element).getAttribute('data-node-id');
        if (id) mutated.add(id);
      }
    });
    mo.observe(world, { subtree: true, attributes: true, childList: true, characterData: true });

    const target = doc.pages[0]!.frames[1]!.children[4]!;
    const next = structuredClone(doc);
    next.pages[0]!.frames[1]!.children[4]!.style.background = '#ff0000';
    act(() => useDoc.setState({ doc: mergeDoc(doc, next) }));
    // hover/selection do not touch the design DOM
    act(() => {
      ui.hover(target.id);
      ui.select([target.id]);
    });
    const records = mo.takeRecords();
    for (const r of records) mutated.add((r.target as Element).getAttribute('data-node-id') ?? '?');
    mo.disconnect();
    expect([...mutated]).toEqual([target.id]);
  });

  it('agent badge appears with recent activity', () => {
    const doc = makeBigDoc(1, 5);
    const frame = doc.pages[0]!.frames[0]!;
    useDoc.setState({ doc, activeDocId: doc.id, agentActivity: { [frame.id]: Date.now() } });
    const { queryByTestId } = render(<Canvas />);
    expect(queryByTestId(`agent-badge-${frame.id}`)).toBeTruthy();
    act(() => useDoc.setState({ agentActivity: { [frame.id]: Date.now() - 5000 } }));
    expect(queryByTestId(`agent-badge-${frame.id}`)).toBeNull();
    useDoc.setState({ agentActivity: {} });
  });
});
