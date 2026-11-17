import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantEvent, AssistantMessage } from '@mockup/core';
import { assistantStore, useAssistant } from './assistantStore';

const DOC = 'doc_1';
const at = '2026-01-01T00:00:00Z';
const userMsg: AssistantMessage = {
  id: 'u1',
  role: 'user',
  text: 'Highlight the button',
  at,
  turnId: 't1',
};
const state = () => useAssistant.getState().byDoc[DOC]!;

const feed = (...events: AssistantEvent[]) =>
  events.forEach((e) => assistantStore.applyEvent(DOC, e));

describe('assistantStore', () => {
  beforeEach(() => useAssistant.setState({ byDoc: {}, backends: [], config: null }));

  it('full turn: turn-start → text → tool → tool-result → turn-end', () => {
    feed({ kind: 'turn-start', turnId: 't1', user: userMsg, backend: 'claude' });
    expect(state().messages).toEqual([userMsg]);
    expect(state().partial).toEqual({ turnId: 't1', text: '', tools: [] });

    feed(
      { kind: 'text', turnId: 't1', text: 'I will ' },
      { kind: 'text', turnId: 't1', text: 'adjust.' },
    );
    expect(state().partial!.text).toBe('I will adjust.');

    feed({ kind: 'tool', turnId: 't1', tool: { id: 'c1', name: 'mcp__mockup__update_styles' } });
    expect(state().partial!.tools).toEqual([{ id: 'c1', name: 'mcp__mockup__update_styles' }]);

    feed({ kind: 'tool-result', turnId: 't1', toolId: 'c1', ok: true, summary: 'ok' });
    expect(state().partial!.tools[0]).toMatchObject({ id: 'c1', ok: true, summary: 'ok' });

    const final: AssistantMessage = {
      id: 'a1',
      role: 'assistant',
      text: 'I will adjust. Done.',
      at,
      turnId: 't1',
      status: 'done',
      opsCount: 4,
      tools: [{ id: 'c1', name: 'mcp__mockup__update_styles', ok: true }],
    };
    feed({ kind: 'turn-end', turnId: 't1', message: final });
    expect(state().partial).toBeNull();
    expect(state().messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(state().messages[1]!.opsCount).toBe(4);
  });

  it('tool with error and cancelled/errored turn', () => {
    feed(
      { kind: 'turn-start', turnId: 't1', user: userMsg, backend: 'claude' },
      { kind: 'tool', turnId: 't1', tool: { id: 'c1', name: 'x' } },
      { kind: 'tool-result', turnId: 't1', toolId: 'c1', ok: false, summary: 'falhou' },
    );
    expect(state().partial!.tools[0]).toMatchObject({ ok: false });
    feed({
      kind: 'turn-end',
      turnId: 't1',
      message: {
        id: 'a1',
        role: 'assistant',
        text: '',
        at,
        turnId: 't1',
        status: 'error',
        error: 'boom',
      },
    });
    expect(state().messages[1]).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('repeated events do not duplicate messages; events from another turn do not leak', () => {
    feed(
      { kind: 'turn-start', turnId: 't1', user: userMsg, backend: 'claude' },
      { kind: 'turn-start', turnId: 't1', user: userMsg, backend: 'claude' },
      { kind: 'tool-result', turnId: 'other', toolId: 'c1', ok: true },
    );
    expect(state().messages).toHaveLength(1);
    expect(state().partial!.tools).toEqual([]);
  });

  it('cleared empties messages and turn', () => {
    feed({ kind: 'turn-start', turnId: 't1', user: userMsg, backend: 'claude' });
    feed({ kind: 'cleared' });
    expect(state().messages).toEqual([]);
    expect(state().partial).toBeNull();
  });

  it('independent documents', () => {
    assistantStore.applyEvent('a', {
      kind: 'turn-start',
      turnId: 't1',
      user: userMsg,
      backend: 'c',
    });
    expect(useAssistant.getState().byDoc['b']).toBeUndefined();
    assistantStore.drop('a');
    expect(useAssistant.getState().byDoc['a']).toBeUndefined();
  });

  it('setHistory rebuilds the turn in progress from a "running" message', () => {
    assistantStore.setHistory(DOC, {
      messages: [
        userMsg,
        { id: 'a1', role: 'assistant', text: 'parcial', at, turnId: 't1', status: 'running' },
      ],
      running: 't1',
      backends: [{ id: 'claude', name: 'Claude Code', available: true }],
      config: { backend: 'auto' },
    });
    expect(state().messages.map((m) => m.id)).toEqual(['u1']);
    expect(state().partial).toMatchObject({ turnId: 't1', text: 'parcial' });
    expect(state().loaded).toBe(true);
    expect(useAssistant.getState().config).toEqual({ backend: 'auto' });
  });

  it('setHistory keeps the in-progress partial of the same turn and clears it when there is no turn', () => {
    feed({ kind: 'turn-start', turnId: 't1', user: userMsg, backend: 'claude' });
    feed({ kind: 'text', turnId: 't1', text: 'abc' });
    const res = { messages: [userMsg], backends: [], config: { backend: 'auto' } };
    assistantStore.setHistory(DOC, { ...res, running: 't1' });
    expect(state().partial!.text).toBe('abc');
    assistantStore.setHistory(DOC, { ...res, running: null });
    expect(state().partial).toBeNull();
  });
});
