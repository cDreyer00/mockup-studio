import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOp, createNodeFromTag } from '@mockup/core';
import type { Document, ServerMessage } from '@mockup/core';
import { makeDoc } from '../test/fixtures';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { DaemonClient, SELECTION_SYNC_MS } from './daemon';

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

const H = { canUndo: false, canRedo: false };

function hello(doc: Document): ServerMessage {
  return {
    type: 'hello',
    documents: [{ docId: doc.id, name: doc.name, path: null, dirty: false, revision: 0 }],
    activeDocId: doc.id,
    doc,
    selection: [],
    revision: 0,
    history: H,
  };
}

describe('DaemonClient', () => {
  let client: DaemonClient;
  beforeEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
    useUi.setState({ selection: [], pageId: null, focusRequest: null });
    client = new DaemonClient(() => 'ws://teste/ws');
    client.connect();
    FakeSocket.last!.onopen?.();
  });
  afterEach(() => client.disconnect());

  it('hello popula o store e doc:changed reaproveita a estrutura', () => {
    const { doc, a, b } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    expect(useDoc.getState().doc?.id).toBe(doc.id);
    const before = useDoc.getState().doc!;
    const next = applyOp(doc, {
      type: 'updateStyles',
      nodeIds: [a.id],
      styles: { width: '1px' },
    }).doc;
    FakeSocket.last!.emit({
      type: 'doc:changed',
      docId: doc.id,
      ops: [],
      source: 'editor',
      revision: 1,
      doc: next,
      history: { canUndo: true, canRedo: false },
    });
    const after = useDoc.getState().doc!;
    expect(after.pages[0]!.frames[0]!.children[1]).toBe(before.pages[0]!.frames[0]!.children[1]);
    expect(after.pages[0]!.frames[0]!.children[1]!.id).toBe(b.id);
    expect(useDoc.getState().history.canUndo).toBe(true);
    expect(useDoc.getState().documents[0]!.dirty).toBe(true);
  });

  it('ops do MCP marcam atividade do agente no frame', () => {
    const { doc, frame } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const node = createNodeFromTag('div', { name: 'Novo' });
    const op = { type: 'createNode' as const, parentId: frame.id, node };
    FakeSocket.last!.emit({
      type: 'doc:changed',
      docId: doc.id,
      ops: [op],
      source: 'mcp',
      revision: 1,
      doc: applyOp(doc, op).doc,
      history: H,
    });
    expect(useDoc.getState().agentActivity[frame.id]).toBeGreaterThan(0);
  });

  it('seleção do MCP seleciona e pede foco; a do editor é ignorada', () => {
    const { doc, a } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    FakeSocket.last!.emit({
      type: 'selection:changed',
      docId: doc.id,
      nodeIds: [a.id],
      source: 'mcp',
    });
    expect(useUi.getState().selection).toEqual([a.id]);
    expect(useUi.getState().focusRequest?.nodeIds).toEqual([a.id]);
    FakeSocket.last!.emit({
      type: 'selection:changed',
      docId: doc.id,
      nodeIds: [],
      source: 'editor',
    });
    expect(useUi.getState().selection).toEqual([a.id]);
  });

  it('request resolve com o ack e rejeita com o error', async () => {
    const { doc } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const ws = FakeSocket.last!;
    const p = client.apply([{ type: 'renamePage', pageId: doc.pages[0]!.id, name: 'X' }]);
    const sent = ws.sent.at(-1)!;
    expect(sent.type).toBe('op:apply');
    ws.emit({ type: 'ack', reqId: sent.reqId as string, result: { revision: 2, results: [null] } });
    await expect(p).resolves.toEqual({ revision: 2, results: [null] });
    const p2 = client.undo();
    ws.emit({ type: 'error', reqId: ws.sent.at(-1)!.reqId as string, message: 'falhou' });
    await expect(p2).rejects.toThrow('falhou');
  });

  it('mudança de seleção local é publicada no daemon, agrupada no tempo', () => {
    vi.useFakeTimers();
    try {
      const { doc, a, b, c } = makeDoc();
      FakeSocket.last!.emit(hello(doc));
      const sent = () => FakeSocket.last!.sent.filter((m) => m.type === 'selection:set');
      useUi.setState({ selection: [a.id] });
      vi.advanceTimersByTime(0);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({ docId: doc.id, nodeIds: [a.id] });
      // marquee: várias mudanças seguidas viram um único envio com a última seleção
      for (const sel of [[a.id, b.id], [b.id], [a.id, b.id, c.id]]) {
        useUi.setState({ selection: sel });
        vi.advanceTimersByTime(10);
      }
      expect(sent()).toHaveLength(1);
      vi.advanceTimersByTime(SELECTION_SYNC_MS);
      expect(sent()).toHaveLength(2);
      expect(sent()[1]).toMatchObject({ nodeIds: [a.id, b.id, c.id] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnect rejeita as requisições pendentes na hora', async () => {
    const { doc } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const p = client.undo();
    client.disconnect();
    await expect(p).rejects.toThrow('perdida');
  });

  it('doc:closed remove o histórico e active:changed atualiza a revisão', () => {
    const { doc } = makeDoc();
    const other = { ...structuredClone(doc), id: 'doc_outro01' };
    FakeSocket.last!.emit(hello(doc));
    FakeSocket.last!.emit({
      type: 'doc:opened',
      info: { docId: other.id, name: 'Outro', path: null, dirty: false, revision: 7 },
      doc: other,
      history: { canUndo: true, canRedo: false },
    });
    expect(useDoc.getState().histories[other.id]).toBeDefined();
    FakeSocket.last!.emit({ type: 'active:changed', docId: other.id });
    expect(useDoc.getState().revision).toBe(7);
    expect(useDoc.getState().history.canUndo).toBe(true);
    FakeSocket.last!.emit({ type: 'doc:closed', docId: other.id });
    expect(useDoc.getState().histories[other.id]).toBeUndefined();
    expect(useDoc.getState().docs[other.id]).toBeUndefined();
  });

  it('atividade antiga do agente é descartada quando chega nova', () => {
    const { doc, frame } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    useDoc.setState({ agentActivity: { fr_velho: Date.now() - 60_000 } });
    const node = createNodeFromTag('div', { name: 'Novo' });
    const op = { type: 'createNode' as const, parentId: frame.id, node };
    FakeSocket.last!.emit({
      type: 'doc:changed',
      docId: doc.id,
      ops: [op],
      source: 'mcp',
      revision: 1,
      doc: applyOp(doc, op).doc,
      history: H,
    });
    expect(Object.keys(useDoc.getState().agentActivity)).toEqual([frame.id]);
  });
});
