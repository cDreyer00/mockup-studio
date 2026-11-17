import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from './index.js';
import { GUIDE_TOPICS } from './mcp/guides.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;

function textOf(r: unknown): string {
  const c = (r as { content: Array<{ type: string; text: string }> }).content;
  return c.map((x) => x.text).join('\n');
}

describe('MCP: guias, instruções e erros de parâmetro', () => {
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

  it('os tópicos são os 14 esperados, sem tokens', () => {
    expect([...GUIDE_TOPICS]).toEqual([
      'getting-started',
      'design-system',
      'layout',
      'grid',
      'vectors',
      'responsive',
      'screenshot-loop',
      'export',
      'effects',
      'troubleshooting',
      'setup',
      'import',
      'assets',
      'data',
    ]);
  });

  it('get_guide devolve cada tópico com título', async () => {
    for (const topic of GUIDE_TOPICS) {
      const r = await call('get_guide', { topic });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t.length).toBeGreaterThan(200);
      expect(t.startsWith('# ')).toBe(true);
    }
  });

  it('getting-started tem exatamente os passos 1 a 6', async () => {
    const t = textOf(await call('get_guide', { topic: 'getting-started' }));
    const steps = [...t.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6]);
    for (const n of [
      'set_tokens',
      'create_frame',
      'write_html',
      'get_screenshot',
      'finish_working',
    ]) {
      expect(t).toContain(n);
    }
  });

  it('responsive cita Mobile, Tablet e Desktop; setup traz os comandos de registro', async () => {
    const r = textOf(await call('get_guide', { topic: 'responsive' }));
    for (const n of ['Mobile', 'Tablet', 'Desktop', '390x844', '768x1024', '1440x900']) {
      expect(r).toContain(n);
    }
    const s = textOf(await call('get_guide', { topic: 'setup' }));
    expect(s).toContain('claude mcp add --scope user mockup-studio -- mockup mcp');
    expect(s).toContain('[mcp_servers.mockup-studio]');
    expect(s).toContain('mockup doctor');
    const d = textOf(await call('get_guide', { topic: 'design-system' }));
    expect(d).toContain('set_tokens');
    expect(d).toContain('4.5:1');
  });

  it('resources guide://<topic> para todos os guias', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((x) => x.uri);
    for (const topic of GUIDE_TOPICS) {
      expect(uris).toContain(`guide://${topic}`);
      const res = await client.readResource({ uri: `guide://${topic}` });
      const c = res.contents[0] as { text: string; mimeType?: string };
      expect(c.mimeType).toBe('text/markdown');
      expect(c.text).toBe(textOf(await call('get_guide', { topic })));
    }
    expect(uris).not.toContain('guide://tokens');
  });

  it('get_guide com tópico inválido lista os válidos e traz exemplo', async () => {
    const r = await call('get_guide', { topic: 'tokens' });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain('topic');
    for (const topic of GUIDE_TOPICS) expect(t).toContain(topic);
    expect(t).toContain('Exemplo: get_guide(');
    expect(t).not.toContain('-32602');
  });

  it('create_frame sem width e com width inválido: mensagem acionável', async () => {
    const missing = await call('create_frame', { name: 'Desktop', height: 900 });
    expect(missing.isError).toBe(true);
    const t = textOf(missing);
    expect(t).toContain('width');
    expect(t).toContain('número');
    expect(t).toContain('Exemplo: create_frame(');
    expect(t).not.toContain('-32602');
    expect(t).not.toContain('"code"');

    const wrong = textOf(
      await call('create_frame', { name: 'Desktop', width: 'abc', height: 900 }),
    );
    expect(wrong).toContain('width');
    expect(wrong).toContain('número');
    expect(wrong).toContain('"abc"');
    expect(wrong).toContain('Exemplo: create_frame(');
    expect(wrong).not.toContain('-32602');
    expect(wrong).not.toContain('"expected"');
  });

  it('erros de ferramentas de tools/*.ts também são formatados', async () => {
    const e = await call('export', { nodeIds: ['fr_x'], format: 'pdf' });
    expect(e.isError).toBe(true);
    const t = textOf(e);
    expect(t).toContain('format');
    for (const f of ['png', 'jpg', 'svg', 'html', 'tailwind', 'react']) expect(t).toContain(f);
    expect(t).toContain('Exemplo: export(');

    const s = textOf(await call('get_screenshot', { scale: 5 }));
    expect(s).toContain('scale');
    expect(s).toContain('1, 2, 3');
    expect(s).toContain('Exemplo: get_screenshot(');

    const n = textOf(await call('update_styles', { nodeIds: [] }));
    expect(n).toContain('nodeIds');
    expect(n).toContain('pelo menos 1');
  });

  it('ferramenta inexistente sugere parecidas', async () => {
    const r = await call('write_htm', { html: '<p>x</p>' });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain('write_htm');
    expect(t).toContain('write_html');
    expect(t).not.toContain('-32602');
  });

  it('todas as ferramentas têm descrição curta e parâmetros descritos', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(40);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeLessThanOrEqual(300);
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [k, v] of Object.entries(props)) {
        expect(v.description, `${tool.name}.${k}`).toBeTruthy();
      }
    }
  });

  it('o servidor envia instructions citando getting-started', () => {
    const ins = client.getInstructions();
    expect(ins).toBeTruthy();
    expect(ins).toContain('getting-started');
    expect(ins).toContain('get_screenshot');
    expect(ins).toContain('finish_working');
  });
});
