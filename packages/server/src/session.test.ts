import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MCP sessions', () => {
  let daemon: DaemonHandle;

  beforeEach(async () => {
    daemon = await startDaemon({ port: 0, writeInfo: false, sessionTtlMs: 100 });
  });
  afterEach(async () => {
    await daemon.close();
  });

  const post = (headers: Record<string, string>, body: unknown) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: daemon.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  it('unknown session responds 404 JSON-RPC; without a session and without initialize, 400', async () => {
    const r = await post(
      { 'mcp-session-id': 'does-not-exist' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    );
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
    const r2 = await post({}, { jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(r2.status).toBe(400);
  });

  it('initialize with an external Host is rejected and with a local Host works', async () => {
    const bad = await post({ Host: 'evil.com' }, INIT);
    expect(bad.status).toBe(403);
    expect(daemon.sessionCount()).toBe(0);
    const ok = await post({}, INIT);
    expect(ok.status).toBe(200);
    expect(daemon.sessionCount()).toBe(1);
  });

  it('SDK client session: counts 1 and returns to 0 after terminateSession', async () => {
    const longLived = await startDaemon({ port: 0, writeInfo: false, sessionTtlMs: 60_000 });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(longLived.mcpUrl));
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      expect(longLived.sessionCount()).toBe(1);
      await transport.terminateSession();
      expect(longLived.sessionCount()).toBe(0);
      await client.close();
    } finally {
      await longLived.close();
    }
  });

  it('session idle beyond the TTL is closed', async () => {
    const ok = await post({}, INIT);
    expect(ok.status).toBe(200);
    expect(daemon.sessionCount()).toBe(1);
    for (let i = 0; i < 40 && daemon.sessionCount() > 0; i++) await sleep(50);
    expect(daemon.sessionCount()).toBe(0);
  });
});
