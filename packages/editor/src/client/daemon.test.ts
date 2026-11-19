import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOp, createNodeFromTag } from '@mockup/core';
import type { Document, ServerMessage } from '@mockup/core';
import { presentation } from '../presentation/presentationStore';
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
    client = new DaemonClient(() => 'ws://test/ws');
    client.connect();
    FakeSocket.last!.onopen?.();
  });
  afterEach(() => client.disconnect());

  it('registers as an editor window on connect and again on window focus', () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const own = new DaemonClient(() => 'ws://test/ws');
    own.connect();
    const ws = FakeSocket.last!;
    ws.onopen?.();
    const reg = () => ws.sent.filter((m) => m.type === 'editor:register');
    expect(reg()).toHaveLength(1);
    expect(reg()[0]).toMatchObject({ focused: expect.any(Boolean) });
    win.dispatchEvent(new Event('focus'));
    expect(reg()).toHaveLength(2);
    expect(reg()[1]).toMatchObject({ focused: true });
    own.disconnect();
    win.dispatchEvent(new Event('focus'));
    expect(reg()).toHaveLength(2);
    vi.unstubAllGlobals();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  it('reports to the daemon when a presentation starts and ends', () => {
    const { doc } = makeDoc();
    const ws = FakeSocket.last!;
    ws.emit(hello(doc));
    const reg = () => ws.sent.filter((m) => m.type === 'editor:register');
    expect(reg().at(-1)).toMatchObject({ presenting: false });
    const before = reg().length;
    presentation.start();
    expect(reg()).toHaveLength(before + 1);
    expect(reg().at(-1)).toMatchObject({ presenting: true });
    presentation.navigate({ type: 'next' }); // not a start / end
    expect(reg()).toHaveLength(before + 1);
    presentation.stop();
    expect(reg()).toHaveLength(before + 2);
    expect(reg().at(-1)).toMatchObject({ presenting: false });
    client.disconnect();
    presentation.start();
    presentation.stop();
    expect(reg()).toHaveLength(before + 2);
  });

  it('re-registers as presenting after the socket reconnects and keeps presenting', () => {
    vi.useFakeTimers();
    try {
      const { doc } = makeDoc();
      const first = FakeSocket.last!;
      first.emit(hello(doc));
      presentation.start();
      first.close(); // the daemon went away: the client schedules a reconnect
      expect(presentation.getState().active).toBe(true);
      vi.advanceTimersByTime(5000);
      const second = FakeSocket.last!;
      expect(second).not.toBe(first);
      second.onopen?.();
      const reg = second.sent.filter((m) => m.type === 'editor:register');
      expect(reg).toHaveLength(1);
      expect(reg[0]).toMatchObject({ presenting: true });
      second.emit(hello(doc)); // same document again: the show goes on
      expect(presentation.getState()).toMatchObject({ active: true, docId: doc.id });
      presentation.stop();
      expect(second.sent.filter((m) => m.type === 'editor:register').at(-1)).toMatchObject({
        presenting: false,
      });
    } finally {
      presentation.stop();
      vi.useRealTimers();
    }
  });

  it('runs editor:command and replies with editor:result', async () => {
    const { doc } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    FakeSocket.last!.emit({
      type: 'editor:command',
      commandId: 'c1',
      command: { type: 'presentation:start', docId: doc.id },
    });
    const result = () => FakeSocket.last!.sent.filter((m) => m.type === 'editor:result');
    await vi.waitFor(() => expect(result()).toHaveLength(1));
    expect(result()[0]).toMatchObject({
      commandId: 'c1',
      ok: true,
      result: { active: true, docId: doc.id },
    });
    presentation.stop();

    FakeSocket.last!.emit({
      type: 'editor:command',
      commandId: 'c2',
      command: { type: 'presentation:goto', step: 'next' },
    });
    await vi.waitFor(() => expect(result()).toHaveLength(2));
    expect(result()[1]).toMatchObject({
      commandId: 'c2',
      ok: false,
      error: 'No presentation is running.',
    });
  });

  it('hello populates the store and doc:changed reuses the structure', () => {
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

  it('MCP ops mark agent activity on the frame', () => {
    const { doc, frame } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const node = createNodeFromTag('div', { name: 'New' });
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

  it('agent:finished clears the badge of the frames of the nodes (or of all when empty)', () => {
    const { doc, frame, a } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const now = Date.now();
    useDoc.setState({ agentActivity: { [frame.id]: now, fr_other: now } });
    FakeSocket.last!.emit({ type: 'agent:finished', docId: doc.id, nodeIds: [a.id] });
    expect(useDoc.getState().agentActivity).toEqual({ fr_other: now });
    useDoc.setState({ agentActivity: { [frame.id]: now } });
    FakeSocket.last!.emit({ type: 'agent:finished', docId: doc.id, nodeIds: [] });
    expect(useDoc.getState().agentActivity).toEqual({});
  });

  it('doc:saved with a new path updates the document path', () => {
    const { doc } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    FakeSocket.last!.emit({ type: 'doc:saved', docId: doc.id, path: '/new/x.mockup.json' });
    expect(useDoc.getState().documents[0]).toMatchObject({
      path: '/new/x.mockup.json',
      dirty: false,
    });
  });

  it('MCP selection selects and requests focus; the editor selection is ignored', () => {
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

  it('request resolves with the ack and rejects with the error', async () => {
    const { doc } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const ws = FakeSocket.last!;
    const p = client.apply([{ type: 'renamePage', pageId: doc.pages[0]!.id, name: 'X' }]);
    const sent = ws.sent.at(-1)!;
    expect(sent.type).toBe('op:apply');
    ws.emit({ type: 'ack', reqId: sent.reqId as string, result: { revision: 2, results: [null] } });
    await expect(p).resolves.toEqual({ revision: 2, results: [null] });
    const p2 = client.undo();
    ws.emit({ type: 'error', reqId: ws.sent.at(-1)!.reqId as string, message: 'failed' });
    await expect(p2).rejects.toThrow('failed');
  });

  it('local selection change is published to the daemon, batched over time', () => {
    vi.useFakeTimers();
    try {
      const { doc, a, b, c } = makeDoc();
      FakeSocket.last!.emit(hello(doc));
      const sent = () => FakeSocket.last!.sent.filter((m) => m.type === 'selection:set');
      useUi.setState({ selection: [a.id] });
      vi.advanceTimersByTime(0);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({ docId: doc.id, nodeIds: [a.id] });
      // marquee: several consecutive changes become a single send with the last selection
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

  it('disconnect rejects pending requests immediately', async () => {
    const { doc } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    const p = client.undo();
    client.disconnect();
    await expect(p).rejects.toThrow('lost');
  });

  it('doc:closed removes the history and active:changed updates the revision', () => {
    const { doc } = makeDoc();
    const other = { ...structuredClone(doc), id: 'doc_other01' };
    FakeSocket.last!.emit(hello(doc));
    FakeSocket.last!.emit({
      type: 'doc:opened',
      info: { docId: other.id, name: 'Other', path: null, dirty: false, revision: 7 },
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

  it('old agent activity is discarded when new activity arrives', () => {
    const { doc, frame } = makeDoc();
    FakeSocket.last!.emit(hello(doc));
    useDoc.setState({ agentActivity: { fr_velho: Date.now() - 60_000 } });
    const node = createNodeFromTag('div', { name: 'New' });
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
