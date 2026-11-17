/**
 * QA: `mockup mcp` (stdio) against an ALREADY running daemon (discovered via daemon.json),
 * covering get_basic_info, write_html in the "Desktop 1440" frame, get_tree_summary and undo;
 * and recovery from a stale daemon.json (dead process).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDaemon, type DaemonHandle } from '@mockup/server';
import { createDocument, createNodeFromTag, serializeDocument } from '@mockup/core';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, '../dist/bin.js');

const textOf = (r: unknown): string =>
  ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

async function connect(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath, 'mcp'],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'qa-cli', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('mockup mcp against an existing daemon', () => {
  let dir: string;
  let daemon: DaemonHandle;
  let client: Client;
  let file: string;
  let frameId: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-qa-cli-'));
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir);
    const doc = createDocument('QA');
    const frame = createNodeFromTag('div', {
      isRoot: true,
      name: 'Desktop 1440',
      styles: { width: '1440px', height: '900px' },
      position: { x: 0, y: 0 },
    });
    frameId = frame.id;
    doc.pages[0]!.frames.push(frame);
    file = path.join(dir, 'qa.mockup.json');
    fs.writeFileSync(file, serializeDocument(doc), 'utf8');

    daemon = await startDaemon({ port: 0, dataDir, writeInfo: true, openFiles: [file] });
    const port = new URL(daemon.url).port;
    client = await connect({ MOCKUP_DATA_DIR: dataDir, MOCKUP_PORT: port });
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tools/list, get_basic_info, write_html, get_tree_summary and undo', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);

    const info = textOf(await client.callTool({ name: 'get_basic_info', arguments: {} }));
    expect(info).toContain('Desktop 1440');

    const before = textOf(
      await client.callTool({ name: 'get_tree_summary', arguments: { depth: 5 } }),
    );
    const w = await client.callTool({
      name: 'write_html',
      arguments: { parentId: frameId, html: '<section><h1>Hello</h1><p>World</p></section>' },
    });
    expect((w as { isError?: boolean }).isError).not.toBe(true);
    const after = textOf(
      await client.callTool({ name: 'get_tree_summary', arguments: { depth: 5 } }),
    );
    expect(after).toContain('Hello');
    // The real daemon sees the same change (proxy, not a copy)
    const docs = (await (await fetch(`${daemon.url}/api/docs`)).json()) as {
      documents: { dirty: boolean }[];
    };
    expect(docs.documents[0]!.dirty).toBe(true);

    await client.callTool({ name: 'undo', arguments: {} });
    expect(
      textOf(await client.callTool({ name: 'get_tree_summary', arguments: { depth: 5 } })),
    ).toBe(before);
  });

  it('stale daemon.json (dead pid, port with nobody) is ignored and a headless daemon starts', async () => {
    const dataDir = path.join(dir, 'stale');
    fs.mkdirSync(dataDir);
    fs.writeFileSync(
      path.join(dataDir, 'daemon.json'),
      JSON.stringify({
        port: 1,
        pid: 999999,
        startedAt: new Date().toISOString(),
        url: 'http://127.0.0.1:1',
        mcpUrl: 'http://127.0.0.1:1/mcp',
        wsUrl: 'ws://127.0.0.1:1/ws',
      }),
    );
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const c = await connect({ MOCKUP_DATA_DIR: dataDir, MOCKUP_PORT: String(port) });
    try {
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toContain('get_basic_info');
      expect(fs.existsSync(path.join(dataDir, 'daemon.log'))).toBe(true);
    } finally {
      await c.close().catch(() => undefined);
      const infoPath = path.join(dataDir, 'daemon.json');
      if (fs.existsSync(infoPath)) {
        const { pid } = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { pid: number };
        try {
          process.kill(pid);
        } catch {
          /* already stopped */
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});
