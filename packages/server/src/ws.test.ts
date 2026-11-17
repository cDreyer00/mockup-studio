import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { isAllowedOrigin, startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

describe('WebSocket', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
    });
  });
  afterEach(async () => {
    await daemon.close();
    ws.cleanup();
  });

  function connect() {
    const sock = new WebSocket(daemon.wsUrl);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    sock.on('message', (d) => {
      messages.push(JSON.parse(d.toString()) as Record<string, unknown>);
      waiters.splice(0).forEach((w) => w());
    });
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (;;) {
        const m = messages.find(pred);
        if (m) return m;
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    return { sock, waitFor };
  }

  it('hello, op:apply -> ack + doc:changed', async () => {
    const { sock, waitFor } = connect();
    const hello = await waitFor((m) => m.type === 'hello');
    const docId = hello.activeDocId as string;
    expect(docId).toBeTruthy();
    expect((hello.documents as unknown[]).length).toBe(1);

    sock.send(
      JSON.stringify({
        type: 'op:apply',
        reqId: 'r1',
        docId,
        ops: [{ type: 'updateStyles', nodeIds: [ws.frameId], styles: { background: '#000000' } }],
      }),
    );
    const ack = await waitFor((m) => m.type === 'ack' && m.reqId === 'r1');
    expect(ack).toBeTruthy();
    const changed = await waitFor((m) => m.type === 'doc:changed');
    expect(changed.revision).toBeGreaterThan(0);
    expect(changed.doc).toBeTruthy();
    expect(changed.source).toBe('editor');
    sock.close();
  });

  it('doc:saveAs writes to the new path and responds with the info', async () => {
    const { sock, waitFor } = connect();
    const hello = await waitFor((m) => m.type === 'hello');
    const docId = hello.activeDocId as string;
    const dest = path.join(ws.dir, 'copy');
    sock.send(JSON.stringify({ type: 'doc:saveAs', reqId: 's1', docId, path: dest }));
    const ack = await waitFor((m) => m.type === 'ack' && m.reqId === 's1');
    const target = path.join(ws.dir, 'copy.mockup.json');
    expect((ack.result as { path: string }).path).toBe(target);
    expect((await waitFor((m) => m.type === 'doc:saved')).path).toBe(target);
    expect(fs.existsSync(target)).toBe(true);
    sock.send(JSON.stringify({ type: 'doc:saveAs', reqId: 's2', docId }));
    expect(await waitFor((m) => m.type === 'error' && m.reqId === 's2')).toBeTruthy();
    sock.close();
  });

  it('invalid JSON and error with reqId', async () => {
    const { sock, waitFor } = connect();
    await waitFor((m) => m.type === 'hello');
    sock.send('not json');
    expect(await waitFor((m) => m.type === 'error' && m.reqId === undefined)).toBeTruthy();
    sock.send(
      JSON.stringify({ type: 'doc:open', reqId: 'r2', path: '/does/not/exist.mockup.json' }),
    );
    const err = await waitFor((m) => m.type === 'error' && m.reqId === 'r2');
    expect(String(err.message)).toContain('file');
    sock.close();
  });

  it('isAllowedOrigin', () => {
    for (const o of [
      undefined,
      'http://localhost:5173',
      'https://127.0.0.1:9',
      'http://[::1]:3000',
    ])
      expect(isAllowedOrigin(o), String(o)).toBe(true);
    for (const o of [
      'null',
      'file:///C:/app/index.html',
      'http://evil.com',
      'http://localhost.evil.com',
      'http://127.0.0.1.nip.io',
      'ftp://localhost',
      'garbage',
    ])
      expect(isAllowedOrigin(o), o).toBe(false);
  });

  it('rejects an external Origin with 403 and accepts localhost', async () => {
    const bad = new WebSocket(daemon.wsUrl, { headers: { Origin: 'http://evil.com' } });
    const status = await new Promise<number>((resolve, reject) => {
      bad.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      bad.on('open', () => reject(new Error('should not connect')));
      bad.on('error', () => undefined);
    });
    expect(status).toBe(403);

    const good = new WebSocket(daemon.wsUrl, { headers: { Origin: 'http://localhost:5173' } });
    await new Promise<void>((resolve, reject) => {
      good.on('open', () => resolve());
      good.on('error', reject);
    });
    good.close();
  });

  it('invalid op:apply becomes an error and does not change the document', async () => {
    const { sock, waitFor } = connect();
    const hello = await waitFor((m) => m.type === 'hello');
    const docId = hello.activeDocId as string;
    const rev = daemon.store.getRevision(docId);
    sock.send(
      JSON.stringify({
        type: 'op:apply',
        reqId: 'bad1',
        docId,
        ops: [{ type: 'createNode', parentId: ws.frameId, node: { id: 'x' } }],
      }),
    );
    const err = await waitFor((m) => m.type === 'error' && m.reqId === 'bad1');
    expect(String(err.message)).toContain('Invalid operation');
    sock.send(JSON.stringify({ type: 'op:apply', reqId: 'bad2', docId, ops: 'x' }));
    expect(await waitFor((m) => m.type === 'error' && m.reqId === 'bad2')).toBeTruthy();
    sock.send(JSON.stringify({ type: 'op:apply', reqId: 'bad3', ops: [] }));
    expect(await waitFor((m) => m.type === 'error' && m.reqId === 'bad3')).toBeTruthy();
    // `force` in deleteComponent is internal (only undo uses it): rejected at the public entry point.
    sock.send(
      JSON.stringify({
        type: 'op:apply',
        reqId: 'bad4',
        docId,
        ops: [{ type: 'deleteComponent', componentId: 'cp_x', force: true }],
      }),
    );
    const forced = await waitFor((m) => m.type === 'error' && m.reqId === 'bad4');
    expect(String(forced.message)).toContain('"force" in deleteComponent is internal');
    expect(daemon.store.getRevision(docId)).toBe(rev);
    sock.close();
  });

  it('hello and events carry history; doc:new and doc:close', async () => {
    const { sock, waitFor } = connect();
    const hello = await waitFor((m) => m.type === 'hello');
    const docId = hello.activeDocId as string;
    expect(hello.history).toEqual({ canUndo: false, canRedo: false });

    sock.send(
      JSON.stringify({
        type: 'op:apply',
        reqId: 'h1',
        docId,
        ops: [{ type: 'updateStyles', nodeIds: [ws.frameId], styles: { color: 'red' } }],
      }),
    );
    const changed = await waitFor((m) => m.type === 'doc:changed');
    expect(changed.history).toEqual({ canUndo: true, canRedo: false });

    const file = path.join(ws.dir, 'created.mockup.json');
    sock.send(JSON.stringify({ type: 'doc:new', reqId: 'n1', path: file, name: 'Created' }));
    const ack = await waitFor((m) => m.type === 'ack' && m.reqId === 'n1');
    const info = ack.result as { docId: string; path: string; doc?: unknown };
    expect(info.path).toBe(file);
    expect(info.doc).toBeUndefined();
    const opened = await waitFor((m) => m.type === 'doc:opened');
    expect(opened.history).toEqual({ canUndo: false, canRedo: false });
    expect(fs.existsSync(file)).toBe(true);

    sock.send(JSON.stringify({ type: 'doc:new', reqId: 'n2', path: 5, name: 'x' }));
    const bad = await waitFor((m) => m.type === 'error' && m.reqId === 'n2');
    expect(String(bad.message)).toContain('path');
    sock.send(JSON.stringify({ type: 'doc:close', reqId: 'c0' }));
    const bad2 = await waitFor((m) => m.type === 'error' && m.reqId === 'c0');
    expect(String(bad2.message)).toContain('docId');

    sock.send(JSON.stringify({ type: 'doc:close', reqId: 'c1', docId: info.docId }));
    const closeAck = await waitFor((m) => m.type === 'ack' && m.reqId === 'c1');
    expect(closeAck.result).toEqual({});
    await waitFor((m) => m.type === 'doc:closed' && m.docId === info.docId);
    expect(daemon.store.list().map((d) => d.docId)).not.toContain(info.docId);
    sock.close();
  });
});
