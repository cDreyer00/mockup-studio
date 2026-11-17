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
    '--broken': 'var(--does-not-exist)',
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

  it('lists by group, with unused and problem indicators', () => {
    setup();
    render(<TokensPanel />);
    expect(screen.getByTestId('token-group-section-color')).toBeTruthy();
    expect(screen.getByTestId('token-group-section-spacing')).toBeTruthy();
    expect(screen.getByTestId('token-unused-space-4')).toBeTruthy();
    expect(screen.queryByTestId('token-unused-color-primary')).toBeNull();
    const problem = screen.getByTestId('token-problem-broken');
    expect(problem.getAttribute('title')).toMatch(/does-not-exist/);
  });

  it('search filters by name and value', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.change(screen.getByTestId('tokens-search'), { target: { value: '16px' } });
    expect(screen.queryByTestId('token-row-color-primary')).toBeNull();
    expect(row('space-4')).toBeTruthy();
    fireEvent.change(screen.getByTestId('tokens-search'), { target: { value: 'zzz' } });
    expect(screen.queryByTestId('token-row-space-4')).toBeNull();
  });

  it('editing the value: Enter commits (setTokens), an invalid value blocks, Esc cancels', () => {
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
    // Esc cancels without an op
    vi.mocked(daemon.applySafe).mockClear();
    fireEvent.click(r.getByTestId('token-value-space-4'));
    input = r.getByTestId('token-value-input');
    fireEvent.change(input, { target: { value: '99px' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(daemon.applySafe).not.toHaveBeenCalled();
    expect(r.queryByTestId('token-value-input')).toBeNull();
  });

  it('double-clicking the name renames (renameToken)', () => {
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

  it('renaming to an existing name shows an error and emits no op', () => {
    setup();
    render(<TokensPanel />);
    const r = within(row('color-primary'));
    fireEvent.doubleClick(r.getByTestId('token-name-color-primary').parentElement!);
    const input = r.getByTestId('token-name-input');
    fireEvent.change(input, { target: { value: 'space-4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(daemon.applySafe).not.toHaveBeenCalled();
  });

  it('with a theme selected, editing writes to the override and allows removing it', () => {
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

  it('creates a token from the form and rejects a duplicate name', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('tokens-add'));
    fireEvent.change(screen.getByTestId('new-token-name'), { target: { value: 'color-primary' } });
    fireEvent.change(screen.getByTestId('new-token-value'), { target: { value: '#fff' } });
    fireEvent.click(screen.getByTestId('new-token-submit'));
    expect(screen.getByTestId('new-token-error').textContent).toMatch(/already exists/);
    fireEvent.change(screen.getByTestId('new-token-name'), { target: { value: 'color-new' } });
    fireEvent.change(screen.getByTestId('new-token-group'), { target: { value: 'color' } });
    fireEvent.click(screen.getByTestId('new-token-submit'));
    expect(daemon.applySafe).toHaveBeenCalledWith([
      { type: 'setTokens', set: { '--color-new': '#fff' } },
      { type: 'setTokenMeta', set: { '--color-new': { group: 'color' } } },
    ]);
  });

  it('deletes a token (planDeleteTokens) and edits group and description', () => {
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

  it('importing CSS shows the analysis and generates replaceTokens (merge)', () => {
    const { doc } = setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('tokens-import'));
    fireEvent.change(screen.getByTestId('tokens-import-text'), {
      target: { value: ':root { --new: 4px; }' },
    });
    expect(screen.getByTestId('tokens-import-info').textContent).toContain('1 token');
    fireEvent.click(screen.getByTestId('tokens-import-confirm'));
    const ops = vi.mocked(daemon.applySafe).mock.calls[0]![0];
    expect(ops[0]).toMatchObject({ type: 'replaceTokens' });
    expect((ops[0] as { tokens: Record<string, string> }).tokens).toEqual({
      ...doc.tokens,
      '--new': '4px',
    });
  });

  it('exporting shows the text in the chosen format', () => {
    setup();
    render(<TokensPanel />);
    fireEvent.click(screen.getByTestId('tokens-export'));
    const area = screen.getByTestId('tokens-export-text') as HTMLTextAreaElement;
    expect(area.value).toContain('--color-primary: #ff0000');
    fireEvent.change(screen.getByTestId('tokens-export-format'), { target: { value: 'json' } });
    expect(area.value).toContain('$value');
  });
});
