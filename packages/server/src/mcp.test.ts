import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

function idOf(re: RegExp, text: string): string {
  const id = re.exec(text)?.[1];
  if (!id) throw new Error('id not found in: ' + text);
  return id;
}

type Ws = ReturnType<typeof makeWorkspace>;

function textOf(r: unknown): string {
  const c = (r as { content: Array<{ type: string; text: string }> }).content;
  return c.map((x) => x.text).join('\n');
}

describe('MCP', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
  });

  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  it('lists tools and resources', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'write_html',
      'get_tree_summary',
      'get_basic_info',
      'undo',
      'redo',
      'create_frame',
    ]) {
      expect(names).toContain(n);
    }
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('guide://layout');
    const guide = await client.readResource({ uri: 'guide://getting-started' });
    expect(guide.contents[0]).toHaveProperty('text');
  });

  it('tools that need a document still return a guiding error when no document is open', async () => {
    const r = await call('get_tree_summary');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('open_document');
  });

  it('get_basic_info with no open document guides the next step instead of erroring', async () => {
    const r = await call('get_basic_info');
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain('No document open');
    expect(text).toContain('create_document');
    expect(text).toContain('open_document');
    // an explicit, nonexistent docId is still an error
    const bad = await call('get_basic_info', { docId: 'doc_missing' });
    expect(bad.isError).toBe(true);
  });

  it('write_html / get_tree_summary / undo / get_basic_info flow', async () => {
    const opened = await call('open_document', { path: ws.file });
    expect(opened.isError).toBeFalsy();

    const w = await call('write_html', {
      html: '<section class="hero"><h1>Hello</h1><p>Text</p></section>',
      css: '.hero{display:flex;gap:16px}',
      parentId: ws.frameId,
    });
    expect(w.isError).toBeFalsy();
    const wt = textOf(w);
    expect(wt).toContain('Hello');
    expect(wt).toContain('flex');

    expect(textOf(await call('get_tree_summary'))).toContain('Hello');

    const undone = await call('undo');
    expect(undone.isError).toBeFalsy();
    expect(textOf(await call('get_tree_summary'))).not.toContain('Hello');

    await call('redo');
    expect(textOf(await call('get_tree_summary'))).toContain('Hello');

    const info = textOf(await call('get_basic_info'));
    expect(info).toContain('Desktop');
    expect(info).toContain(ws.frameId);
    expect(info).toContain('write_html');
  });

  it('create_frame, update_styles and delete_nodes', async () => {
    await call('open_document', { path: ws.file });
    const f = textOf(await call('create_frame', { name: 'Mobile', width: 390, height: 800 }));
    expect(f).toContain('Mobile');
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Box' });
    const id = /(el_[0-9a-z]+)/.exec(textOf(created))?.[1];
    expect(id).toBeTruthy();
    const u = await call('update_styles', { nodeIds: [id], styles: { gap: '8px' } });
    expect(u.isError).toBeFalsy();
    const d = await call('delete_nodes', { nodeIds: [id] });
    expect(d.isError).toBeFalsy();
    expect(textOf(d)).not.toContain('Box');
  });

  it('write_html in replace-children and replace modes', async () => {
    await call('open_document', { path: ws.file });
    await call('write_html', { html: '<p>One</p>', parentId: ws.frameId });
    const rc = textOf(
      await call('write_html', {
        html: '<h2>Two</h2>',
        mode: 'replace-children',
        parentId: ws.frameId,
      }),
    );
    expect(rc).toContain('Two');
    expect(rc).not.toContain('One');
    const id = /(el_[0-9a-z]+|tx_[0-9a-z]+)/.exec(rc)?.[1];
    const rp = textOf(
      await call('write_html', { html: '<h3>Three</h3>', mode: 'replace', parentId: id }),
    );
    expect(rp).toContain('Three');
    expect(rp).not.toContain('Two');
  });

  it('update_styles with an empty value removes the property', async () => {
    await call('open_document', { path: ws.file });
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Box' });
    const id = idOf(/(el_[0-9a-z]+)/, textOf(created));
    await call('update_styles', { nodeIds: [id], styles: { color: 'red' } });
    expect(textOf(await call('get_node_info', { nodeId: id }))).toContain('color: red');
    const u = await call('update_styles', { nodeIds: [id], styles: { color: '' } });
    expect(u.isError).toBeFalsy();
    expect(textOf(await call('get_node_info', { nodeId: id }))).not.toContain('color');
  });

  it('write_html replace on a root frame converts the single top-level node into a frame', async () => {
    await call('open_document', { path: ws.file });
    const r = await call('write_html', {
      html: '<main style="background:#000"><h1>x</h1></main>',
      mode: 'replace',
      parentId: ws.frameId,
    });
    expect(r.isError).toBeFalsy();
    const newId = idOf(/(el_[0-9a-z]+)/, textOf(r));
    const info = textOf(await call('get_node_info', { nodeId: newId }));
    expect(info).toContain('type: frame');
    expect(info).toContain('name: Desktop');
    expect(info).toContain('page root');
    expect(info).toContain('position: 0, 0');
    expect(info).toContain('width: 1440px');
    expect(info).toContain('height: 900px');
    expect(info).toContain('#000');
    expect((await call('get_node_info', { nodeId: ws.frameId })).isError).toBe(true);
  });

  it('write_html replace on a root frame with two siblings points to replace-children', async () => {
    await call('open_document', { path: ws.file });
    const r = await call('write_html', {
      html: '<p>a</p><p>b</p>',
      mode: 'replace',
      parentId: ws.frameId,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('replace-children');
    expect((await call('get_node_info', { nodeId: ws.frameId })).isError).toBeFalsy();
  });

  it('rename_page and delete_page', async () => {
    await call('open_document', { path: ws.file });
    const cp = textOf(await call('create_page', { name: 'Extra' }));
    const pageId = idOf(/(pg_[0-9a-z]+)/, cp);
    const rn = await call('rename_page', { pageId, name: 'Mobile' });
    expect(rn.isError).toBeFalsy();
    expect(textOf(await call('get_basic_info'))).toContain('Mobile');
    expect((await call('rename_page', { pageId: 'pg_missing', name: 'X' })).isError).toBe(true);
    const del = await call('delete_page', { pageId });
    expect(del.isError).toBeFalsy();
    expect(textOf(await call('get_basic_info'))).not.toContain('Mobile');
    const first = idOf(/\((pg_[0-9a-z]+)\)/, textOf(await call('get_basic_info')));
    const last = await call('delete_page', { pageId: first });
    expect(last.isError).toBe(true);
    expect(textOf(last)).toContain('last page');
  });

  it('set_node_flags hides and locks nodes', async () => {
    await call('open_document', { path: ws.file });
    const none = await call('set_node_flags', { nodeIds: [ws.frameId] });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('hidden');
    const r = await call('set_node_flags', { nodeIds: [ws.frameId], hidden: true, locked: true });
    expect(r.isError).toBeFalsy();
    const info = textOf(await call('get_node_info', { nodeId: ws.frameId }));
    expect(info).toContain('locked');
    expect(info).toContain('hidden');
    await call('set_node_flags', { nodeIds: [ws.frameId], hidden: false });
    const after = textOf(await call('get_node_info', { nodeId: ws.frameId }));
    expect(after).not.toContain('hidden');
    expect(after).toContain('locked');
  });

  it('move_nodes with parentId null becomes a frame to the right of the last one', async () => {
    await call('open_document', { path: ws.file });
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Loose' });
    const id = idOf(/(el_[0-9a-z]+)/, textOf(created));
    const r = await call('move_nodes', { nodeIds: [id], parentId: null });
    expect(r.isError).toBeFalsy();
    const info = textOf(await call('get_node_info', { nodeId: id }));
    expect(info).toContain('page root');
    expect(info).toContain('position: 1540, 0');
    const bad = await call('move_nodes', { nodeIds: [id], parentId: null, pageId: 'pg_missing' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Page not found');
  });

  it('nonexistent node returns isError', async () => {
    await call('open_document', { path: ws.file });
    const r = await call('update_styles', { nodeIds: ['el_missing'], styles: { color: 'red' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Error:');
    expect(textOf(r)).toContain('get_tree_summary');
  });

  it('request without a session is rejected', async () => {
    const res = await fetch(daemon.mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('set_tag changes the tag and rejects blocked tags', async () => {
    await call('open_document', { path: ws.file });
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Box' });
    const id = idOf(/(el_[0-9a-z]+)/, textOf(created));
    const r = await call('set_tag', { nodeIds: [id], tag: 'section' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('section');
    const doc = daemon.store.get(daemon.store.list()[0]!.docId);
    expect(doc.pages[0]!.frames[0]!.children[0]!.tag).toBe('section');
    const bad = await call('set_tag', { nodeIds: [id], tag: 'script' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('blocked');
  });
});
