/**
 * Ferramentas das fases 6 a 8 em nós de componentes: o id virtual de um nó dentro de uma instância
 * (`in_x/...`) vira override; o id de um nó do principal edita o principal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expandDocument, findNode, getComponent, type Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const node = (id: string, type: Node['type'], tag: string, extra: Partial<Node> = {}): Node => ({
  id,
  type,
  name: id,
  tag,
  attrs: {},
  style: {},
  children: [],
  locked: false,
  hidden: false,
  ...extra,
});

describe('MCP: dados, efeitos e vetores dentro de componentes', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'teste', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
    daemon.store.applyOps(
      docId(),
      [
        {
          type: 'addComponent',
          component: {
            id: 'cp_lista01',
            name: 'Lista',
            props: [],
            variants: [],
            root: node('el_lista01', 'element', 'section', {
              children: [
                node('fx_fundo001', 'effect', 'canvas', {
                  effect: { kind: 'mesh-gradient', params: {} },
                }),
                node('rp_itens001', 'repeater', 'ul', {
                  data: [{ nome: 'Ana' }],
                  children: [node('tx_item0001', 'text', 'li', { text: '{{nome}}' })],
                }),
                node('sv_icone001', 'svg', 'svg', {
                  svg: '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#ff0000"/></svg>',
                }),
              ],
            }),
          },
        },
        {
          type: 'createNode',
          parentId: ws.frameId,
          node: node('in_lista01', 'instance', 'section', { componentId: 'cp_lista01' }),
        },
      ],
      { source: 'mcp', label: 'fixture' },
    );
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.resolveDocId();
  const doc = () => daemon.store.get(docId());
  const view = (id: string): Node => findNode(expandDocument(doc()), id)!.node;
  const overrides = () => findNode(doc(), 'in_lista01')!.node.overrides;

  it('bind_data e get_data no repetidor da instância gravam e leem o override', async () => {
    const r = await call('bind_data', {
      nodeId: 'in_lista01/rp_itens001',
      data: [{ nome: 'Caio' }, { nome: 'Duda' }],
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(overrides()?.['rp_itens001']?.data).toEqual([{ nome: 'Caio' }, { nome: 'Duda' }]);
    expect(getComponent(doc(), 'cp_lista01')!.root.children[1]!.data).toEqual([{ nome: 'Ana' }]);
    const g = await call('get_data', { nodeId: 'in_lista01/rp_itens001' });
    expect(g.isError, textOf(g)).toBeFalsy();
    expect(textOf(g)).toContain('Caio');
    // undo volta a instância ao principal
    await call('undo');
    expect(overrides()).toBeUndefined();
  });

  it('bind_data no nó do principal muda todas as instâncias', async () => {
    const r = await call('bind_data', { nodeId: 'rp_itens001', data: [{ nome: 'Zé' }] });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(view('in_lista01/rp_itens001').data).toEqual([{ nome: 'Zé' }]);
  });

  it('update_effect no efeito da instância vira override', async () => {
    const r = await call('update_effect', { nodeId: 'in_lista01/fx_fundo001', kind: 'grain' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(overrides()?.['fx_fundo001']?.effect?.kind).toBe('grain');
    expect(view('in_lista01/fx_fundo001').effect?.kind).toBe('grain');
    expect(getComponent(doc(), 'cp_lista01')!.root.children[0]!.effect?.kind).toBe('mesh-gradient');
  });

  it('get_html marca o repetidor dentro da instância e set_path vira override', async () => {
    const h = await call('get_html', { nodeId: 'in_lista01' });
    expect(textOf(h)).toContain('data-mockup-repeat="in_lista01/rp_itens001"');
    const s = await call('set_path', {
      nodeId: 'in_lista01/sv_icone001',
      d: 'M0 0H12V12H0Z',
    });
    expect(s.isError, textOf(s)).toBeFalsy();
    expect(overrides()?.['sv_icone001']?.vector).toBeDefined();
    expect(view('in_lista01/sv_icone001').svg).toContain('M 0 0 L 12 0 L 12 12 L 0 12 Z');
    expect(getComponent(doc(), 'cp_lista01')!.root.children[2]!.svg).toContain('width="24"');
  });
});
