import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantEvent, AssistantMessage, ServerMessage } from '@mockup/core';
import { EMPTY_ASSISTANT, useAssistant } from '../state/assistantStore';
import { useDoc } from '../state/docStore';
import { makeDoc } from '../test/fixtures';
import { DaemonClient, LONG_REQUEST_TIMEOUT_MS } from './daemon';

/** Requisições da fase 9 (assistente, scripts, remix) e integração do `assistant:event`. */

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const user = (id: string, turnId: string, text: string): AssistantMessage => ({
  id,
  role: 'user',
  text,
  at: '2026-01-01T00:00:00Z',
  turnId,
});

describe('DaemonClient: assistente, scripts e remix', () => {
  let client: DaemonClient;
  let docId: string;
  let ws: FakeSocket;
  beforeEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
    useAssistant.setState({ byDoc: {}, backends: [], config: null });
    client = new DaemonClient(() => 'ws://teste/ws');
    client.connect();
    ws = FakeSocket.last!;
    ws.onopen?.();
    const { doc } = makeDoc();
    docId = doc.id;
    ws.emit({
      type: 'hello',
      documents: [{ docId, name: doc.name, path: null, dirty: false, revision: 0 }],
      activeDocId: docId,
      doc,
      selection: [],
      revision: 0,
      history: { canUndo: false, canRedo: false },
    });
  });
  afterEach(() => {
    client.disconnect();
    useDoc.setState({ docs: {}, activeDocId: null, doc: null });
  });

  /** Requisição sem interesse na resposta: evita rejeição não tratada ao desconectar. */
  const swallow = (p: Promise<unknown>) => void p.catch(() => undefined);
  const lastSent = () => ws.sent.at(-1)!;
  const ack = (result: unknown) =>
    ws.emit({ type: 'ack', reqId: lastSent().reqId as string, result });

  it('assistantSend envia prompt/seleção/backend e só espera o ack', async () => {
    const p = client.assistantSend('Deixe o botão maior', {
      selection: ['a', 'b'],
      backend: 'claude',
    });
    expect(lastSent()).toMatchObject({
      type: 'assistant:send',
      docId,
      prompt: 'Deixe o botão maior',
      selection: ['a', 'b'],
      backend: 'claude',
    });
    ack({ turnId: 't1' });
    await expect(p).resolves.toEqual({ turnId: 't1' });
  });

  it('assistantSend sem opções não inclui selection/backend', () => {
    swallow(client.assistantSend('oi').catch(() => undefined));
    expect(lastSent()).not.toHaveProperty('selection');
    expect(lastSent()).not.toHaveProperty('backend');
  });

  it('cancel, clear e config', async () => {
    const c = client.assistantCancel();
    expect(lastSent()).toMatchObject({ type: 'assistant:cancel', docId });
    ack({ cancelled: true });
    await expect(c).resolves.toEqual({ cancelled: true });

    swallow(client.assistantClear());
    expect(lastSent()).toMatchObject({ type: 'assistant:clear', docId });
    ack({});

    const cfg = client.assistantConfig({ backend: 'codex' });
    expect(lastSent()).toMatchObject({ type: 'assistant:config', config: { backend: 'codex' } });
    ack({
      config: { backend: 'codex' },
      backends: [{ id: 'codex', name: 'Codex', available: true }],
    });
    await cfg;
    expect(useAssistant.getState().config).toEqual({ backend: 'codex' });
    expect(useAssistant.getState().backends).toHaveLength(1);

    swallow(client.assistantConfig());
    expect(lastSent()).not.toHaveProperty('config');
  });

  it('assistantHistory grava mensagens, backends e config no store', async () => {
    const p = client.assistantHistory();
    expect(lastSent()).toMatchObject({ type: 'assistant:history', docId });
    ack({
      messages: [user('m1', 't0', 'oi')],
      running: null,
      backends: [{ id: 'claude', name: 'Claude Code', available: true }],
      config: { backend: 'auto' },
    });
    await p;
    const s = useAssistant.getState();
    expect(s.byDoc[docId]!.messages.map((m) => m.id)).toEqual(['m1']);
    expect(s.byDoc[docId]!.loaded).toBe(true);
    expect(s.config?.backend).toBe('auto');
  });

  it('assistant:event vira estado do store e doc:closed descarta o documento', () => {
    const ev = (event: AssistantEvent) => ws.emit({ type: 'assistant:event', docId, event });
    ev({ kind: 'turn-start', turnId: 't1', user: user('u1', 't1', 'x'), backend: 'claude' });
    expect(useAssistant.getState().byDoc[docId]!.partial?.turnId).toBe('t1');
    ws.emit({ type: 'doc:closed', docId });
    expect(useAssistant.getState().byDoc[docId]).toBeUndefined();
    expect(EMPTY_ASSISTANT.messages).toEqual([]);
  });

  it('scripts: run, list, read, save, delete e generate', async () => {
    const run = client.scriptRun('return 1', { selection: ['n1'] });
    expect(lastSent()).toMatchObject({
      type: 'script:run',
      docId,
      code: 'return 1',
      selection: ['n1'],
    });
    ack({ ok: true, logs: [], result: 1, images: [], opsCount: 0, durationMs: 3 });
    await expect(run).resolves.toMatchObject({ ok: true, result: 1 });

    swallow(client.scriptList());
    expect(lastSent()).toMatchObject({ type: 'script:list', docId });
    ack({ dir: null, scripts: [] });
    swallow(client.scriptRead('a.js'));
    expect(lastSent()).toMatchObject({ type: 'script:read', docId, name: 'a.js' });
    ack({ name: 'a.js', code: '' });
    swallow(client.scriptSave('a', 'x'));
    expect(lastSent()).toMatchObject({ type: 'script:save', docId, name: 'a', code: 'x' });
    ack({ name: 'a.js' });
    swallow(client.scriptDelete('a.js'));
    expect(lastSent()).toMatchObject({ type: 'script:delete', docId, name: 'a.js' });
    ack({});
    const gen = client.scriptGenerate('renomeie tudo');
    expect(lastSent()).toMatchObject({
      type: 'script:generate',
      docId,
      prompt: 'renomeie tudo',
    });
    ack({ code: 'return 2' });
    await expect(gen).resolves.toEqual({ code: 'return 2' });
  });

  it('remix envia kind/count/prompt', async () => {
    const p = client.remix('n1', 'color-scale', { count: 10 });
    expect(lastSent()).toMatchObject({
      type: 'remix',
      docId,
      nodeId: 'n1',
      kind: 'color-scale',
      count: 10,
    });
    expect(lastSent()).not.toHaveProperty('prompt');
    ack({ frameIds: ['f1'], labels: ['A'] });
    await expect(p).resolves.toEqual({ frameIds: ['f1'], labels: ['A'] });

    swallow(client.remix('n1', 'ai', { prompt: 'mais ousado', count: 3 }));
    expect(lastSent()).toMatchObject({ kind: 'ai', prompt: 'mais ousado', count: 3 });
  });

  it('script:run usa o timeout longo (a requisição não expira em 15 s)', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      let rejected = false;
      swallow(client.scriptRun('1').catch(() => (rejected = true)));
      let shortRejected = false;
      swallow(client.request({ type: 'undo' }).catch(() => (shortRejected = true)));
      await vi.advanceTimersByTimeAsync(16000);
      expect(shortRejected).toBe(true);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(LONG_REQUEST_TIMEOUT_MS);
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem documento ativo as requisições do documento rejeitam', async () => {
    useDoc.setState({ activeDocId: null });
    await expect(client.assistantSend('x')).rejects.toThrow('Nenhum documento');
    await expect(client.scriptRun('x')).rejects.toThrow('Nenhum documento');
  });
});
