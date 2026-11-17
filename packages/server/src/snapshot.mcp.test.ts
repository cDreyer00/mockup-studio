import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createNodeFromTag, findNode } from '@mockup/core';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type PageSnapshotRequest,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import { startDaemon, type DaemonHandle } from './index.js';
import type { RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** Payload com wrappers vazios e sem estilo, para o cleanup_imported ter o que fazer. */
function payload(url = 'https://exemplo.com/'): SnapshotPayload {
  const t = (text: string) => createNodeFromTag('p', { text });
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url,
      title: 'Exemplo',
      capturedAt: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root: createNodeFromTag('main', {
      name: 'Principal',
      styles: { width: '1000px', height: '500px' },
      children: [
        createNodeFromTag('div'),
        createNodeFromTag('div', {
          children: [
            createNodeFromTag('div', { styles: { width: '1000px' }, children: [t('Olá')] }),
          ],
        }),
      ],
    }),
    width: 1000,
    height: 500,
    assets: [],
    fonts: [],
    stats: { nodes: 6, truncated: false, warnings: ['Aviso da captura'] },
  };
}

describe('MCP: importação de sites', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;
  let requests: PageSnapshotRequest[];

  const render: RenderProvider = {
    capture: () => Promise.reject(new Error('não usado')),
    measure: () => Promise.reject(new Error('não usado')),
    async snapshot(req) {
      requests.push(req);
      return payload(req.kind === 'url' ? req.url : (req.baseUrl ?? 'about:blank'));
    },
  };

  const connect = async (withRender: boolean): Promise<void> => {
    ws = makeWorkspace();
    requests = [];
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
      render: withRender ? render : undefined,
    });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
  };
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = (): string => daemon.store.list()[0]!.docId;

  describe('com render', () => {
    beforeEach(() => connect(true));

    it('import_url cria o frame e repassa seletor, viewport e timeout ao motor', async () => {
      const r = await call('import_url', {
        url: 'https://exemplo.com/preco',
        selector: '#pricing',
        width: 1280,
        timeout_ms: 90_000,
        name: 'Preços',
      });
      expect(r.isError).toBeFalsy();
      expect(requests).toEqual([
        {
          kind: 'url',
          url: 'https://exemplo.com/preco',
          selector: '#pricing',
          viewport: { width: 1280, height: 900 },
          timeoutMs: 60_000,
        },
      ]);
      expect(daemon.store.get(docId()).pages[0]!.frames).toHaveLength(2);
    });

    it('resposta: id, nome, contagens, avisos, resumo e próximos passos', async () => {
      const r = await call('import_url', { url: 'https://exemplo.com/' });
      const t = textOf(r);
      const frame = daemon.store.get(docId()).pages[0]!.frames.at(-1)!;
      expect(t).toContain(`Importado de https://exemplo.com/: ${frame.id} "Exemplo"`);
      expect(t).toMatch(/\(\d+ nós, 0 imagens, sem fontes novas\)/);
      expect(t).toContain('Avisos:');
      expect(t).toContain('- Aviso da captura');
      expect(t).toContain(`get_screenshot(${frame.id})`);
      expect(t).toContain(`cleanup_imported(${frame.id})`);
      expect(frame.position).toEqual({ x: 1440 + 80, y: 0 });
      expect(findNode(daemon.store.get(docId()), frame.id)).toBeDefined();
    });

    it('usa a origem mcp, uma entrada de histórico, e valida parâmetros', async () => {
      const sources: string[] = [];
      daemon.store.on('doc:changed', (e) => sources.push(e.source));
      await call('import_url', { url: 'https://exemplo.com/' });
      expect(sources).toEqual(['mcp']);
      const bad = await call('import_url', { url: 'file:///etc/passwd' });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('http');
      const wide = await call('import_url', { url: 'https://x.com', width: 100 });
      expect(wide.isError).toBe(true);
      expect(textOf(wide)).toContain('width');
      expect(requests).toHaveLength(1);
    });

    it('import_html usa a captura com estilos computados quando há render', async () => {
      const r = await call('import_html', {
        html: '<h1>Oi</h1>',
        css: 'h1{color:red}',
        assets_base_url: 'https://exemplo.com/',
        selector: 'h1',
      });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toContain('captura com estilos computados');
      expect(requests[0]).toMatchObject({
        kind: 'html',
        html: '<h1>Oi</h1>',
        css: 'h1{color:red}',
        baseUrl: 'https://exemplo.com/',
        selector: 'h1',
        viewport: { width: 1440, height: 900 },
        timeoutMs: 20_000,
      });
    });

    it('cleanup_imported aplica numa única entrada de histórico; sem mudanças diz "Nada a limpar"', async () => {
      await call('import_url', { url: 'https://exemplo.com/' });
      const doc0 = daemon.store.get(docId());
      const frame = doc0.pages[0]!.frames.at(-1)!;
      const before = JSON.stringify(frame);
      const r = await call('cleanup_imported', { nodeId: frame.id });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t).toMatch(
        /1 nó\(s\) vazio\(s\) removido\(s\), 2 wrapper\(s\) desembrulhado\(s\), 1 tamanho\(s\)/,
      );
      const after = findNode(daemon.store.get(docId()), frame.id)!.node;
      expect(after.children).toHaveLength(1);
      expect(after.children[0]!.style.width).toBeUndefined();
      expect(after.children[0]!.text).toBe('Olá');
      // uma entrada: um undo restaura tudo
      daemon.store.undo(docId(), 'mcp');
      expect(JSON.stringify(findNode(daemon.store.get(docId()), frame.id)!.node)).toBe(before);
      daemon.store.redo(docId(), 'mcp');
      expect(textOf(await call('cleanup_imported', { nodeId: frame.id }))).toContain(
        'Nada a limpar',
      );
    });

    it('cleanup_imported com opções desligadas e nó inexistente', async () => {
      await call('import_url', { url: 'https://exemplo.com/' });
      const frame = daemon.store.get(docId()).pages[0]!.frames.at(-1)!;
      const none = await call('cleanup_imported', {
        nodeId: frame.id,
        remove_empty: false,
        unwrap: false,
        fluid: false,
      });
      expect(textOf(none)).toContain('Nada a limpar');
      const missing = await call('cleanup_imported', { nodeId: 'el_nao' });
      expect(missing.isError).toBe(true);
    });
  });

  describe('sem render', () => {
    beforeEach(() => connect(false));

    it('import_url devolve isError explicando e sugerindo import_html / app desktop', async () => {
      const r = await call('import_url', { url: 'https://exemplo.com/' });
      expect(r.isError).toBe(true);
      const t = textOf(r);
      expect(t).toContain('motor de render');
      expect(t).toContain('import_html');
      expect(t).toContain('app desktop');
      expect(daemon.store.get(docId()).pages[0]!.frames).toHaveLength(1);
    });

    it('import_html cai na conversão do core e avisa que a fidelidade é menor', async () => {
      const r = await call('import_html', {
        html: '<section><h1>Título</h1><p>Texto</p></section>',
        width: 800,
        height: 600,
        name: 'Seção',
      });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t).toContain('conversão sem render');
      expect(t).toContain('fidelidade menor');
      const frame = daemon.store.get(docId()).pages[0]!.frames.at(-1)!;
      expect(frame.name).toBe('Seção');
      expect(frame.style).toMatchObject({ width: '800px', height: '600px' });
      expect(t).toContain(frame.id);
    });
  });

  describe('guia', () => {
    beforeEach(() => connect(false));

    it("get_guide('import') cobre as ferramentas, a referência e as limitações", async () => {
      const t = textOf(await call('get_guide', { topic: 'import' }));
      expect(t.startsWith('# ')).toBe(true);
      for (const s of [
        'import_url',
        'import_html',
        'cleanup_imported',
        'Referência',
        'hidden:false',
        'set_tokens',
        'selector',
        'width',
        'login',
        'CORS',
      ]) {
        expect(t).toContain(s);
      }
      const { resources } = await client.listResources();
      expect(resources.map((x) => x.uri)).toContain('guide://import');
    });

    it('as ferramentas aparecem com título, descrição curta e parâmetros descritos', async () => {
      const { tools } = await client.listTools();
      for (const name of ['import_url', 'import_html', 'cleanup_imported']) {
        const tool = tools.find((x) => x.name === name)!;
        expect(tool, name).toBeDefined();
        expect(tool.description!.length).toBeLessThanOrEqual(300);
        const props = (tool.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >;
        for (const [k, v] of Object.entries(props))
          expect(v.description, `${name}.${k}`).toBeTruthy();
      }
    });
  });
});
