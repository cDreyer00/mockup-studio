import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Document, Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Content = { type: string; text?: string };
const textOf = (r: unknown): string =>
  (r as { content: Content[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function find(node: Node, pred: (n: Node) => boolean): Node | undefined {
  if (pred(node)) return node;
  for (const c of node.children) {
    const f = find(c, pred);
    if (f) return f;
  }
  return undefined;
}

describe('MCP: loopback URLs in embeds', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const doc = (): Document => daemon.store.get(daemon.store.list()[0]!.docId);
  const embeds = (): Node[] => {
    const out: Node[] = [];
    const walk = (n: Node) => {
      if (n.type === 'embed') out.push(n);
      n.children.forEach(walk);
    };
    walk(doc().pages[0]!.frames[0]!);
    return out;
  };

  it.each(['http://127.0.0.1:4747/', 'http://localhost:5173/'])(
    'insert_embed iframe rejects %s',
    async (url) => {
      const r = await call('insert_embed', { parentId: ws.frameId, url, provider: 'iframe' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('loopback');
      expect(embeds()).toHaveLength(0);
    },
  );

  it('insert_embed iframe accepts https://example.com', async () => {
    const r = await call('insert_embed', { parentId: ws.frameId, url: 'https://example.com' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(embeds()).toHaveLength(1);
  });

  it('update_media rejects changing the url to loopback', async () => {
    await call('insert_embed', { parentId: ws.frameId, url: 'https://example.com' });
    const e = find(doc().pages[0]!.frames[0]!, (n) => n.type === 'embed')!;
    const r = await call('update_media', { nodeId: e.id, url: 'http://127.0.0.1:4747/' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('loopback');
    expect(embeds()[0]!.embed!.url).toBe('https://example.com');
  });

  it('export html embeds the JSON of a small local Lottie (opens via file://)', async () => {
    const json = JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 60, w: 10, h: 10, layers: [] });
    const f = path.join(ws.dir, 'anim.json');
    fs.writeFileSync(f, json);
    const ins = await call('insert_embed', { parentId: ws.frameId, url: f });
    expect(ins.isError, textOf(ins)).toBeFalsy();
    const out = path.join(ws.dir, 'output');
    const r = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
    expect(r.isError, textOf(r)).toBeFalsy();
    const html = fs.readdirSync(out).find((n) => n.endsWith('.html'))!;
    const text = fs.readFileSync(path.join(out, html), 'utf8');
    expect(text).toContain('id="mockup-lottie-0"');
    expect(text).toContain('data-lottie-data="0"');
  });
});
