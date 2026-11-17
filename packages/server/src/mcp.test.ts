import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

function idOf(re: RegExp, text: string): string {
  const id = re.exec(text)?.[1];
  if (!id) throw new Error('id não encontrado em: ' + text);
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

  it('ferramentas que precisam de documento continuam com erro orientativo sem documento aberto', async () => {
    const r = await call('get_tree_summary');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('open_document');
  });

  it('get_basic_info sem documento aberto orienta o próximo passo em vez de dar erro', async () => {
    const r = await call('get_basic_info');
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain('Nenhum documento aberto');
    expect(text).toContain('create_document');
    expect(text).toContain('open_document');
    // com docId explícito e inexistente continua sendo erro
    const bad = await call('get_basic_info', { docId: 'doc_inexistente' });
    expect(bad.isError).toBe(true);
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

  it('update_styles com valor vazio remove a propriedade', async () => {
    await call('open_document', { path: ws.file });
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Caixa' });
    const id = idOf(/(el_[0-9a-z]+)/, textOf(created));
    await call('update_styles', { nodeIds: [id], styles: { color: 'red' } });
    expect(textOf(await call('get_node_info', { nodeId: id }))).toContain('color: red');
    const u = await call('update_styles', { nodeIds: [id], styles: { color: '' } });
    expect(u.isError).toBeFalsy();
    expect(textOf(await call('get_node_info', { nodeId: id }))).not.toContain('color');
  });

  it('write_html replace em frame raiz converte o único nó de topo em frame', async () => {
    await call('open_document', { path: ws.file });
    const r = await call('write_html', {
      html: '<main style="background:#000"><h1>x</h1></main>',
      mode: 'replace',
      parentId: ws.frameId,
    });
    expect(r.isError).toBeFalsy();
    const newId = idOf(/(el_[0-9a-z]+)/, textOf(r));
    const info = textOf(await call('get_node_info', { nodeId: newId }));
    expect(info).toContain('tipo: frame');
    expect(info).toContain('nome: Desktop');
    expect(info).toContain('raiz da página');
    expect(info).toContain('posição: 0, 0');
    expect(info).toContain('width: 1440px');
    expect(info).toContain('height: 900px');
    expect(info).toContain('#000');
    expect((await call('get_node_info', { nodeId: ws.frameId })).isError).toBe(true);
  });

  it('write_html replace em frame raiz com dois irmãos orienta replace-children', async () => {
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

  it('rename_page e delete_page', async () => {
    await call('open_document', { path: ws.file });
    const cp = textOf(await call('create_page', { name: 'Extra' }));
    const pageId = idOf(/(pg_[0-9a-z]+)/, cp);
    const rn = await call('rename_page', { pageId, name: 'Mobile' });
    expect(rn.isError).toBeFalsy();
    expect(textOf(await call('get_basic_info'))).toContain('Mobile');
    expect((await call('rename_page', { pageId: 'pg_naoexiste', name: 'X' })).isError).toBe(true);
    const del = await call('delete_page', { pageId });
    expect(del.isError).toBeFalsy();
    expect(textOf(await call('get_basic_info'))).not.toContain('Mobile');
    const first = idOf(/\((pg_[0-9a-z]+)\)/, textOf(await call('get_basic_info')));
    const last = await call('delete_page', { pageId: first });
    expect(last.isError).toBe(true);
    expect(textOf(last)).toContain('última página');
  });

  it('set_node_flags oculta e bloqueia nós', async () => {
    await call('open_document', { path: ws.file });
    const none = await call('set_node_flags', { nodeIds: [ws.frameId] });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('hidden');
    const r = await call('set_node_flags', { nodeIds: [ws.frameId], hidden: true, locked: true });
    expect(r.isError).toBeFalsy();
    const info = textOf(await call('get_node_info', { nodeId: ws.frameId }));
    expect(info).toContain('bloqueado');
    expect(info).toContain('oculto');
    await call('set_node_flags', { nodeIds: [ws.frameId], hidden: false });
    const after = textOf(await call('get_node_info', { nodeId: ws.frameId }));
    expect(after).not.toContain('oculto');
    expect(after).toContain('bloqueado');
  });

  it('move_nodes com parentId null vira frame à direita do último', async () => {
    await call('open_document', { path: ws.file });
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Solto' });
    const id = idOf(/(el_[0-9a-z]+)/, textOf(created));
    const r = await call('move_nodes', { nodeIds: [id], parentId: null });
    expect(r.isError).toBeFalsy();
    const info = textOf(await call('get_node_info', { nodeId: id }));
    expect(info).toContain('raiz da página');
    expect(info).toContain('posição: 1540, 0');
    const bad = await call('move_nodes', { nodeIds: [id], parentId: null, pageId: 'pg_naoexiste' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Página não encontrada');
  });

  it('nó inexistente devolve isError', async () => {
    await call('open_document', { path: ws.file });
    const r = await call('update_styles', { nodeIds: ['el_naoexiste'], styles: { color: 'red' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Erro:');
    expect(textOf(r)).toContain('get_tree_summary');
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

  it('set_tag troca a tag e recusa tags bloqueadas', async () => {
    await call('open_document', { path: ws.file });
    const created = await call('create_node', { parentId: ws.frameId, tag: 'div', name: 'Caixa' });
    const id = idOf(/(el_[0-9a-z]+)/, textOf(created));
    const r = await call('set_tag', { nodeIds: [id], tag: 'section' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('section');
    const doc = daemon.store.get(daemon.store.list()[0]!.docId);
    expect(doc.pages[0]!.frames[0]!.children[0]!.tag).toBe('section');
    const bad = await call('set_tag', { nodeIds: [id], tag: 'script' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('bloqueada');
  });
});
