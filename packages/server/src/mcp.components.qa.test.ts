import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Document } from '@mockup/core';
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

describe('MCP componentes (QA): bordas e sequências', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let captures: CaptureRequest[];
  let measures: { nodeId: string; doc: Document }[];

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
    async measure(t) {
      measures.push({ nodeId: t.nodeId, doc: t.doc });
      return {
        id: t.nodeId,
        name: 'Medido',
        tag: 'button',
        x: 0,
        y: 0,
        width: 80,
        height: 36,
        children: [],
      };
    },
  };

  beforeEach(async () => {
    ws = makeWorkspace();
    captures = [];
    measures = [];
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false, render });
    client = new Client({ name: 'teste', version: '0.0.0' });
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
  const fail = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    expect(r.isError, textOf(r)).toBe(true);
    return textOf(r);
  };
  const doc = async (): Promise<Document> => {
    const res = await fetch(`${daemon.url}/api/docs`);
    const { activeDocId } = (await res.json()) as { activeDocId: string };
    const r = await fetch(`${daemon.url}/api/docs/${activeDocId}`);
    return ((await r.json()) as { doc: Document }).doc;
  };
  const instanceId = (t: string): string => /Instância criada: (\S+)/.exec(t)![1]!;
  const insertButton = async (props: Record<string, unknown> = {}, extra = {}): Promise<string> =>
    instanceId(
      await ok('insert_component', {
        component: 'shadcn-like/Button',
        parentId: ws.frameId,
        props,
        ...extra,
      }),
    );

  const pages = async (): Promise<unknown> => {
    const d = await doc();
    return { pages: d.pages, components: d.components, tokens: d.tokens };
  };

  const count = async (): Promise<number> => {
    const d = await doc();
    return (d.components ?? []).length;
  };

  it('sequência longa misturando ops comuns e de componente com undo/redo pelo MCP', async () => {
    const before = JSON.stringify((await doc()).pages);
    const a = await insertButton({ variant: 'outline', label: 'A' });
    await ok('set_instance_props', { nodeIds: [a], set: { label: 'B' } });
    await ok('update_styles', { nodeIds: [ws.frameId], styles: { background: '#fafafa' } });
    await ok('set_instance_override', {
      nodeId: a,
      path: 'tx_sbtnlabl',
      style: { color: '#ff0000' },
    });
    const b = await insertButton({ label: 'C' });
    await ok('detach_instance', { nodeId: b });
    const afterAll = JSON.stringify(await pages());
    for (let i = 0; i < 6; i++) await ok('undo');
    expect(JSON.stringify((await doc()).pages)).toBe(before);
    expect(await count()).toBe(0);
    for (let i = 0; i < 6; i++) await ok('redo');
    expect(JSON.stringify(await pages())).toBe(afterAll);
  });

  it('props de tipo errado ou inexistentes são recusadas com mensagem, sem alterar o documento', async () => {
    const a = await insertButton();
    const snap = JSON.stringify(await doc());
    expect(
      await fail('set_instance_props', { nodeIds: [a], set: { variant: 'nao-existe' } }),
    ).toMatch(/opç|variant/i);
    expect(await fail('set_instance_props', { nodeIds: [a], set: { fantasma: 'x' } })).toContain(
      'fantasma',
    );
    expect(
      await fail('set_instance_props', { nodeIds: [ws.frameId], set: { label: 'x' } }),
    ).toMatch(/instância/);
    expect(
      await fail('insert_component', { component: 'shadcn-like/Button', parentId: 'el_nope' }),
    ).toBeTruthy();
    expect(JSON.stringify(await doc())).toBe(snap);
  });

  it('delete_component com instância viva é recusado e o aviso orienta; id inexistente falha', async () => {
    const a = await insertButton();
    const d = await doc();
    const id = d.components!.find((c) => c.name === 'Button')!.id;
    expect(await fail('delete_component', { componentId: id })).toMatch(/instân/i);
    expect(await fail('delete_component', { componentId: 'cp_naoexiste' })).toBeTruthy();
    // a instância continua expandindo normalmente
    expect(await ok('get_html', { nodeId: a })).toContain('<button');
    expect((await doc()).components!.some((c) => c.id === id)).toBe(true);
  });

  it('force em deleteComponent não é aceito por nenhuma ferramenta MCP', async () => {
    await insertButton();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of names) {
      const t = (await client.listTools()).tools.find((x) => x.name === n)!;
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/"force"/);
    }
  });

  it('documento antigo sem components: list_components e ops comuns funcionam e o arquivo não ganha a chave', async () => {
    const t = await ok('list_components');
    expect(t).toContain('(0)');
    await ok('update_styles', { nodeIds: [ws.frameId], styles: { background: '#123456' } });
    await ok('save_document');
    expect(fs.readFileSync(ws.file, 'utf8')).not.toContain('"components"');
  });
});
