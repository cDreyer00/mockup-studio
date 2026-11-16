import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

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
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
  });

  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  it('lista ferramentas e recursos', async () => {
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

  it('fluxo write_html / get_tree_summary / undo / get_basic_info', async () => {
    const opened = await call('open_document', { path: ws.file });
    expect(opened.isError).toBeFalsy();

    const w = await call('write_html', {
      html: '<section class="hero"><h1>Olá</h1><p>Texto</p></section>',
      css: '.hero{display:flex;gap:16px}',
      parentId: ws.frameId,
    });
    expect(w.isError).toBeFalsy();
    const wt = textOf(w);
    expect(wt).toContain('Olá');
    expect(wt).toContain('flex');

    expect(textOf(await call('get_tree_summary'))).toContain('Olá');

    const undone = await call('undo');
    expect(undone.isError).toBeFalsy();
    expect(textOf(await call('get_tree_summary'))).not.toContain('Olá');

    await call('redo');
    expect(textOf(await call('get_tree_summary'))).toContain('Olá');

    const info = textOf(await call('get_basic_info'));
    expect(info).toContain('Desktop');
    expect(info).toContain(ws.frameId);
    expect(info).toContain('write_html');
  });

  it('create_frame, update_styles e delete_nodes', async () => {
    await call('open_document', { path: ws.file });
    const f = textOf(await call('create_frame', { name: 'Mobile', width: 390, height: 800 }));
    expect(f).toContain('Mobile');
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Caixa' });
    const id = /(el_[0-9a-z]+)/.exec(textOf(created))?.[1];
    expect(id).toBeTruthy();
    const u = await call('update_styles', { nodeIds: [id], styles: { gap: '8px' } });
    expect(u.isError).toBeFalsy();
    const d = await call('delete_nodes', { nodeIds: [id] });
    expect(d.isError).toBeFalsy();
    expect(textOf(d)).not.toContain('Caixa');
  });

  it('write_html nos modos replace-children e replace', async () => {
    await call('open_document', { path: ws.file });
    await call('write_html', { html: '<p>Um</p>', parentId: ws.frameId });
    const rc = textOf(
      await call('write_html', {
        html: '<h2>Dois</h2>',
        mode: 'replace-children',
        parentId: ws.frameId,
      }),
    );
    expect(rc).toContain('Dois');
    expect(rc).not.toContain('Um');
    const id = /(el_[0-9a-z]+|tx_[0-9a-z]+)/.exec(rc)?.[1];
    const rp = textOf(
      await call('write_html', { html: '<h3>Tres</h3>', mode: 'replace', parentId: id }),
    );
    expect(rp).toContain('Tres');
    expect(rp).not.toContain('Dois');
  });

  it('nó inexistente devolve isError', async () => {
    await call('open_document', { path: ws.file });
    const r = await call('update_styles', { nodeIds: ['el_naoexiste'], styles: { color: 'red' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Erro:');
    expect(textOf(r)).toContain('get_tree_summary');
  });

  it('sem documento aberto devolve erro orientativo', async () => {
    const r = await call('get_basic_info');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('open_document');
  });

  it('requisição sem sessão é rejeitada', async () => {
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
});
