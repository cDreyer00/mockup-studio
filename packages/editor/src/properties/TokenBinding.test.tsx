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

  it('valor var(--x) vira chip com nome e valor resolvido', () => {
    setup({ background: 'var(--color-primary)' });
    render(<PropertiesPanel />);
    expect(screen.getByTestId('token-chip-name').textContent).toBe('--color-primary');
    expect(screen.getByTestId('token-chip-value').textContent).toBe('#ff0000');
  });

  it('chip mostra o valor do tema declarado no frame', () => {
    const { frame } = setup({ background: 'var(--color-primary)' });
    frame.attrs['data-theme'] = 'dark';
    render(<PropertiesPanel />);
    expect(screen.getByTestId('token-chip-value').textContent).toBe('#00ff00');
  });

  it('escolher um token no seletor grava var(--token) via updateStyles', () => {
    const { frame } = setup();
    render(<PropertiesPanel />);
    const w = document.querySelector('[data-testid=prop-w]')!;
    fireEvent.click(w.querySelector('[data-testid=token-bind]')!);
    expect(screen.getByTestId('token-picker')).toBeTruthy();
    // largura = espaçamento: não oferece cores
    expect(screen.queryByTestId('token-option-color-primary')).toBeNull();
    fireEvent.click(screen.getByTestId('token-option-space-4'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'updateStyles', changes: [{ nodeId: frame.id, set: { width: 'var(--space-4)' } }] },
    ]);
    expect(screen.queryByTestId('token-picker')).toBeNull();
  });

  it('o seletor de cor filtra tokens de cor, a busca refina e "Todos" mostra o resto', () => {
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

  it('desligar grava o valor resolvido literal', () => {
    const { frame } = setup({ width: 'var(--ref)' });
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByTestId('token-unbind'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'updateStyles', changes: [{ nodeId: frame.id, set: { width: '16px' } }] },
    ]);
  });

  it('linha Tema troca o data-theme do nó (planSetFrameTheme)', () => {
    const { frame } = setup();
    render(<PropertiesPanel />);
    const select = document.querySelector<HTMLSelectElement>('[data-testid=prop-theme] select')!;
    fireEvent.change(select, { target: { value: 'dark' } });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setAttrs', changes: [{ nodeId: frame.id, set: { 'data-theme': 'dark' } }] },
    ]);
  });

  it('mostra o tema herdado quando o nó não declara', () => {
    const { frame, a } = setup();
    frame.attrs['data-theme'] = 'dark';
    ui.select([a.id]);
    render(<PropertiesPanel />);
    const select = document.querySelector<HTMLSelectElement>('[data-testid=prop-theme] select')!;
    expect(select.options[0]!.textContent).toBe('Herdado (dark)');
  });
});
