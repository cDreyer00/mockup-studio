import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findNode } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { createMcpServer } from './mcp/server.js';
import type { CaptureRequest, RenderProvider } from './render.js';
import { ScriptService } from './scripts/service.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
type Content = { type: string; text?: string; data?: string; mimeType?: string };

const contentOf = (r: unknown): Content[] => (r as { content: Content[] }).content;
const textOf = (r: unknown): string =>
  contentOf(r)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

describe('MCP: run_script e list_scripts', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];

  const render: RenderProvider = {
    async capture(req) {
      captures.push(req);
      return {
        data: PNG_1x1,
        mime: 'image/png',
        width: 1440,
        height: 900,
        pixelWidth: 1,
        pixelHeight: 1,
      };
    },
    async measure() {
      throw new Error('não usado');
    },
  };

  const start = async (withRender: boolean) => {
    ws = makeWorkspace();
    captures = [];
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      render: withRender ? render : undefined,
    });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  };
  const stop = async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.list()[0]!.docId;
  const names = (): string[] => {
    const out: string[] = [];
    const walk = (list: { name: string; children: unknown[] }[]) => {
      for (const n of list) {
        out.push(n.name);
        walk(n.children as never);
      }
    };
    walk(daemon.store.get(docId()).pages[0]!.frames as never);
    return out;
  };

  describe('sem render', () => {
    beforeEach(() => start(false));
    afterEach(stop);

    it('get_guide("scripts") devolve a API completa', async () => {
      const t = textOf(await call('get_guide', { topic: 'scripts' }));
      expect(t.startsWith('# ')).toBe(true);
      expect(t.length).toBeGreaterThan(200);
      for (const s of [
        'doc.select',
        'doc.selectOne',
        'doc.apply',
        'doc.screenshot',
        'doc.setTokens',
        'node.style',
        'duplicate',
        'timeout',
        'run_script',
      ]) {
        expect(t, s).toContain(s === 'timeout' ? 'Timeout' : s);
      }
    });

    it('lista as ferramentas com descrição curta, exemplo e parâmetros descritos', async () => {
      const { tools } = await client.listTools();
      for (const name of ['run_script', 'list_scripts']) {
        const t = tools.find((x) => x.name === name);
        expect(t, name).toBeTruthy();
        expect(t!.description!.length).toBeLessThanOrEqual(300);
        const props = (t!.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
        for (const [k, v] of Object.entries(props))
          expect(v.description, `${name}.${k}`).toBeTruthy();
      }
    });

    it('executa um script, devolve texto com ops, resultado e resumo; um undo desfaz', async () => {
      await call('create_node', {
        parentId: ws.frameId,
        tag: 'button',
        text: 'A',
        name: 'Botão A',
      });
      await call('create_node', {
        parentId: ws.frameId,
        tag: 'button',
        text: 'B',
        name: 'Botão B',
      });
      const r = await call('run_script', {
        code: `
          const botoes = doc.select("button");
          botoes.forEach((b, i) => { b.name = "CTA " + (i + 1); b.style.background = "#2563eb"; });
          console.log("achei", botoes.length);
          return botoes.map((b) => b.id).length;`,
      });
      expect(r.isError).toBeFalsy();
      const t = textOf(r);
      expect(t).toContain('Script ok: 4 op(s)');
      expect(t).toContain('achei 2');
      expect(t).toContain('Resultado: 2');
      expect(t).toContain('CTA 1');
      expect(t).toContain('CTA 2');
      expect(names()).toContain('CTA 2');
      const u = await call('undo');
      expect(textOf(u)).toContain('Desfeito');
      expect(names()).toContain('Botão A');
      expect(names()).toContain('Botão B');
      expect(names()).not.toContain('CTA 1');
    });

    it('script somente de leitura não aplica ops nem inclui resumo', async () => {
      const r = await call('run_script', { code: 'return doc.frames().map(f => f.name);' });
      const t = textOf(r);
      expect(t).toContain('Script ok: 0 op(s)');
      expect(t).toContain('"Desktop"');
      expect(t).not.toContain('Resumo:');
    });

    it('erro no script vira isError com logs e o número de ops já aplicadas', async () => {
      const r = await call('run_script', {
        code: `
          console.log("começando");
          doc.frames()[0].name = "Renomeado";
          throw new Error("deu ruim");`,
      });
      expect(r.isError).toBe(true);
      const t = textOf(r);
      expect(t).toContain('Script falhou: deu ruim');
      expect(t).toContain('começando');
      expect(t).toContain('1 op(s) já foram aplicadas');
      expect(names()).toContain('Renomeado');
      await call('undo');
      expect(names()).toContain('Desktop');
    });

    it('erro de sintaxe, timeout e tentativa de fuga são erros claros e o servidor continua', async () => {
      const syn = await call('run_script', { code: 'let = = 1' });
      expect(syn.isError).toBe(true);
      expect(textOf(syn)).toContain('Erro de sintaxe');
      const loop = await call('run_script', { code: 'while (true) {}', timeoutMs: 300 });
      expect(loop.isError).toBe(true);
      expect(textOf(loop)).toContain('tempo limite');
      const esc = await call('run_script', {
        code: 'return this.constructor.constructor("return process")();',
      });
      expect(esc.isError).toBe(true);
      const ok = await call('run_script', { code: 'return 1 + 1;' });
      expect(textOf(ok)).toContain('Resultado: 2');
    });

    it('exige code OU name e valida os tipos', async () => {
      const none = await call('run_script', {});
      expect(none.isError).toBe(true);
      expect(textOf(none)).toContain('code');
      const both = await call('run_script', { code: '1', name: 'x' });
      expect(both.isError).toBe(true);
      const big = await call('run_script', { code: '1', timeoutMs: 999_999 });
      expect(big.isError).toBe(true);
    });

    it('screenshot sem render explica a indisponibilidade', async () => {
      const r = await call('run_script', { code: 'doc.screenshot();' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('motor de render não está disponível');
    });

    it('list_scripts e run_script({ name }) usam a pasta scripts/ ao lado do documento', async () => {
      const empty = textOf(await call('list_scripts'));
      expect(empty).toContain('Nenhum script');
      expect(empty).toContain(path.join(ws.dir, 'scripts'));
      fs.mkdirSync(path.join(ws.dir, 'scripts'));
      fs.writeFileSync(
        path.join(ws.dir, 'scripts', 'contar-frames.js'),
        'return doc.frames().length;',
      );
      fs.writeFileSync(path.join(ws.dir, 'scripts', 'a-primeiro.js'), 'return 0;');
      const list = textOf(await call('list_scripts'));
      expect(list).toContain('2 script(s)');
      expect(list.indexOf('a-primeiro.js')).toBeLessThan(list.indexOf('contar-frames.js'));
      const r = await call('run_script', { name: 'contar-frames' });
      expect(textOf(r)).toContain('Resultado: 1');
      const miss = await call('run_script', { name: 'nao-existe' });
      expect(miss.isError).toBe(true);
      expect(textOf(miss)).toContain('não encontrado');
      const evil = await call('run_script', { name: '../../x' });
      expect(evil.isError).toBe(true);
      expect(textOf(evil)).toContain('inválido');
    });

    it('doc.create + doc.apply no MCP e o documento reflete as mudanças', async () => {
      const r = await call('run_script', {
        code: `
          const card = doc.create(doc.frames()[0], { tag: "section", name: "Card", children: [{ tag: "h2", text: "Oi" }] });
          doc.apply({ type: "updateStyles", nodeIds: [card.id], styles: { padding: "16px" } });
          return card.id;`,
      });
      expect(r.isError).toBeFalsy();
      const id = /Resultado: "(el_[0-9a-z]+)"/.exec(textOf(r))![1]!;
      const n = findNode(daemon.store.get(docId()), id)!.node;
      expect(n.style['padding']).toBe('16px');
      expect(n.children[0]!.text).toBe('Oi');
    });
  });

  describe('com render', () => {
    beforeEach(() => start(true));
    afterEach(stop);

    it('doc.screenshot() entra como imagem no resultado, antes do texto', async () => {
      const r = await call('run_script', {
        code: 'const i = doc.screenshot(); return i;',
      });
      expect(r.isError).toBeFalsy();
      const [img, txt] = contentOf(r);
      expect(img!.type).toBe('image');
      expect(img!.mimeType).toBe('image/png');
      expect(Buffer.from(img!.data!, 'base64').equals(PNG_1x1)).toBe(true);
      expect(txt!.text).toContain('Imagens: 1');
      expect(txt!.text).toContain(`${ws.frameId} 1440x900`);
      expect(captures[0]).toMatchObject({ nodeId: ws.frameId, scale: 1, format: 'png' });
    });
  });
});

describe('MCP: run_script dentro de um turno do assistente', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let turnOpen = true;

  beforeEach(async () => {
    ws = makeWorkspace();
    turnOpen = true;
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    const { docId } = await daemon.store.open(ws.file);
    const server = createMcpServer(daemon.store, {
      services: { scripts: new ScriptService(daemon.store) },
      turn: () => (turnOpen ? { turnId: 't1', docId, group: 'turno:t1' } : null),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(a);
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  it('o script entra no mesmo grupo de undo do turno (e não o fecha)', async () => {
    const { docId } = daemon.store.list()[0]!;
    const run = (code: string) => client.callTool({ name: 'run_script', arguments: { code } });
    await run('doc.frames()[0].name = "Um";');
    await client.callTool({
      name: 'rename_nodes',
      arguments: { nodeIds: [ws.frameId], names: ['Dois'] },
    });
    await run('doc.frames()[0].name = "Três";');
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Três');
    daemon.store.undo(docId, 'editor');
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Desktop');
  });

  it('turno encerrado: o script é recusado sem executar', async () => {
    turnOpen = false;
    const { docId } = daemon.store.list()[0]!;
    const r = await client.callTool({
      name: 'run_script',
      arguments: { code: 'doc.frames()[0].name = "X";' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('já terminou');
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Desktop');
  });
  it('o turno termina durante um script em laço de escritas: para e não grava mais', async () => {
    const { docId } = daemon.store.list()[0]!;
    const name = () => daemon.store.get(docId).pages[0]!.frames[0]!.name;
    setTimeout(() => (turnOpen = false), 300);
    const t0 = Date.now();
    const r = await client.callTool({
      name: 'run_script',
      arguments: {
        code: 'let i = 0; for (;;) { doc.frames()[0].name = "N" + i++; }',
        timeoutMs: 30_000,
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('turno do assistente terminou');
    expect(Date.now() - t0).toBeLessThan(3000);
    const depois = name();
    expect(depois).toMatch(/^N\d+$/);
    await new Promise((res) => setTimeout(res, 300));
    expect(name()).toBe(depois);
  });

  it('o turno termina durante um laço sem chamadas à API: o vigia encerra o worker', async () => {
    const { docId } = daemon.store.list()[0]!;
    setTimeout(() => (turnOpen = false), 300);
    const t0 = Date.now();
    const r = await client.callTool({
      name: 'run_script',
      arguments: {
        code: 'doc.frames()[0].name = "Uma vez"; while (true) {}',
        timeoutMs: 30_000,
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('turno do assistente terminou');
    expect(textOf(r)).toContain('1 op(s) já foram aplicadas');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(daemon.store.get(docId).pages[0]!.frames[0]!.name).toBe('Uma vez');
  });
});
