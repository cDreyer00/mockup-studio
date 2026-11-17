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

const LUCIDE_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

describe('MCP vetores', () => {
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
  const children = (): Node[] => doc().pages[0]!.frames[0]!.children;
  const idIn = (re: RegExp, t: string): string => {
    const m = re.exec(t);
    if (!m) throw new Error(`id não encontrado em: ${t}`);
    return m[1]!;
  };
  const shape = async (args: Record<string, unknown>): Promise<string> => {
    const r = await call('create_shape', { parentId: ws.frameId, ...args });
    expect(r.isError, textOf(r)).toBeFalsy();
    return idIn(/(sv_[0-9a-z]+)/, textOf(r));
  };
  const nodeOf = (id: string): Node => children().find((n) => n.id === id)!;

  it('create_shape cria cada forma com vetor editável', async () => {
    for (const kind of ['rect', 'ellipse', 'line', 'polygon', 'star'] as const) {
      const id = await shape({ shape: kind, x: 10, y: 20, width: 80, height: kind === 'line' ? 0 : 60 });
      const n = nodeOf(id);
      expect(n.type).toBe('svg');
      expect(n.vector?.paths).toHaveLength(1);
      expect(n.svg).toContain('<path');
      expect(n.style['position']).toBe('absolute');
    }
    const star = children().at(-1)!;
    expect(star.vector!.paths[0]!.d).toMatch(/^M/);
  });

  it('create_shape separa a tinta do vetor dos estilos do nó e posiciona', async () => {
    const id = await shape({
      shape: 'rect',
      width: 120,
      height: 40,
      cornerRadius: 8,
      styles: { fill: '#ff0000', stroke: '#000000', 'stroke-width': '3', 'border-radius': '4px', opacity: '0.5' },
    });
    const n = nodeOf(id);
    expect(n.vector!.paths[0]).toMatchObject({ fill: '#ff0000', stroke: '#000000', strokeWidth: 3, opacity: 0.5 });
    expect(n.style['border-radius']).toBe('4px');
    expect(n.style['fill']).toBeUndefined();
    expect(n.style['position']).toBeUndefined();
    expect(n.style['display']).toBe('block');
    expect(n.style['width']).toBe('120px');
  });

  it('create_shape com polígono de 6 lados e erros de parâmetro', async () => {
    const id = await shape({ shape: 'polygon', sides: 6, width: 100, height: 100 });
    expect((nodeOf(id).vector!.paths[0]!.d.match(/L/g) ?? []).length).toBe(5);
    const bad = await call('create_shape', { parentId: 'nada', shape: 'rect' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Nó não encontrado');
    const zero = await call('create_shape', { parentId: ws.frameId, shape: 'rect', width: 0, height: 10 });
    expect(zero.isError).toBe(true);
    expect(textOf(zero)).toContain('maiores que 0');
  });

  it('insert_svg com ícone Lucide preserva o raw e get_svg informa', async () => {
    const r = await call('insert_svg', { parentId: ws.frameId, svg: LUCIDE_CHECK, name: 'Check', width: 32 });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain('editáveis');
    const id = idIn(/(sv_[0-9a-z]+)/, textOf(r));
    const n = nodeOf(id);
    expect(n.vector!.raw).toBeTruthy();
    expect(n.vector!.paths).toHaveLength(1);
    expect(n.style['width']).toBe('32px');
    expect(n.style['height']).toBe('32px');
    const g = textOf(await call('get_svg', { nodeId: id }));
    expect(g).toContain('original preservado');
    expect(g).toContain('p1');
    expect(g).toContain('M20 6 9 17l-5-5');
    expect(g).toContain('<svg');
  });

  it('insert_svg avisa quando o SVG não é editável e rejeita lixo', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>';
    const r = await call('insert_svg', { parentId: ws.frameId, svg });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain('NÃO editável');
    const bad = await call('insert_svg', { parentId: ws.frameId, svg: '<div>oi</div>' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('SVG inválido');
  });

  it('set_vector_paint muda a cor, regenera o markup e aceita gradiente', async () => {
    const ins = await call('insert_svg', { parentId: ws.frameId, svg: LUCIDE_CHECK });
    const id = idIn(/(sv_[0-9a-z]+)/, textOf(ins));
    const r = await call('set_vector_paint', { nodeId: id, stroke: '#ff0000', strokeWidth: 4 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const n = nodeOf(id);
    expect(n.vector!.raw).toBeUndefined();
    expect(n.vector!.paths[0]).toMatchObject({ stroke: '#ff0000', strokeWidth: 4 });
    expect(n.svg).toContain('stroke="#ff0000"');
    expect(textOf(await call('get_svg', { nodeId: id }))).toContain('regenerado');

    const g = await call('set_vector_paint', {
      nodeId: id,
      fill: {
        type: 'linear',
        stops: [
          { offset: 0, color: '#f00' },
          { offset: 1, color: '#00f' },
        ],
      },
    });
    expect(g.isError, textOf(g)).toBeFalsy();
    expect(nodeOf(id).svg).toContain('linearGradient');
    expect(textOf(await call('get_svg', { nodeId: id }))).toContain('gradiente linear');

    const none = await call('set_vector_paint', { nodeId: id });
    expect(none.isError).toBe(true);
    const unknown = await call('set_vector_paint', { nodeId: id, fill: '#000', pathIds: ['zz'] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('zz');
  });

  it('set_path substitui o d, valida e ajusta o viewBox com fit', async () => {
    const id = await shape({ shape: 'rect', x: 10, y: 10, width: 100, height: 100 });
    const r = await call('set_path', { nodeId: id, d: 'M 0 0 L 50 0 L 25 40 Z' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(nodeOf(id).vector!.paths[0]!.d).toContain('L 50 0');
    expect(nodeOf(id).svg).toContain('L 50 0');

    const fit = await call('set_path', { nodeId: id, d: 'M 0 0 L 50 0 L 25 40 Z', fit: true });
    expect(fit.isError, textOf(fit)).toBeFalsy();
    const vb = nodeOf(id).vector!.viewBox;
    expect(vb.width).toBeCloseTo(50, 0);
    expect(vb.height).toBeCloseTo(40, 0);
    expect(parseFloat(nodeOf(id).style['width']!)).toBeCloseTo(50, 0);

    const bad = await call('set_path', { nodeId: id, d: 'isso não é path' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Path data');
    const nope = await call('set_path', { nodeId: id, d: 'M 0 0 L 1 1', pathId: 'x9' });
    expect(nope.isError).toBe(true);
    expect(textOf(nope)).toContain('p1');
  });

  it('boolean_op union de 2 formas e flatten', async () => {
    const a = await shape({ shape: 'rect', x: 0, y: 0, width: 100, height: 100 });
    const b = await shape({ shape: 'ellipse', x: 50, y: 50, width: 100, height: 100 });
    const before = children().length;
    const r = await call('boolean_op', { nodeIds: [a, b], op: 'union', name: 'Uniao' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(children()).toHaveLength(before - 1);
    expect(children().some((n) => n.id === a || n.id === b)).toBe(false);
    const res = children().find((n) => n.name === 'Uniao')!;
    expect(res.vector!.paths.length).toBeGreaterThan(0);
    expect(res.vector!.paths[0]!.d).toMatch(/^M/);

    const one = await call('boolean_op', { nodeIds: [res.id], op: 'union' });
    expect(one.isError).toBe(true);

    const c = await shape({ shape: 'star', x: 200, y: 0, width: 50, height: 50 });
    const f = await call('flatten', { nodeIds: [res.id, c] });
    expect(f.isError, textOf(f)).toBeFalsy();
    expect(children().some((n) => n.id === res.id || n.id === c)).toBe(false);
    expect(children().some((n) => n.type === 'svg')).toBe(true);
  });

  it('flatten de um nó junta os paths num só', async () => {
    const a = await shape({ shape: 'rect', width: 20, height: 20 });
    const b = await shape({ shape: 'rect', width: 20, height: 20, x: 30, y: 0 });
    const f = await call('flatten', { nodeIds: [a, b] });
    expect(f.isError, textOf(f)).toBeFalsy();
    const flat = children().find((n) => n.type === 'svg')!;
    expect(flat.vector!.paths.length).toBeGreaterThanOrEqual(2);
    const g = await call('flatten', { nodeIds: [flat.id] });
    expect(g.isError, textOf(g)).toBeFalsy();
    expect(children().find((n) => n.id === flat.id)!.vector!.paths).toHaveLength(1);
  });

  it('get_svg em nó não svg dá erro acionável', async () => {
    const r = await call('get_svg', { nodeId: ws.frameId });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('não um svg');
  });

  it('text_to_outlines: converte quando há fonte ou explica o erro', async () => {
    await call('write_html', {
      html: '<p style="font-family: Arial, sans-serif; font-size: 24px">Olá</p>',
      parentId: ws.frameId,
    });
    const tx = children().find((n) => n.type === 'text')!;
    const r = await call('text_to_outlines', { nodeIds: [tx.id] });
    const t = textOf(r);
    if (r.isError) {
      expect(t).toMatch(/fonte|font/i);
    } else {
      expect(children().some((n) => n.type === 'svg')).toBe(true);
      expect(children().some((n) => n.id === tx.id)).toBe(false);
    }
    const none = await call('text_to_outlines', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('nodeIds');
  });

  it('rota text-to-outlines: nó inexistente 404 e corpo inválido 400', async () => {
    const docId = daemon.store.resolveDocId();
    const url = `${daemon.url}/api/docs/${docId}/text-to-outlines`;
    const post = (body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const miss = await post({ nodeIds: ['tx_naoexiste'] });
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { error: string }).error).toBeTruthy();
    expect((await post({})).status).toBe(400);
    const nodoc = await fetch(`${daemon.url}/api/docs/doc_x/text-to-outlines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeIds: ['a'] }),
    });
    expect(nodoc.status).toBe(404);
  });
});
