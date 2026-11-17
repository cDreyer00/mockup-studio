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

// O que `assistant:history` devolve; os testes trocam esta variável antes de renderizar.
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

  it('textos de contexto e de alterações', () => {
    expect(contextLabel(0)).toBe('sem seleção — o documento inteiro');
    expect(contextLabel(1)).toBe('1 nó selecionado');
    expect(contextLabel(2)).toBe('2 nós selecionados');
    expect(opsLabel(1)).toBe('1 alteração — Ctrl+Z desfaz o turno');
    expect(opsLabel(5)).toBe('5 alterações — Ctrl+Z desfaz o turno');
  });

  it('estado vazio com sugestões; clicar numa sugestão preenche o campo', async () => {
    render(<AssistantPanel />);
    await act(async () => undefined);
    expect(daemon.assistantHistory).toHaveBeenCalledWith(DOC);
    expect(screen.getByTestId('assistant-empty')).toBeTruthy();
    expect(screen.getByTestId('assistant-context').textContent).toContain('sem seleção');
    fireEvent.click(screen.getAllByTestId('assistant-suggestion')[0]!);
    expect((screen.getByTestId('assistant-input') as HTMLTextAreaElement).value).toBe(
      'Deixe o botão primário mais destacado',
    );
  });

  it('Enter envia com a seleção; Shift+Enter não envia', async () => {
    useUi.setState({ selection: ['n1', 'n2'] });
    const send = vi.spyOn(daemon, 'assistantSend').mockResolvedValue({ turnId: 't1' });
    render(<AssistantPanel />);
    await act(async () => undefined);
    expect(screen.getByTestId('assistant-context').textContent).toBe('2 nós selecionados');
    const input = screen.getByTestId('assistant-input');
    fireEvent.change(input, { target: { value: 'Aumente o botão' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(send).toHaveBeenCalledWith('Aumente o botão', { selection: ['n1', 'n2'], docId: DOC });
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('mostra mensagens, ferramentas, rodapé de alterações, erro e cancelamento', async () => {
    served = {
      ...history(
        [CLAUDE],
        [
          { id: 'u1', role: 'user', text: 'Faça isso\ne aquilo', at, turnId: 't1' },
          {
            id: 'a1',
            role: 'assistant',
            text: 'Feito.',
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
            error: 'sem rede',
          },
          { id: 'a3', role: 'assistant', text: 'meio', at, turnId: 't3', status: 'cancelled' },
        ],
      ),
    };
    render(<AssistantPanel />);
    await act(async () => undefined);
    const list = screen.getByTestId('assistant-messages');
    expect(list.textContent).toContain('3 alterações — Ctrl+Z desfaz o turno');
    expect(list.textContent).toContain('sem rede');
    expect(list.textContent).toContain('Cancelado.');
    const chips = screen.getAllByTestId('assistant-tool');
    expect(chips.map((c) => c.getAttribute('data-status'))).toEqual(['ok', 'error']);
    expect(chips[0]!.textContent).toBe('update_styles');
  });

  it('turno em andamento: texto parcial, chip rodando e botão Cancelar', async () => {
    render(<AssistantPanel />);
    await act(async () => undefined);
    const cancel = vi.spyOn(daemon, 'assistantCancel').mockResolvedValue({ cancelled: true });
    act(() => {
      assistantStore.applyEvent(DOC, {
        kind: 'turn-start',
        turnId: 't1',
        user: { id: 'u1', role: 'user', text: 'oi', at, turnId: 't1' },
        backend: 'claude',
      });
      assistantStore.applyEvent(DOC, { kind: 'text', turnId: 't1', text: 'Trabalhando' });
      assistantStore.applyEvent(DOC, {
        kind: 'tool',
        turnId: 't1',
        tool: { id: 'c1', name: 'mcp__mockup__get_tree' },
      });
    });
    expect(screen.getByTestId('assistant-partial').textContent).toContain('Trabalhando');
    expect(screen.getByTestId('assistant-tool').getAttribute('data-status')).toBe('running');
    expect(screen.queryByTestId('assistant-send')).toBeNull();
    fireEvent.click(screen.getByTestId('assistant-cancel'));
    expect(cancel).toHaveBeenCalledWith(DOC);
  });

  it('sem backend disponível mostra o aviso e bloqueia o envio', async () => {
    served = history([{ id: 'claude', name: 'Claude Code', available: false }]);
    render(<AssistantPanel />);
    await act(async () => undefined);
    expect(screen.getByTestId('assistant-no-backend').textContent).toMatch(/Claude Code.*Codex/);
    fireEvent.change(screen.getByTestId('assistant-input'), { target: { value: 'oi' } });
    expect((screen.getByTestId('assistant-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('seletor de backend grava via assistant:config', async () => {
    const cfg = vi
      .spyOn(daemon, 'assistantConfig')
      .mockResolvedValue({ config: { backend: 'claude' }, backends: [CLAUDE] });
    render(<AssistantPanel />);
    await act(async () => undefined);
    fireEvent.change(screen.getByTestId('assistant-backend'), { target: { value: 'claude' } });
    expect(cfg).toHaveBeenCalledWith({ backend: 'claude' });
  });

  it('limpar histórico chama assistant:clear', async () => {
    served = history([CLAUDE], [{ id: 'u1', role: 'user', text: 'oi', at, turnId: 't1' }]);
    const clear = vi.spyOn(daemon, 'assistantClear').mockResolvedValue({});
    render(<AssistantPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByTestId('assistant-clear'));
    expect(clear).toHaveBeenCalledWith(DOC);
  });
});
