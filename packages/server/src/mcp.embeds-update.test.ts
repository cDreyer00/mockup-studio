import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Node } from '@mockup/core';
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

describe('update_media: swapping the URL of a YouTube embed', () => {
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

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const embed = (): Node => {
    const doc = daemon.store.get(daemon.store.list()[0]!.docId);
    return find(doc.pages[0]!.frames[0]!, (n) => n.type === 'embed')!;
  };
  const insert = async (url: string): Promise<string> => {
    const r = await call('insert_embed', { parentId: ws.frameId, url });
    expect(r.isError, textOf(r)).toBeFalsy();
    return embed().id;
  };

  it('recomputes start from the new URL', async () => {
    const nodeId = await insert('https://youtu.be/dQw4w9WgXcQ?t=42');
    const r = await call('update_media', {
      nodeId,
      url: 'https://www.youtube.com/watch?v=abcdefghijk&t=10',
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(embed().embed).toMatchObject({
      provider: 'youtube',
      url: 'https://www.youtube.com/watch?v=abcdefghijk&t=10',
      params: { start: 10 },
    });
  });

  it('removes the old start when the new URL has no t=/start=', async () => {
    const nodeId = await insert('https://youtu.be/dQw4w9WgXcQ?t=42');
    await call('update_media', { nodeId, url: 'https://youtu.be/abcdefghijk' });
    expect(embed().embed?.url).toBe('https://youtu.be/abcdefghijk');
    expect(embed().embed?.params?.['start']).toBeUndefined();
  });

  it('explicit params.start takes precedence over the URL one', async () => {
    const nodeId = await insert('https://youtu.be/dQw4w9WgXcQ');
    await call('update_media', {
      nodeId,
      url: 'https://youtu.be/abcdefghijk?t=10',
      params: { start: 99 },
    });
    expect(embed().embed?.params).toMatchObject({ start: 99 });
  });

  it('keeps the other params when recomputing start', async () => {
    const nodeId = await insert('https://youtu.be/dQw4w9WgXcQ?t=42');
    await call('update_media', { nodeId, params: { mute: true } });
    await call('update_media', { nodeId, url: 'https://youtu.be/abcdefghijk' });
    expect(embed().embed?.params).toEqual({ mute: true });
  });
});
