import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';
import type { CaptureRequest, RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string };

const textOf = (r: unknown): string =>
  (r as { content: Content[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('MCP states: custom breakpoints and dark theme', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];

  const render: RenderProvider = {
    async capture(req) {
      captures.push(req);
      return {
        data: Buffer.from([0x89]),
        mime: 'image/png',
        width: 100,
        height: 50,
        pixelWidth: 100,
        pixelHeight: 50,
      };
    },
    async measure() {
      throw new Error('not used');
    },
  };

  beforeEach(async () => {
    ws = makeWorkspace();
    captures = [];
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false, render });
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
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.isError, textOf(r)).toBeFalsy();
    return textOf(r);
  };
  const created = (t: string): string => /Nodes created: ([^.\n,]+)/.exec(t)![1]!.trim();

  async function nodeIn(parentId: string, style: string): Promise<string> {
    return created(
      await ok('write_html', {
        parentId,
        tailwind: 'off',
        html: `<div style="${style}">x</div>`,
      }),
    );
  }

  it('custom breakpoint: md only applies from the document --breakpoint-md', async () => {
    await ok('set_tokens', { tokens: { '--breakpoint-md': '900px' } });
    const frame = /Frame created: (\S+)/.exec(
      await ok('create_frame', { name: 'Screen', width: 800, height: 600 }),
    )![1]!;
    const id = await nodeIn(frame, 'padding: 8px');
    await ok('update_styles', { nodeIds: [id], state: 'md', styles: { padding: '32px' } });
    // 800px < 900px: the frame does not activate md (with the 768px default it would).
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('padding: 8px');
    // state:'md' simulates the breakpoint (minimum width = 900px).
    expect(await ok('get_styles', { nodeIds: [id], state: 'md' })).toContain('padding: 32px');
  });

  it('a smaller custom breakpoint activates on a frame the default would not', async () => {
    await ok('set_tokens', { tokens: { '--breakpoint-md': '700px' } });
    const frame = /Frame created: (\S+)/.exec(
      await ok('create_frame', { name: 'Screen', width: 720, height: 600 }),
    )![1]!;
    const id = await nodeIn(frame, 'padding: 8px');
    await ok('update_styles', { nodeIds: [id], state: 'md', styles: { padding: '32px' } });
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('padding: 32px');
  });

  it('get_styles with state dark switches to the document dark theme', async () => {
    await ok('set_tokens', { tokens: { '--surface': '#ffffff' } });
    await ok('create_theme', { name: 'dark', overrides: { '--surface': '#0f172a' } });
    const id = await nodeIn(ws.frameId, 'background-color: var(--surface)');
    expect(await ok('get_styles', { nodeIds: [id] })).toContain('#ffffff');
    const dark = await ok('get_styles', { nodeIds: [id], state: 'dark' });
    expect(dark).toContain('#0f172a');
    expect(dark).not.toContain('#ffffff');
  });

  it('get_screenshot with state dark passes the state on to the render', async () => {
    await ok('create_theme', { name: 'dark', overrides: { '--surface': '#0f172a' } });
    await ok('get_screenshot', { nodeId: ws.frameId, state: 'dark' });
    expect(captures.at(-1)?.state).toBe('dark');
  });
});
