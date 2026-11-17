// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { RightDock } from './RightDock';

describe('RightDock', () => {
  beforeEach(() => {
    const { doc } = makeDoc();
    useDoc.setState({ doc, rawDoc: doc, activeDocId: doc.id, status: 'online' });
    useUi.setState({ rightTab: 'design', selection: [] });
    vi.spyOn(daemon, 'assistantHistory').mockResolvedValue({
      messages: [],
      running: null,
      backends: [],
      config: { backend: 'auto' },
    });
    vi.spyOn(daemon, 'scriptList').mockResolvedValue({ dir: null, scripts: [] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ rightTab: 'design' });
    useDoc.setState({ activeDocId: null });
  });

  it('Design (properties) stays mounted and hidden when switching tabs', async () => {
    render(<RightDock />);
    expect(screen.getByTestId('properties-panel')).toBeTruthy();
    expect(screen.queryByTestId('assistant-panel')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tab-assistant'));
    });
    expect(useUi.getState().rightTab).toBe('assistant');
    expect(screen.getByTestId('assistant-panel')).toBeTruthy();
    // properties stays in the DOM, inside a hidden container
    expect(screen.getByTestId('properties-panel').closest('[hidden]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tab-scripts'));
    });
    expect(screen.getByTestId('scripts-panel')).toBeTruthy();
    expect(screen.getByTestId('assistant-panel').closest('[hidden]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('tab-design'));
    });
    expect(screen.getByTestId('properties-panel').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('tab-design').getAttribute('aria-selected')).toBe('true');
  });
});
