/**
 * Phase 6 to 8 tools on component nodes: the virtual id of a node inside an instance
 * (`in_x/...`) becomes an override; the id of a main component node edits the main component.
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

describe('MCP: data, effects and vectors inside components', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
    daemon.store.applyOps(
      docId(),
      [
        {
          type: 'addComponent',
          component: {
            id: 'cp_list01',
            name: 'List',
            props: [],
            variants: [],
            root: node('el_list01', 'element', 'section', {
              children: [
                node('fx_bg000001', 'effect', 'canvas', {
                  effect: { kind: 'mesh-gradient', params: {} },
                }),
                node('rp_items001', 'repeater', 'ul', {
                  data: [{ name: 'Ana' }],
                  children: [node('tx_item0001', 'text', 'li', { text: '{{name}}' })],
                }),
                node('sv_icon0001', 'svg', 'svg', {
                  svg: '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="#ff0000"/></svg>',
                }),
              ],
            }),
          },
        },
        {
          type: 'createNode',
          parentId: ws.frameId,
          node: node('in_list01', 'instance', 'section', { componentId: 'cp_list01' }),
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
  const overrides = () => findNode(doc(), 'in_list01')!.node.overrides;

  it('bind_data and get_data on the instance repeater write and read the override', async () => {
    const r = await call('bind_data', {
      nodeId: 'in_list01/rp_items001',
      data: [{ name: 'Caio' }, { name: 'Duda' }],
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(overrides()?.['rp_items001']?.data).toEqual([{ name: 'Caio' }, { name: 'Duda' }]);
    expect(getComponent(doc(), 'cp_list01')!.root.children[1]!.data).toEqual([{ name: 'Ana' }]);
    const g = await call('get_data', { nodeId: 'in_list01/rp_items001' });
    expect(g.isError, textOf(g)).toBeFalsy();
    expect(textOf(g)).toContain('Caio');
    // undo returns the instance to the main component
    await call('undo');
    expect(overrides()).toBeUndefined();
  });

  it('bind_data on the main component node changes all instances', async () => {
    const r = await call('bind_data', { nodeId: 'rp_items001', data: [{ name: 'Ze' }] });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(view('in_list01/rp_items001').data).toEqual([{ name: 'Ze' }]);
  });

  it('update_effect on the instance effect becomes an override', async () => {
    const r = await call('update_effect', { nodeId: 'in_list01/fx_bg000001', kind: 'grain' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(overrides()?.['fx_bg000001']?.effect?.kind).toBe('grain');
    expect(view('in_list01/fx_bg000001').effect?.kind).toBe('grain');
    expect(getComponent(doc(), 'cp_list01')!.root.children[0]!.effect?.kind).toBe('mesh-gradient');
  });

  it('get_html marks the repeater inside the instance and set_path becomes an override', async () => {
    const h = await call('get_html', { nodeId: 'in_list01' });
    expect(textOf(h)).toContain('data-mockup-repeat="in_list01/rp_items001"');
    const s = await call('set_path', {
      nodeId: 'in_list01/sv_icon0001',
      d: 'M0 0H12V12H0Z',
    });
    expect(s.isError, textOf(s)).toBeFalsy();
    expect(overrides()?.['sv_icon0001']?.vector).toBeDefined();
    expect(view('in_list01/sv_icon0001').svg).toContain('M 0 0 L 12 0 L 12 12 L 0 12 Z');
    expect(getComponent(doc(), 'cp_list01')!.root.children[2]!.svg).toContain('width="24"');
  });
});
