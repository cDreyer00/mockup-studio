/**
 * Testes de QA do MVP: robustez do MCP, tempo real MCP -> WS e persistência.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

  it('parâmetros inválidos devolvem erro e o daemon continua vivo', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['get_node_info', { nodeId: 'el_naoexiste' }],
      ['get_children', { nodeId: 'el_naoexiste' }],
      ['create_frame', { name: 'X', width: -10, height: 100 }],
      ['create_frame', { name: 'X', width: 0, height: 100 }],
      ['write_html', { parentId: ws.frameId, html: '<p>a</p>', mode: 'invalido' }],
      ['write_html', { parentId: ws.frameId, html: '' }],
      ['write_html', { parentId: 'el_naoexiste', html: '<p>a</p>' }],
      ['get_html', { nodeId: ws.frameId, mode: 'xyz' }],
      ['update_styles', { nodeIds: ['el_naoexiste'], styles: { color: 'red' } }],
      ['delete_nodes', { nodeIds: ['el_naoexiste'] }],
      ['move_nodes', { nodeIds: [ws.frameId], parentId: ws.frameId }],
      ['set_text', { nodeIds: [ws.frameId] }],
      ['get_guide', { topic: 'inexistente' }],
      ['get_tree_summary', { depth: -1 }],
      ['rename_nodes', { nodeIds: [ws.frameId], names: [] }],
    ];
    const falhas: string[] = [];
    for (const [name, args] of cases) {
      const r = await call(name, args);
      if (!isErr(r) || textOf(r).length < 5) {
        falhas.push(`${name} ${JSON.stringify(args)} => isError=${isErr(r)} ${textOf(r)}`);
      }
    }
    expect(falhas).toEqual([]);
    const info = await call('get_basic_info');
    expect(isErr(info)).toBe(false);
    const health = await fetch(`${daemon.url}/api/health`);
    expect(health.status).toBe(200);
  });

  it('get_tree_summary com depth 0, 1 e 10', async () => {
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

  it('set_selection reflete em get_selection', async () => {
    await call('write_html', { parentId: ws.frameId, html: '<p>a</p>' });
    const sel = await call('set_selection', { nodeIds: [ws.frameId] });
    expect(isErr(sel)).toBe(false);
    expect(textOf(await call('get_selection'))).toContain(ws.frameId);
    await call('set_selection', { nodeIds: [] });
    expect(textOf(await call('get_selection'))).not.toContain(ws.frameId);
    const bad = await call('set_selection', { nodeIds: ['el_naoexiste'] });
    expect(textOf(bad).length).toBeGreaterThan(0);
  });

  it('create_page, set_tokens e get_tokens', async () => {
    const p = await call('create_page', { name: 'Página 2' });
    expect(isErr(p)).toBe(false);
    expect(textOf(await call('get_basic_info'))).toContain('Página 2');
    const t = await call('set_tokens', { tokens: { '--color-primary': '#0af', '--gap': '8px' } });
    expect(isErr(t), textOf(t)).toBe(false);
    const got = textOf(await call('get_tokens'));
    expect(got).toContain('--color-primary');
    expect(got).toContain('#0af');
    await call('set_tokens', { tokens: {}, unset: ['--gap'] });
    expect(textOf(await call('get_tokens'))).not.toContain('--gap');
  });

  it('get_html nos dois modos e guias nos 4 tópicos', async () => {
    await call('write_html', {
      parentId: ws.frameId,
      html: '<p class="a">oi</p>',
      css: '.a{color:red}',
    });
    const inl = textOf(await call('get_html', { nodeId: ws.frameId, mode: 'inline' }));
    const cls = textOf(await call('get_html', { nodeId: ws.frameId, mode: 'classes' }));
    expect(inl).toContain('color');
    expect(cls).toContain('<style');
    for (const topic of ['getting-started', 'layout', 'responsive', 'tokens']) {
      const g = await call('get_guide', { topic });
      expect(isErr(g)).toBe(false);
      expect(textOf(g).length).toBeGreaterThan(100);
      const res = await client.readResource({ uri: `guide://${topic}` });
      expect((res.contents[0] as { text: string }).text.length).toBeGreaterThan(100);
    }
  });

  it('write_html + undo/redo; undo além do histórico não derruba', async () => {
    const before = textOf(await call('get_tree_summary', { depth: 5 }));
    const w = await call('write_html', {
      parentId: ws.frameId,
      html: '<section><h1>Título</h1><p>Texto</p></section>',
    });
    expect(isErr(w)).toBe(false);
    expect(textOf(await call('get_tree_summary', { depth: 5 }))).toContain('Título');
    await call('undo');
    expect(textOf(await call('get_tree_summary', { depth: 5 }))).toBe(before);
    await call('redo');
    expect(textOf(await call('get_tree_summary', { depth: 5 }))).toContain('Título');
    await call('undo');
    const extra = await call('undo');
    expect(textOf(extra).length).toBeGreaterThan(0);
  });

  it('mudança via MCP chega ao cliente WS em tempo real', async () => {
    const sock = new WebSocket(daemon.wsUrl);
    const msgs: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => msgs.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise((r) => sock.once('open', r));
    await call('write_html', { parentId: ws.frameId, html: '<p>tempo real</p>' });
    const deadline = Date.now() + 3000;
    while (!msgs.some((m) => m.type === 'doc:changed') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    sock.close();
    expect(msgs.map((m) => m.type)).toContain('hello');
    expect(msgs.map((m) => m.type)).toContain('doc:changed');
  });

  it('save_document, autosave e reabertura preservam a mudança', async () => {
    await call('write_html', { parentId: ws.frameId, html: '<h1>Persistido</h1>' });
    const s = await call('save_document');
    expect(isErr(s)).toBe(false);
    const raw = fs.readFileSync(ws.file, 'utf8');
    expect(raw).toContain('\n');
    const json = JSON.parse(raw) as { version: number };
    expect(json.version).toBe(1);
    expect(raw).toContain('Persistido');

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
    expect(sum).toContain('Persistido');
    expect(sum).toContain('Auto');
  });

  it('daemon escuta só em loopback', () => {
    expect(daemon.url).toMatch(/127\.0\.0\.1/);
  });
});
