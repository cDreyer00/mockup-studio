import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyOp, createNodeFromTag } from '@mockup/core';
import type { Document, ServerMessage } from '@mockup/core';
import { makeDoc } from '../test/fixtures';
import { useDoc } from '../state/docStore';
import { useUi } from '../state/uiStore';
import { DaemonClient } from './daemon';

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

  it('mudança de seleção local é publicada no daemon', () => {
    const { doc, a } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    useUi.setState({ selection: [a.id] });
    const last = FakeSocket.last!.sent.at(-1)!;
    expect(last).toMatchObject({ type: 'selection:set', docId: doc.id, nodeIds: [a.id] });
  });
});
