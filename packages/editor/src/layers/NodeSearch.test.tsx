// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { NodeSearch } from './NodeSearch';

describe('NodeSearch', () => {
  beforeEach(() => {
    const { doc } = makeDoc();
    useDoc.setState({ doc });
  });
  afterEach(() => {
    cleanup();
    useDoc.setState({ doc: null });
    useUi.setState({ selection: [] });
  });

  it('finds by text and selects on click', async () => {
    render(<NodeSearch />);
    fireEvent.change(screen.getByTestId('node-search-input'), { target: { value: 'c1' } });
    const results = await screen.findAllByTestId('node-search-result');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.textContent).toContain('C1');
    fireEvent.click(results[0]!);
    expect(useUi.getState().selection).toHaveLength(1);
    expect(useUi.getState().focusRequest?.nodeIds).toEqual(useUi.getState().selection);
  });

  it('filters by tag:', async () => {
    render(<NodeSearch />);
    fireEvent.change(screen.getByTestId('node-search-input'), { target: { value: 'tag:p' } });
    await waitFor(() => expect(screen.getAllByTestId('node-search-result')).toHaveLength(1));
    expect(screen.getByTestId('node-search-result').textContent).toContain('B');
  });

  it('shows a notice when there are no results', async () => {
    render(<NodeSearch />);
    fireEvent.change(screen.getByTestId('node-search-input'), { target: { value: 'zzzxxx' } });
    expect(await screen.findByText('No nodes found.')).toBeTruthy();
  });
});
