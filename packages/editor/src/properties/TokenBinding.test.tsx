// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { ui, useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { PropertiesPanel } from './PropertiesPanel';

function setup(style: Record<string, string> = {}) {
  const made = makeDoc();
  made.doc.tokens = {
    '--color-primary': '#ff0000',
    '--color-dark': '#111111',
    '--space-4': '16px',
    '--ref': 'var(--space-4)',
  };
  made.doc.themes = [{ name: 'dark', overrides: { '--color-primary': '#00ff00' } }];
  Object.assign(made.frame.style, style);
  useDoc.setState({ doc: made.doc });
  ui.select([made.frame.id]);
  return made;
}

describe('TokenBinding', () => {
  beforeEach(() => {
    vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ selection: [] });
  });

  it('a var(--x) value becomes a chip with name and resolved value', () => {
    setup({ background: 'var(--color-primary)' });
    render(<PropertiesPanel />);
    expect(screen.getByTestId('token-chip-name').textContent).toBe('--color-primary');
    expect(screen.getByTestId('token-chip-value').textContent).toBe('#ff0000');
  });

  it('chip shows the value of the theme declared on the frame', () => {
    const { frame } = setup({ background: 'var(--color-primary)' });
    frame.attrs['data-theme'] = 'dark';
    render(<PropertiesPanel />);
    expect(screen.getByTestId('token-chip-value').textContent).toBe('#00ff00');
  });

  it('choosing a token in the picker writes var(--token) via updateStyles', () => {
    const { frame } = setup();
    render(<PropertiesPanel />);
    const w = document.querySelector('[data-testid=prop-w]')!;
    fireEvent.click(w.querySelector('[data-testid=token-bind]')!);
    expect(screen.getByTestId('token-picker')).toBeTruthy();
    // width = spacing: does not offer colors
    expect(screen.queryByTestId('token-option-color-primary')).toBeNull();
    fireEvent.click(screen.getByTestId('token-option-space-4'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'updateStyles', changes: [{ nodeId: frame.id, set: { width: 'var(--space-4)' } }] },
    ]);
    expect(screen.queryByTestId('token-picker')).toBeNull();
  });

  it('the color picker filters color tokens, search narrows and "All" shows the rest', () => {
    setup();
    render(<PropertiesPanel />);
    const bg = document.querySelector('.prop-bg')!;
    fireEvent.click(bg.querySelector('[data-testid=token-bind]')!);
    expect(screen.queryByTestId('token-option-space-4')).toBeNull();
    expect(screen.getByTestId('token-option-color-primary')).toBeTruthy();
    fireEvent.change(screen.getByTestId('token-picker-search'), { target: { value: 'dark' } });
    expect(screen.queryByTestId('token-option-color-primary')).toBeNull();
    fireEvent.change(screen.getByTestId('token-picker-search'), { target: { value: 'space' } });
    expect(screen.queryByTestId('token-option-space-4')).toBeNull();
    fireEvent.click(screen.getByTestId('token-picker-all'));
    expect(screen.getByTestId('token-option-space-4')).toBeTruthy();
    fireEvent.change(screen.getByTestId('token-picker-search'), { target: { value: 'dark' } });
    fireEvent.click(screen.getByTestId('token-option-color-dark'));
    expect(JSON.stringify(vi.mocked(daemon.applySafe).mock.calls.at(-1))).toContain(
      '"background":"var(--color-dark)"',
    );
  });

  it('unbinding writes the literal resolved value', () => {
    const { frame } = setup({ width: 'var(--ref)' });
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('token-unbind'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'updateStyles', changes: [{ nodeId: frame.id, set: { width: '16px' } }] },
    ]);
  });

  it("Theme row changes the node's data-theme (planSetFrameTheme)", () => {
    const { frame } = setup();
    render(<PropertiesPanel />);
    const select = document.querySelector<HTMLSelectElement>('[data-testid=prop-theme] select')!;
    fireEvent.change(select, { target: { value: 'dark' } });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setAttrs', changes: [{ nodeId: frame.id, set: { 'data-theme': 'dark' } }] },
    ]);
  });

  it("shows the inherited theme when the node doesn't declare one", () => {
    const { frame, a } = setup();
    frame.attrs['data-theme'] = 'dark';
    ui.select([a.id]);
    render(<PropertiesPanel />);
    const select = document.querySelector<HTMLSelectElement>('[data-testid=prop-theme] select')!;
    expect(select.options[0]!.textContent).toBe('Inherited (dark)');
  });
});
