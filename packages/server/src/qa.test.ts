/**
 * MVP QA tests: MCP robustness, MCP -> WS real time and persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseDocument } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

function textOf(r: unknown): string {
  const c = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return c.map((x) => x.text ?? '').join('\n');
}
const isErr = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe('QA: MCP + daemon', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }).catch((e: Error) => ({
      isError: true,
      content: [{ type: 'text', text: `THROW: ${e.message}` }],
    }));

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
    });
    client = new Client({ name: 'qa', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  it('invalid parameters return an error and the daemon stays alive', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['get_node_info', { nodeId: 'el_missing' }],
      ['get_children', { nodeId: 'el_missing' }],
      ['create_frame', { name: 'X', width: -10, height: 100 }],
      ['create_frame', { name: 'X', width: 0, height: 100 }],
      ['write_html', { parentId: ws.frameId, html: '<p>a</p>', mode: 'invalid' }],
      ['write_html', { parentId: ws.frameId, html: '' }],
      ['write_html', { parentId: 'el_missing', html: '<p>a</p>' }],
      ['get_html', { nodeId: ws.frameId, mode: 'xyz' }],
      ['update_styles', { nodeIds: ['el_missing'], styles: { color: 'red' } }],
      ['delete_nodes', { nodeIds: ['el_missing'] }],
      ['move_nodes', { nodeIds: [ws.frameId], parentId: ws.frameId }],
      ['set_text', { nodeIds: [ws.frameId] }],
      ['get_guide', { topic: 'nonexistent' }],
      ['get_tree_summary', { depth: -1 }],
      ['rename_nodes', { nodeIds: [ws.frameId], names: [] }],
    ];
    const failures: string[] = [];
    for (const [name, args] of cases) {
      const r = await call(name, args);
      if (!isErr(r) || textOf(r).length < 5) {
        failures.push(`${name} ${JSON.stringify(args)} => isError=${isErr(r)} ${textOf(r)}`);
      }
    }
    expect(failures).toEqual([]);
    const info = await call('get_basic_info');
    expect(isErr(info)).toBe(false);
    const health = await fetch(`${daemon.url}/api/health`);
    expect(health.status).toBe(200);
  });

  it('core validation errors become isError and the daemon stays valid', async () => {
    const t1 = await call('create_node', { parentId: ws.frameId, tag: 'SCRIPT' });
    expect(isErr(t1)).toBe(true);
    expect(textOf(t1)).toContain('Invalid tag');

    const t2 = await call('set_attrs', { nodeIds: [ws.frameId], attrs: { onclick: 'x()' } });
    expect(isErr(t2)).toBe(true);

    const t3 = await call('write_html', { parentId: ws.frameId, html: '<iframe src=x></iframe>' });
    expect(isErr(t3)).toBe(true);
    expect(textOf(t3)).toContain('produced no nodes');

    expect(isErr(await call('get_basic_info'))).toBe(false);
    expect((await fetch(`${daemon.url}/api/health`)).status).toBe(200);
    await call('save_document');
    expect(() => parseDocument(fs.readFileSync(ws.file, 'utf8'))).not.toThrow();
  });

  it('get_tree_summary with depth 0, 1 and 10', async () => {
    await call('write_html', {
      parentId: ws.frameId,
      html: '<section><h1>T</h1><p>x</p></section>',
    });
    const d0 = textOf(await call('get_tree_summary', { depth: 0 }));
    const d1 = textOf(await call('get_tree_summary', { depth: 1 }));
    const d10 = textOf(await call('get_tree_summary', { depth: 10 }));
    expect(d0.split('\n').length).toBeLessThan(d1.split('\n').length + 1);
    expect(d10).toContain('h1');
    expect(d10.split('\n').length).toBeGreaterThan(d1.split('\n').length);
    expect(d10).not.toContain('undefined');
  });

  it('set_selection is reflected in get_selection', async () => {
    await call('write_html', { parentId: ws.frameId, html: '<p>a</p>' });
    const sel = await call('set_selection', { nodeIds: [ws.frameId] });
    expect(isErr(sel)).toBe(false);
    expect(textOf(await call('get_selection'))).toContain(ws.frameId);
    await call('set_selection', { nodeIds: [] });
    expect(textOf(await call('get_selection'))).not.toContain(ws.frameId);
    const bad = await call('set_selection', { nodeIds: ['el_missing'] });
    expect(textOf(bad).length).toBeGreaterThan(0);
  });

  it('create_page, set_tokens and get_tokens', async () => {
    const p = await call('create_page', { name: 'Page 2' });
    expect(isErr(p)).toBe(false);
    expect(textOf(await call('get_basic_info'))).toContain('Page 2');
    const t = await call('set_tokens', { tokens: { '--color-primary': '#0af', '--gap': '8px' } });
    expect(isErr(t), textOf(t)).toBe(false);
    const got = textOf(await call('get_tokens'));
    expect(got).toContain('--color-primary');
    expect(got).toContain('#0af');
    await call('set_tokens', { tokens: {}, unset: ['--gap'] });
    expect(textOf(await call('get_tokens'))).not.toContain('--gap');
  });

  it('get_html in both modes and guides for the 4 topics', async () => {
    await call('write_html', {
      parentId: ws.frameId,
      html: '<p class="a">hi</p>',
      css: '.a{color:red}',
    });
    const inl = textOf(await call('get_html', { nodeId: ws.frameId, mode: 'inline' }));
    const cls = textOf(await call('get_html', { nodeId: ws.frameId, mode: 'classes' }));
    expect(inl).toContain('color');
    expect(cls).toContain('<style');
    for (const topic of ['getting-started', 'layout', 'responsive', 'design-system']) {
      const g = await call('get_guide', { topic });
      expect(isErr(g)).toBe(false);
      expect(textOf(g).length).toBeGreaterThan(100);
      const res = await client.readResource({ uri: `guide://${topic}` });
      expect((res.contents[0] as { text: string }).text.length).toBeGreaterThan(100);
    }
  });

  it('write_html + undo/redo; undo past the history does not crash', async () => {
    const before = textOf(await call('get_tree_summary', { depth: 5 }));
    const w = await call('write_html', {
      parentId: ws.frameId,
      html: '<section><h1>Title</h1><p>Text</p></section>',
    });
    expect(isErr(w)).toBe(false);
    expect(textOf(await call('get_tree_summary', { depth: 5 }))).toContain('Title');
    await call('undo');
    expect(textOf(await call('get_tree_summary', { depth: 5 }))).toBe(before);
    await call('redo');
    expect(textOf(await call('get_tree_summary', { depth: 5 }))).toContain('Title');
    await call('undo');
    const extra = await call('undo');
    expect(textOf(extra).length).toBeGreaterThan(0);
  });

  it('a change via MCP reaches the WS client in real time', async () => {
    const sock = new WebSocket(daemon.wsUrl);
    const msgs: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => msgs.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise((r) => sock.once('open', r));
    await call('write_html', { parentId: ws.frameId, html: '<p>real time</p>' });
    const deadline = Date.now() + 3000;
    while (!msgs.some((m) => m.type === 'doc:changed') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    sock.close();
    expect(msgs.map((m) => m.type)).toContain('hello');
    expect(msgs.map((m) => m.type)).toContain('doc:changed');
  });

  it('save_document, autosave and reopening preserve the change', async () => {
    await call('write_html', { parentId: ws.frameId, html: '<h1>Persisted</h1>' });
    const s = await call('save_document');
    expect(isErr(s)).toBe(false);
    const raw = fs.readFileSync(ws.file, 'utf8');
    expect(raw).toContain('\n');
    const json = JSON.parse(raw) as { version: number };
    expect(json.version).toBe(1);
    expect(raw).toContain('Persisted');

    await call('write_html', { parentId: ws.frameId, html: '<h2>Auto</h2>' });
    await new Promise((r) => setTimeout(r, 1800));
    expect(fs.readFileSync(ws.file, 'utf8')).toContain('Auto');

    const dir2 = ws.dataDir + '2';
    const d2 = await startDaemon({ port: 0, dataDir: dir2, writeInfo: false });
    const c2 = new Client({ name: 'qa2', version: '0' });
    await c2.connect(new StreamableHTTPClientTransport(new URL(d2.mcpUrl)));
    await c2.callTool({ name: 'open_document', arguments: { path: ws.file } });
    const sum = textOf(await c2.callTool({ name: 'get_tree_summary', arguments: { depth: 5 } }));
    await c2.close();
    await d2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
    expect(sum).toContain('Persisted');
    expect(sum).toContain('Auto');
  });

  it('daemon listens only on loopback', () => {
    expect(daemon.url).toMatch(/127\.0\.0\.1/);
  });
});
