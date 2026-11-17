// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemon } from '../client/daemon';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { makeDoc } from '../test/fixtures';
import { TokensPanel } from './TokensPanel';

function setup() {
  const made = makeDoc();
  made.doc.tokens = {
    '--color-primary': '#ff0000',
    '--space-4': '16px',
    '--quebrado': 'var(--nao-existe)',
  };
  made.doc.themes = [{ name: 'dark', overrides: { '--color-primary': '#00ff00' } }];
  made.a.style.background = 'var(--color-primary)';
  useDoc.setState({ doc: made.doc });
  return made;
}

const row = (slug: string) => screen.getByTestId(`token-row-${slug}`);

describe('TokensPanel', () => {
  beforeEach(() => {
    vi.spyOn(daemon, 'applySafe').mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUi.setState({ leftTab: 'layers' });
  });

  it('lista por grupo, com indicadores de não usado e de problema', () => {
    setup();
    render(<TokensPanel />);
    expect(screen.getByTestId('token-group-section-color')).toBeTruthy();
    expect(screen.getByTestId('token-group-section-spacing')).toBeTruthy();
    expect(screen.getByTestId('token-unused-space-4')).toBeTruthy();
    expect(screen.queryByTestId('token-unused-color-primary')).toBeNull();
    const problem = screen.getByTestId('token-problem-quebrado');
    expect(problem.getAttribute('title')).toMatch(/nao-existe/);
  });

  it('busca filtra por nome e valor', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.change(screen.getByTestId('tokens-search'), { target: { value: '16px' } });
    expect(screen.queryByTestId('token-row-color-primary')).toBeNull();
    expect(row('space-4')).toBeTruthy();
    fireEvent.change(screen.getByTestId('tokens-search'), { target: { value: 'zzz' } });
    expect(screen.queryByTestId('token-row-space-4')).toBeNull();
  });

  it('editar o valor: Enter confirma (setTokens), valor inválido bloqueia, Esc cancela', () => {
    setup();
    render(<TokensPanel />);
    const r = within(row('space-4'));
    fireEvent.click(r.getByTestId('token-value-space-4'));
    let input = r.getByTestId('token-value-input');
    fireEvent.change(input, { target: { value: 'rgb(1,2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(r.getByTestId('inline-error')).toBeTruthy();
    expect(daemon.applySafe).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '24px' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setTokens', set: { '--space-4': '24px' } },
    ]);
    // Esc cancela sem op
    vi.mocked(daemon.applySafe).mockClear();
    fireEvent.click(r.getByTestId('token-value-space-4'));
    input = r.getByTestId('token-value-input');
    fireEvent.change(input, { target: { value: '99px' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(daemon.applySafe).not.toHaveBeenCalled();
    expect(r.queryByTestId('token-value-input')).toBeNull();
  });

  it('duplo clique no nome renomeia (renameToken)', () => {
    setup();
    render(<TokensPanel />);
    const r = within(row('color-primary'));
    fireEvent.doubleClick(r.getByTestId('token-name-color-primary').parentElement!);
    const input = r.getByTestId('token-name-input');
    fireEvent.change(input, { target: { value: 'brand' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'renameToken', from: '--color-primary', to: '--brand' },
    ]);
  });

  it('renomear para um nome já existente mostra erro e não emite op', () => {
    setup();
    render(<TokensPanel />);
    const r = within(row('color-primary'));
    fireEvent.doubleClick(r.getByTestId('token-name-color-primary').parentElement!);
    const input = r.getByTestId('token-name-input');
    fireEvent.change(input, { target: { value: 'space-4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(daemon.applySafe).not.toHaveBeenCalled();
  });

  it('com tema selecionado, editar grava na sobrescrita e permite removê-la', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.change(screen.getByTestId('tokens-theme-select'), { target: { value: 'dark' } });
    expect(screen.getByTestId('token-override-color-primary')).toBeTruthy();
    expect(screen.queryByTestId('token-override-space-4')).toBeNull();
    const r = within(row('space-4'));
    fireEvent.click(r.getByTestId('token-value-space-4'));
    const input = r.getByTestId('token-value-input');
    fireEvent.change(input, { target: { value: '20px' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setTokens', set: { '--space-4': '20px' }, theme: 'dark' },
    ]);
    vi.mocked(daemon.applySafe).mockClear();
    fireEvent.click(screen.getByTestId('token-clear-override-color-primary'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setTokens', unset: ['--color-primary'], theme: 'dark' },
    ]);
  });

  it('cria token pelo formulário e recusa nome repetido', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('tokens-add'));
    fireEvent.change(screen.getByTestId('new-token-name'), { target: { value: 'color-primary' } });
    fireEvent.change(screen.getByTestId('new-token-value'), { target: { value: '#fff' } });
    fireEvent.click(screen.getByTestId('new-token-submit'));
    expect(screen.getByTestId('new-token-error').textContent).toMatch(/já existe/);
    fireEvent.change(screen.getByTestId('new-token-name'), { target: { value: 'color-novo' } });
    fireEvent.change(screen.getByTestId('new-token-group'), { target: { value: 'color' } });
    fireEvent.click(screen.getByTestId('new-token-submit'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setTokens', set: { '--color-novo': '#fff' } },
      { type: 'setTokenMeta', set: { '--color-novo': { group: 'color' } } },
    ]);
  });

  it('exclui token (planDeleteTokens) e edita grupo e descrição', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('token-menu-space-4'));
    const desc = screen.getByTestId('token-desc-space-4');
    fireEvent.focus(desc);
    fireEvent.change(desc, { target: { value: 'base 4' } });
    fireEvent.blur(desc);
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setTokenMeta', set: { '--space-4': { description: 'base 4' } } },
    ]);
    fireEvent.click(screen.getByTestId('token-delete-space-4'));
    expect(daemon.applySafe).toHaveBeenLastCalledWith([
      { type: 'setTokens', unset: ['--space-4'] },
    ]);
  });

  it('importar CSS mostra a análise e gera replaceTokens (mesclar)', () => {
    const { doc } = setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('tokens-import'));
    fireEvent.change(screen.getByTestId('tokens-import-text'), {
      target: { value: ':root { --novo: 4px; }' },
    });
    expect(screen.getByTestId('tokens-import-info').textContent).toContain('1 token');
    fireEvent.click(screen.getByTestId('tokens-import-confirm'));
    const ops = vi.mocked(daemon.applySafe).mock.calls[0]![0];
    expect(ops[0]).toMatchObject({ type: 'replaceTokens' });
    expect((ops[0] as { tokens: Record<string, string> }).tokens).toEqual({
      ...doc.tokens,
      '--novo': '4px',
    });
  });

  it('exportar mostra o texto no formato escolhido', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('tokens-export'));
    const area = screen.getByTestId('tokens-export-text') as HTMLTextAreaElement;
    expect(area.value).toContain('--color-primary: #ff0000');
    fireEvent.change(screen.getByTestId('tokens-export-format'), { target: { value: 'json' } });
    expect(area.value).toContain('$value');
  });
});
