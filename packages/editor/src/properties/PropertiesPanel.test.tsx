// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { PropertiesPanel } from './PropertiesPanel';

describe('PropertiesPanel', () => {
  beforeEach(() => {
    vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ selection: [] });
  });

  it('with no selection shows the document', () => {
    const { doc } = makeDoc();
    useDoc.setState({ doc });
    render(<PropertiesPanel />);
    expect(screen.getByTestId('prop-document').textContent).toContain('Test');
  });

  it("shows the frame's W and applies updateStyles", () => {
    const { doc, frame } = makeDoc();
    useDoc.setState({ doc });
    ui.select([frame.id]);
    render(<PropertiesPanel />);
    const w = document.querySelector<HTMLInputElement>('[data-testid=prop-w] input')!;
    expect(w.value).toBe('400px');
    fireEvent.focus(w);
    fireEvent.change(w, { target: { value: '500' } });
    fireEvent.blur(w);
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'updateStyles', changes: [{ nodeId: frame.id, set: { width: '500px' } }] },
    ]);
  });

  it('multi-selection shows Mixed for different values', () => {
    const { doc, a, b } = makeDoc();
    useDoc.setState({ doc });
    ui.select([a.id, b.id]);
    render(<PropertiesPanel />);
    const w = document.querySelector<HTMLInputElement>('[data-testid=prop-w] input')!;
    expect(w.placeholder).toBe('Mixed');
  });
});
