import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const LUCIDE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

describe('QA fase 7: vetores e grid pelo MCP', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'qa', version: '0.0.0' });
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
  const frame = (): Node => daemon.store.get(daemon.store.resolveDocId()).pages[0]!.frames[0]!;
  const nodeOf = (id: string): Node => frame().children.find((n) => n.id === id)!;
  const shape = async (args: Record<string, unknown>): Promise<string> => {
    const r = await call('create_shape', { parentId: ws.frameId, ...args });
    expect(r.isError, textOf(r)).toBeFalsy();
    return /(sv_[0-9a-z]+)/.exec(textOf(r))![1]!;
  };
  const insertSvg = async (svg: string): Promise<string> => {
    const r = await call('insert_svg', { parentId: ws.frameId, svg, x: 0, y: 0 });
    expect(r.isError, textOf(r)).toBeFalsy();
    return /(sv_[0-9a-z]+)/.exec(textOf(r))![1]!;
  };

  it('Lucide: get_svg devolve o raw idêntico; trocar a cor regenera; undo volta ao raw', async () => {
    const id = await insertSvg(LUCIDE);
    const before = nodeOf(id).svg!;
    expect(textOf(await call('get_svg', { nodeId: id }))).toContain(LUCIDE);
    expect(nodeOf(id).vector!.raw).toBeTruthy();

    const r = await call('set_vector_paint', { nodeId: id, stroke: '#ff0000' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(nodeOf(id).vector!.raw).toBeUndefined();
    expect(nodeOf(id).svg).toContain('#ff0000');
    expect(nodeOf(id).svg).not.toBe(before);

    await call('undo');
    expect(nodeOf(id).vector!.raw).toBeTruthy();
    expect(nodeOf(id).svg).toBe(before);
    expect(textOf(await call('get_svg', { nodeId: id }))).toContain(LUCIDE);
    await call('redo');
    expect(nodeOf(id).svg).toContain('#ff0000');
  });

  it('set_path recusa d inválido com mensagem clara e não altera o nó', async () => {
    const id = await shape({ shape: 'rect', x: 0, y: 0, width: 50, height: 50 });
    const d0 = nodeOf(id).vector!.paths[0]!.d;
    for (const d of ['M', 'L 1 2', '', 'M 0 0 L', 'M 0 0 L 1 x', 'M 0 0 Q 1 1']) {
      const r = await call('set_path', { nodeId: id, d });
      expect(r.isError, `d=${JSON.stringify(d)}`).toBe(true);
      expect(textOf(r).length).toBeGreaterThan(10);
    }
    expect(nodeOf(id).vector!.paths[0]!.d).toBe(d0);
  });

  it('boolean_op: união, subtração, interseção e exclusão entre formas livres', async () => {
    for (const op of ['union', 'subtract', 'intersect', 'exclude']) {
      const a = await shape({ shape: 'rect', x: 0, y: 0, width: 100, height: 100 });
      const b = await shape({ shape: 'ellipse', x: 50, y: 50, width: 100, height: 100 });
      const r = await call('boolean_op', { nodeIds: [a, b], op, name: `R-${op}` });
      expect(r.isError, `${op}: ${textOf(r)}`).toBeFalsy();
      const res = frame().children.find((n) => n.name === `R-${op}`)!;
      expect(res.vector!.paths.length).toBeGreaterThan(0);
      expect(res.vector!.paths[0]!.d).toMatch(/^M/);
      expect(nodeOf(a)).toBeUndefined();
      expect(nodeOf(b)).toBeUndefined();
      const w = parseFloat(res.style['width']!);
      const h = parseFloat(res.style['height']!);
      if (op === 'union') {
        expect(w).toBeCloseTo(150, 0);
        expect(h).toBeCloseTo(150, 0);
      }
      if (op === 'intersect') {
        expect(w).toBeLessThan(60);
        expect(h).toBeLessThan(60);
      }
      if (op === 'subtract') expect(w).toBeCloseTo(100, 0);
      await call('undo');
      expect(nodeOf(a)).toBeDefined();
      expect(nodeOf(b)).toBeDefined();
      await call('delete_nodes', { nodeIds: [a, b] });
    }
  });

  it('boolean_op de formas disjuntas na interseção não derruba o daemon', async () => {
    const a = await shape({ shape: 'rect', x: 0, y: 0, width: 20, height: 20 });
    const b = await shape({ shape: 'rect', x: 200, y: 200, width: 20, height: 20 });
    const r = await call('boolean_op', { nodeIds: [a, b], op: 'intersect' });
    expect(textOf(r).length).toBeGreaterThan(0);
    expect((await call('get_tree_summary')).isError).toBeFalsy();
  });

  it('boolean_op entre nós em fluxo sem render é recusado com mensagem clara', async () => {
    const a = await shape({ shape: 'rect', width: 40, height: 40 });
    const b = await shape({ shape: 'rect', width: 40, height: 40 });
    const r = await call('boolean_op', { nodeIds: [a, b], op: 'union' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/em fluxo|position: absolute/);
    expect(nodeOf(a)).toBeDefined();
  });

  it('set_grid 3x2 com áreas, place_in_grid com span e get_layout sem render explica', async () => {
    await call('write_html', {
      parentId: ws.frameId,
      html: '<div style="width:600px;height:200px"><div>a</div><div>b</div><div>c</div></div>',
    });
    const boxId = frame().children.find((n) => n.children.length === 3)!.id;
    const r = await call('set_grid', {
      nodeId: boxId,
      columns: 3,
      rows: 2,
      gap: 8,
      areas: ['h h s', 'm m s'],
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(nodeOf(boxId).style['display']).toBe('grid');
    const [a, b, c] = nodeOf(boxId).children;
    expect((await call('place_in_grid', { nodeIds: [a!.id], area: 'h' })).isError).toBeFalsy();
    const p = await call('place_in_grid', {
      nodeIds: [b!.id],
      column: 1,
      row: 2,
      span: { columns: 2, rows: 1 },
    });
    expect(p.isError, textOf(p)).toBeFalsy();
    expect(nodeOf(boxId).children[1]!.style['grid-column']).toBe('1 / span 2');
    expect(
      (await call('set_grid', { nodeId: boxId, columns: 3, areas: ['a a', 'a'] })).isError,
    ).toBe(true);
    expect(
      (await call('set_grid', { nodeId: boxId, columns: 2, areas: ['a b', 'b a'] })).isError,
    ).toBe(true);
    expect((await call('place_in_grid', { nodeIds: [c!.id], area: 'zzz' })).isError).toBe(true);
    const lay = await call('get_layout', { nodeId: boxId });
    expect(lay.isError).toBe(true);
    expect(textOf(lay)).toMatch(/render|Electron/i);
  });

  it('exportação com 2 vetores com gradiente: ids de gradiente não colidem', async () => {
    const grad = (c1: string, c2: string) => ({
      type: 'linear',
      stops: [
        { offset: 0, color: c1 },
        { offset: 1, color: c2 },
      ],
    });
    const a = await shape({ shape: 'rect', x: 0, y: 0, width: 50, height: 50 });
    const b = await shape({ shape: 'star', x: 60, y: 0, width: 50, height: 50 });
    await call('set_vector_paint', { nodeId: a, fill: grad('#ff0000', '#0000ff') });
    await call('set_vector_paint', { nodeId: b, fill: grad('#00ff00', '#ffff00') });
    expect(nodeOf(a).svg).toContain('linearGradient');
    for (const format of ['html', 'react', 'tailwind']) {
      const out = textOf(await call('get_code', { nodeId: ws.frameId, format }));
      const ids = [...out.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]!);
      const gids = ids.filter((i) => /-g-/.test(i));
      expect(new Set(gids).size, `${format}: ${gids.join(',')}`).toBe(gids.length);
      expect(gids.length, format).toBeGreaterThanOrEqual(2);
      for (const m of out.matchAll(/url\(#([^)]+)\)/g))
        expect(ids, `${format} ${m[1]}`).toContain(m[1]);
    }
  });

  it('insert_svg sanitiza script, onload e javascript:; href http(s) permanece (observação)', async () => {
    const id = await insertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><path d="M0 0 L5 5" onclick="x()"/></a><a xlink:href="JaVaScRiPt:alert(4)"><rect width="3" height="3"/></a><foreignObject><div>x</div></foreignObject><a href="https://example.com"><circle r="2"/></a></svg>',
    );
    const s = nodeOf(id).svg!;
    expect(s).not.toMatch(/<script/i);
    expect(s).not.toMatch(/onload|onclick/i);
    expect(s).not.toMatch(/javascript:/i);
    expect(s).not.toMatch(/foreignObject/i);
    const raw = nodeOf(id).vector?.raw ?? '';
    expect(raw).not.toMatch(/<script|onload|javascript:/i);
    // observação (comportamento atual, não requisito): href http(s) em <a> é mantido
    expect(s).toContain('href="https://example.com"');
  });
});
