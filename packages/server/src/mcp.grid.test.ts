import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

describe('MCP grid', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
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
  const doc = () => daemon.store.get(daemon.store.resolveDocId());
  const frame = (): Node => doc().pages[0]!.frames[0]!;

  /** Cria um contêiner com N filhos e devolve os ids. */
  async function container(n = 3): Promise<{ box: Node; kids: Node[] }> {
    const kidsHtml = Array.from({ length: n }, (_, i) => `<div class="k">K${i}</div>`).join('');
    const w = await call('write_html', {
      html: `<section class="box">${kidsHtml}</section>`,
      parentId: ws.frameId,
    });
    expect(w.isError, textOf(w)).toBeFalsy();
    const box = frame().children[0]!;
    return { box, kids: box.children };
  }

  it('set_grid 3x2 com gap e áreas', async () => {
    const { box } = await container(2);
    const r = await call('set_grid', {
      nodeId: box.id,
      columns: 3,
      rows: 2,
      gap: 16,
      areas: ['a b c', 'd d e'],
      alignItems: 'start',
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain('get_layout');
    const s = frame().children[0]!.style;
    expect(s['display']).toBe('grid');
    expect(s['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
    expect(s['grid-template-rows']).toBe('repeat(2, minmax(0, 1fr))');
    expect(s['gap']).toBe('16px');
    expect(s['grid-template-areas']).toBe('"a b c" "d d e"');
    expect(s['align-items']).toBe('start');
  });

  it('set_grid aceita texto CSS, lista e rejeita entradas ruins', async () => {
    const { box } = await container(1);
    const css = await call('set_grid', { nodeId: box.id, columns: '1fr 200px minmax(100px, 1fr)', columnGap: 8, rowGap: '12px' });
    expect(css.isError, textOf(css)).toBeFalsy();
    const s = frame().children[0]!.style;
    expect(s['grid-template-columns']).toBe('1fr 200px minmax(100px, 1fr)');
    expect(s['column-gap']).toBe('8px');
    expect(s['row-gap']).toBe('12px');

    const list = await call('set_grid', { nodeId: box.id, columns: ['200px', '1fr'], gap: 10 });
    expect(list.isError, textOf(list)).toBeFalsy();
    const s2 = frame().children[0]!.style;
    expect(s2['grid-template-columns']).toBe('200px 1fr');
    expect(s2['gap']).toBe('10px');
    expect(s2['column-gap']).toBeUndefined();

    const bad = await call('set_grid', { nodeId: box.id, columns: '1fr banana' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('banana');
    const badAreas = await call('set_grid', { nodeId: box.id, columns: 2, areas: ['a b', 'a'] });
    expect(badAreas.isError).toBe(true);
    expect(textOf(badAreas)).toContain('mesmo número de células');
    const lshape = await call('set_grid', { nodeId: box.id, columns: 2, areas: ['a a', 'a b', 'b a'] });
    expect(lshape.isError).toBe(true);
    expect(textOf(lshape)).toContain('retângulo');
  });

  it('place_in_grid com span e área nomeada', async () => {
    const { box, kids } = await container(3);
    await call('set_grid', { nodeId: box.id, columns: 3, rows: 2, areas: ['h h h', 'a b c'] });
    const r = await call('place_in_grid', {
      nodeIds: [kids[0]!.id],
      column: 2,
      row: 1,
      span: { columns: 2, rows: 1 },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    let k0 = frame().children[0]!.children[0]!.style;
    expect(k0['grid-column']).toBe('2 / span 2');
    expect(k0['grid-row']).toBe('1');

    await call('place_in_grid', { nodeIds: [kids[1]!.id], column: 1, row: 2, span: 3 });
    expect(frame().children[0]!.children[1]!.style['grid-column']).toBe('1 / span 3');

    const area = await call('place_in_grid', { nodeIds: [kids[0]!.id], area: 'h' });
    expect(area.isError, textOf(area)).toBeFalsy();
    k0 = frame().children[0]!.children[0]!.style;
    expect(k0['grid-area']).toBe('h');
    expect(k0['grid-column']).toBeUndefined();

    const noArea = await call('place_in_grid', { nodeIds: [kids[2]!.id], area: 'zz' });
    expect(noArea.isError).toBe(true);
    expect(textOf(noArea)).toContain('Áreas: h, a, b, c');

    const beyond = await call('place_in_grid', { nodeIds: [kids[2]!.id], column: 3, span: 2 });
    expect(textOf(beyond)).toContain('passa das 3 coluna');
  });

  it('place_in_grid remove longhands e grid-area conflitantes ao gravar grid-column/grid-row', async () => {
    const { box, kids } = await container(2);
    await call('set_grid', { nodeId: box.id, columns: 3, rows: 2 });
    const id = kids[0]!.id;
    await call('update_styles', {
      nodeIds: [id],
      styles: {
        'grid-column-start': '2',
        'grid-column-end': 'span 2',
        'grid-row-start': '1',
        'grid-row-end': '2',
        'grid-area': 'x',
      },
    });
    expect(frame().children[0]!.children[0]!.style['grid-column-start']).toBe('2');
    const r = await call('place_in_grid', { nodeIds: [id], column: 3, row: 2 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const st = frame().children[0]!.children[0]!.style;
    expect(st['grid-column']).toBe('3');
    expect(st['grid-row']).toBe('2');
    for (const k of ['grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end', 'grid-area']) {
      expect(st[k], k).toBeUndefined();
    }
  });

  it('place_in_grid erra com mensagem útil quando o pai não é grid', async () => {
    const { box, kids } = await container(1);
    const r = await call('place_in_grid', { nodeIds: [kids[0]!.id], column: 1, row: 1 });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain('não é um grid');
    expect(t).toContain(`set_grid(nodeId: "${box.id}"`);
    const none = await call('place_in_grid', { nodeIds: [kids[0]!.id] });
    expect(none.isError).toBe(true);
  });

  it('write_html com grid CSS chega ao documento', async () => {
    const w = await call('write_html', {
      html: '<div class="g"><div class="a">A</div><div class="b">B</div></div>',
      css: '.g{display:grid;grid-template-columns:repeat(3, 1fr);gap:12px}.a{grid-column:1 / span 2}.b{grid-row:2}',
      parentId: ws.frameId,
    });
    expect(w.isError, textOf(w)).toBeFalsy();
    const g = frame().children[0]!;
    expect(g.style['display']).toBe('grid');
    expect(g.style['grid-template-columns']).toBe('repeat(3, 1fr)');
    expect(g.children[0]!.style['grid-column']).toBe('1 / span 2');
    expect(g.children[1]!.style['grid-row']).toBe('2');
    const lay = await call('place_in_grid', { nodeIds: [g.children[1]!.id], column: 3, row: 2 });
    expect(lay.isError, textOf(lay)).toBeFalsy();
  });

  it('get_guide grid e vectors', async () => {
    const g = textOf(await call('get_guide', { topic: 'grid' }));
    expect(g.startsWith('# CSS Grid')).toBe(true);
    for (const n of ['set_grid', 'place_in_grid', 'grid-template-columns', 'get_layout']) expect(g).toContain(n);
    const v = textOf(await call('get_guide', { topic: 'vectors' }));
    for (const n of ['create_shape', 'insert_svg', 'set_path', 'set_vector_paint', 'boolean_op', 'flatten', 'text_to_outlines'])
      expect(v).toContain(n);
  });

  it('exportação Tailwind e React mantém o grid', async () => {
    const { box, kids } = await container(2);
    await call('set_grid', { nodeId: box.id, columns: 3, gap: 16 });
    await call('place_in_grid', { nodeIds: [kids[0]!.id], column: 1, span: 2 });
    const tw = textOf(await call('get_code', { nodeId: box.id, format: 'tailwind' }));
    expect(tw).toContain('grid');
    expect(tw).toMatch(/grid-cols-3|grid-template-columns/);
    expect(tw).toMatch(/col-span-2|grid-column|col-\[/);
    const html = textOf(await call('get_code', { nodeId: box.id, format: 'html' }));
    expect(html).toContain('display: grid');
    const react = textOf(await call('get_code', { nodeId: box.id, format: 'react' }));
    expect(react).toContain('grid');
  });
});
