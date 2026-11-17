import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createNode } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('MCP remix', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;
  let docId: string;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
    docId = daemon.store.resolveDocId();
    daemon.store.applyOps(
      docId,
      [
        { type: 'updateStyles', nodeIds: [ws.frameId], styles: { background: '#3b82f6' } },
        {
          type: 'createNode',
          parentId: ws.frameId,
          node: createNode({
            id: 'el_btn00001',
            tag: 'button',
            style: { 'background-color': '#2563eb', padding: '12px 20px' },
          }),
        },
      ],
      { source: 'mcp' },
    );
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const frames = () => daemon.store.get(docId).pages[0]!.frames;

  it('the remix tool is listed with a short description', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'remix');
    expect(t).toBeTruthy();
    expect(t!.description!.length).toBeLessThanOrEqual(300);
    expect(t!.annotations?.readOnlyHint).toBe(false);
  });

  it('color-scale creates the frames, returns ids and summary, selects and undoes in a single undo', async () => {
    const r = await call('remix', { nodeId: 'el_btn00001', kind: 'color-scale', count: 4 });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frames()).toHaveLength(5);
    const created = frames().slice(1);
    const text = textOf(r);
    expect(text).toContain('4 variation');
    for (const f of created) expect(text).toContain(f.id);
    expect(text).toContain('Desktop — shade 50');
    expect(text).toContain('summary of the first 3 of 4');
    expect(daemon.store.getSelection(docId).sort()).toEqual(created.map((f) => f.id).sort());

    const undone = await call('undo');
    expect(undone.isError, textOf(undone)).toBeFalsy();
    expect(frames()).toHaveLength(1);
  });

  it('spacing and layout via MCP; errors become isError with a clear message', async () => {
    const sp = await call('remix', { nodeId: ws.frameId, kind: 'spacing', count: 2 });
    expect(sp.isError, textOf(sp)).toBeFalsy();
    expect(textOf(sp)).toContain('compact');
    expect(frames()).toHaveLength(3);

    const lay = await call('remix', { nodeId: 'el_btn00001', kind: 'layout' });
    expect(lay.isError).toBe(true);
    expect(textOf(lay)).toContain('flex');

    const noNode = await call('remix', { nodeId: 'el_none0001', kind: 'spacing' });
    expect(noNode.isError).toBe(true);
    expect(textOf(noNode)).toContain('not found');
    expect(frames()).toHaveLength(3);
  });

  it('kind ai without a prompt gives guidance; out-of-range params are rejected', async () => {
    const ai = await call('remix', { nodeId: ws.frameId, kind: 'ai' });
    expect(ai.isError).toBe(true);
    expect(textOf(ai)).toContain('prompt');
    const bad = await call('remix', { nodeId: ws.frameId, kind: 'color-scale', count: 11 });
    expect(bad.isError).toBe(true);
    expect(frames()).toHaveLength(1);
  });
});
