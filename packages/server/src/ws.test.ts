import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDaemon, type DaemonHandle } from './index.js';
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

  it('JSON inválido e erro com reqId', async () => {
    const { sock, waitFor } = connect();
    await waitFor((m) => m.type === 'hello');
    sock.send('não é json');
    expect(await waitFor((m) => m.type === 'error' && m.reqId === undefined)).toBeTruthy();
    sock.send(JSON.stringify({ type: 'doc:open', reqId: 'r2', path: '/nao/existe.mockup.json' }));
    const err = await waitFor((m) => m.type === 'error' && m.reqId === 'r2');
    expect(String(err.message)).toContain('arquivo');
    sock.close();
  });
});
