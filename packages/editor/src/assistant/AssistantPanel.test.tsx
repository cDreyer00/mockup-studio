// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantBackendInfo, AssistantMessage } from '@mockup/core';
import { daemon } from '../client/daemon';
import { assistantStore, useAssistant } from '../state/assistantStore';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { AssistantPanel } from './AssistantPanel';
import { contextLabel, opsLabel } from './logic';

const DOC = 'doc_1';
const at = '2026-01-01T00:00:00Z';
const CLAUDE: AssistantBackendInfo = { id: 'claude', name: 'Claude Code', available: true };

function history(backends: AssistantBackendInfo[], messages: AssistantMessage[] = []) {
  return { messages, running: null, backends, config: { backend: 'auto' } };
}

// What `assistant:history` returns; tests swap this variable before rendering.
let served = history([CLAUDE]);

describe('AssistantPanel', () => {
  beforeEach(() => {
    served = history([CLAUDE]);
    useAssistant.setState({ byDoc: {}, backends: [], config: null });
    useDoc.setState({ activeDocId: DOC, status: 'online' });
    useUi.setState({ selection: [] });
    vi.spyOn(daemon, 'assistantHistory').mockImplementation(async () => {
      assistantStore.setHistory(DOC, served);
      return served;
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useDoc.setState({ activeDocId: null });
  });

  it('context and change texts', () => {
    expect(contextLabel(0)).toBe('no selection — the whole document');
    expect(contextLabel(1)).toBe('1 node selected');
    expect(contextLabel(2)).toBe('2 nodes selected');
    expect(opsLabel(1)).toBe('1 change — Ctrl+Z undoes the turn');
    expect(opsLabel(5)).toBe('5 changes — Ctrl+Z undoes the turn');
  });

  it('empty state with suggestions; clicking a suggestion fills the field', async () => {
    render(<AssistantPanel />);
    await act(async () => undefined);
    expect(daemon.assistantHistory).toHaveBeenCalledWith(DOC);
    expect(screen.getByTestId('assistant-empty')).toBeTruthy();
    expect(screen.getByTestId('assistant-context').textContent).toContain('no selection');
    fireEvent.click(screen.getAllByTestId('assistant-suggestion')[0]!);
    expect((screen.getByTestId('assistant-input') as HTMLTextAreaElement).value).toBe(
      'Make the primary button stand out more',
    );
  });

  it('Enter sends with the selection; Shift+Enter does not send', async () => {
    useUi.setState({ selection: ['n1', 'n2'] });
    const send = vi.spyOn(daemon, 'assistantSend').mockResolvedValue({ turnId: 't1' });
    render(<AssistantPanel />);
    await act(async () => undefined);
    expect(screen.getByTestId('assistant-context').textContent).toBe('2 nodes selected');
    const input = screen.getByTestId('assistant-input');
    fireEvent.change(input, { target: { value: 'Make the button bigger' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(send).toHaveBeenCalledWith('Make the button bigger', {
      selection: ['n1', 'n2'],
      docId: DOC,
    });
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('shows messages, tools, changes footer, error and cancellation', async () => {
    served = {
      ...history(
        [CLAUDE],
        [
          { id: 'u1', role: 'user', text: 'Do this\nand that', at, turnId: 't1' },
          {
            id: 'a1',
            role: 'assistant',
            text: 'Done.',
            at,
            turnId: 't1',
            status: 'done',
            opsCount: 3,
            tools: [
              { id: 'c1', name: 'mcp__mockup__update_styles', ok: true },
              { id: 'c2', name: 'mcp__mockup__create_node', ok: false },
            ],
          },
          {
            id: 'a2',
            role: 'assistant',
            text: '',
            at,
            turnId: 't2',
            status: 'error',
            error: 'no network',
          },
          { id: 'a3', role: 'assistant', text: 'half', at, turnId: 't3', status: 'cancelled' },
        ],
      ),
    };
    render(<AssistantPanel />);
    await act(async () => undefined);
    const list = screen.getByTestId('assistant-messages');
    expect(list.textContent).toContain('3 changes — Ctrl+Z undoes the turn');
    expect(list.textContent).toContain('no network');
    expect(list.textContent).toContain('Cancelled.');
    const chips = screen.getAllByTestId('assistant-tool');
    expect(chips.map((c) => c.getAttribute('data-status'))).toEqual(['ok', 'error']);
    expect(chips[0]!.textContent).toBe('update_styles');
  });

  it('turn in progress: partial text, running chip and Cancel button', async () => {
    render(<AssistantPanel />);
    await act(async () => undefined);
    const cancel = vi.spyOn(daemon, 'assistantCancel').mockResolvedValue({ cancelled: true });
    act(() => {
      assistantStore.applyEvent(DOC, {
        kind: 'turn-start',
        turnId: 't1',
        user: { id: 'u1', role: 'user', text: 'hi', at, turnId: 't1' },
        backend: 'claude',
      });
      assistantStore.applyEvent(DOC, { kind: 'text', turnId: 't1', text: 'Working' });
      assistantStore.applyEvent(DOC, {
        kind: 'tool',
        turnId: 't1',
        tool: { id: 'c1', name: 'mcp__mockup__get_tree' },
      });
    });
    expect(screen.getByTestId('assistant-partial').textContent).toContain('Working');
    expect(screen.getByTestId('assistant-tool').getAttribute('data-status')).toBe('running');
    expect(screen.queryByTestId('assistant-send')).toBeNull();
    expect(screen.getByTestId('assistant-split-warning').textContent).toContain('split the turn');
    fireEvent.click(screen.getByTestId('assistant-cancel'));
    expect(cancel).toHaveBeenCalledWith(DOC);
  });

  it('with no backend available shows the notice and blocks sending', async () => {
    served = history([{ id: 'claude', name: 'Claude Code', available: false }]);
    render(<AssistantPanel />);
    await act(async () => undefined);
    expect(screen.getByTestId('assistant-no-backend').textContent).toMatch(/Claude Code.*Codex/);
    fireEvent.change(screen.getByTestId('assistant-input'), { target: { value: 'hi' } });
    expect((screen.getByTestId('assistant-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('backend selector writes via assistant:config', async () => {
    const cfg = vi
      .spyOn(daemon, 'assistantConfig')
      .mockResolvedValue({ config: { backend: 'claude' }, backends: [CLAUDE] });
    render(<AssistantPanel />);
    await act(async () => undefined);
    fireEvent.change(screen.getByTestId('assistant-backend'), { target: { value: 'claude' } });
    expect(cfg).toHaveBeenCalledWith({ backend: 'claude' });
  });

  it('clear history calls assistant:clear', async () => {
    served = history([CLAUDE], [{ id: 'u1', role: 'user', text: 'hi', at, turnId: 't1' }]);
    const clear = vi.spyOn(daemon, 'assistantClear').mockResolvedValue({});
    render(<AssistantPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId('assistant-clear'));
    expect(clear).toHaveBeenCalledWith(DOC);
  });
});
