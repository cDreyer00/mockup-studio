import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { LayoutNode, Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import type { RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const LUCIDE_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

describe('MCP vectors', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    client = new Client({ name: 'test', version: '0.0.0' });
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
    if (!m) throw new Error(`id not found in: ${t}`);
    return m[1]!;
  };
  const shape = async (args: Record<string, unknown>): Promise<string> => {
    const r = await call('create_shape', { parentId: ws.frameId, ...args });
    expect(r.isError, textOf(r)).toBeFalsy();
    return idIn(/(sv_[0-9a-z]+)/, textOf(r));
  };
  const nodeOf = (id: string): Node => children().find((n) => n.id === id)!;

  it('create_shape creates each shape with an editable vector', async () => {
    for (const kind of ['rect', 'ellipse', 'line', 'polygon', 'star'] as const) {
      const id = await shape({
        shape: kind,
        x: 10,
        y: 20,
        width: 80,
        height: kind === 'line' ? 0 : 60,
      });
      const n = nodeOf(id);
      expect(n.type).toBe('svg');
      expect(n.vector?.paths).toHaveLength(1);
      expect(n.svg).toContain('<path');
      expect(n.style['position']).toBe('absolute');
    }
    const star = children().at(-1)!;
    expect(star.vector!.paths[0]!.d).toMatch(/^M/);
  });

  it('create_shape separates the vector paint from the node styles and positions it', async () => {
    const id = await shape({
      shape: 'rect',
      width: 120,
      height: 40,
      cornerRadius: 8,
      styles: {
        fill: '#ff0000',
        stroke: '#000000',
        'stroke-width': '3',
        'border-radius': '4px',
        opacity: '0.5',
      },
    });
    const n = nodeOf(id);
    expect(n.vector!.paths[0]).toMatchObject({
      fill: '#ff0000',
      stroke: '#000000',
      strokeWidth: 3,
      opacity: 0.5,
    });
    expect(n.style['border-radius']).toBe('4px');
    expect(n.style['fill']).toBeUndefined();
    expect(n.style['position']).toBeUndefined();
    expect(n.style['display']).toBe('block');
    expect(n.style['width']).toBe('120px');
  });

  it('create_shape with a 6-sided polygon and parameter errors', async () => {
    const id = await shape({ shape: 'polygon', sides: 6, width: 100, height: 100 });
    expect((nodeOf(id).vector!.paths[0]!.d.match(/L/g) ?? []).length).toBe(5);
    const bad = await call('create_shape', { parentId: 'nothing', shape: 'rect' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Node not found');
    const zero = await call('create_shape', {
      parentId: ws.frameId,
      shape: 'rect',
      width: 0,
      height: 10,
    });
    expect(zero.isError).toBe(true);
    expect(textOf(zero)).toContain('greater than 0');
  });

  it('insert_svg with a Lucide icon preserves the raw markup and get_svg reports it', async () => {
    const r = await call('insert_svg', {
      parentId: ws.frameId,
      svg: LUCIDE_CHECK,
      name: 'Check',
      width: 32,
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain('editable');
    const id = idIn(/(sv_[0-9a-z]+)/, textOf(r));
    const n = nodeOf(id);
    expect(n.vector!.raw).toBeTruthy();
    expect(n.vector!.paths).toHaveLength(1);
    expect(n.style['width']).toBe('32px');
    expect(n.style['height']).toBe('32px');
    const g = textOf(await call('get_svg', { nodeId: id }));
    expect(g).toContain('original markup preserved');
    expect(g).toContain('p1');
    expect(g).toContain('M20 6 9 17l-5-5');
    expect(g).toContain('<svg');
  });

  it('insert_svg warns when the SVG is not editable and rejects garbage', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><filter id="f"><feGaussianBlur stdDeviation="2"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>';
    const r = await call('insert_svg', { parentId: ws.frameId, svg });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain('NOT editable');
    const bad = await call('insert_svg', { parentId: ws.frameId, svg: '<div>hi</div>' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Invalid SVG');
  });

  it('set_vector_paint changes the color, regenerates the markup and accepts a gradient', async () => {
    const ins = await call('insert_svg', { parentId: ws.frameId, svg: LUCIDE_CHECK });
    const id = idIn(/(sv_[0-9a-z]+)/, textOf(ins));
    const r = await call('set_vector_paint', { nodeId: id, stroke: '#ff0000', strokeWidth: 4 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const n = nodeOf(id);
    expect(n.vector!.raw).toBeUndefined();
    expect(n.vector!.paths[0]).toMatchObject({ stroke: '#ff0000', strokeWidth: 4 });
    expect(n.svg).toContain('stroke="#ff0000"');
    expect(textOf(await call('get_svg', { nodeId: id }))).toContain('regenerated');

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
    expect(textOf(await call('get_svg', { nodeId: id }))).toContain('linear gradient');

    const none = await call('set_vector_paint', { nodeId: id });
    expect(none.isError).toBe(true);
    const unknown = await call('set_vector_paint', { nodeId: id, fill: '#000', pathIds: ['zz'] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('zz');
  });

  it('set_path replaces d, validates and fits the viewBox with fit', async () => {
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

    const bad = await call('set_path', { nodeId: id, d: 'this is not a path' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('path data');
    const nope = await call('set_path', { nodeId: id, d: 'M 0 0 L 1 1', pathId: 'x9' });
    expect(nope.isError).toBe(true);
    expect(textOf(nope)).toContain('p1');
  });

  it('boolean_op union of 2 shapes and flatten', async () => {
    const a = await shape({ shape: 'rect', x: 0, y: 0, width: 100, height: 100 });
    const b = await shape({ shape: 'ellipse', x: 50, y: 50, width: 100, height: 100 });
    const before = children().length;
    const r = await call('boolean_op', { nodeIds: [a, b], op: 'union', name: 'Union' });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(children()).toHaveLength(before - 1);
    expect(children().some((n) => n.id === a || n.id === b)).toBe(false);
    const res = children().find((n) => n.name === 'Union')!;
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

  it('flatten of a node merges the paths into one', async () => {
    const a = await shape({ shape: 'rect', width: 20, height: 20, x: 0, y: 0 });
    const b = await shape({ shape: 'rect', width: 20, height: 20, x: 30, y: 0 });
    const f = await call('flatten', { nodeIds: [a, b] });
    expect(f.isError, textOf(f)).toBeFalsy();
    const flat = children().find((n) => n.type === 'svg')!;
    expect(flat.vector!.paths.length).toBeGreaterThanOrEqual(2);
    const g = await call('flatten', { nodeIds: [flat.id] });
    expect(g.isError, textOf(g)).toBeFalsy();
    expect(children().find((n) => n.id === flat.id)!.vector!.paths).toHaveLength(1);
  });

  it('boolean_op and flatten refuse an in-flow node without render, with a clear message', async () => {
    const a = await shape({ shape: 'rect', x: 0, y: 0, width: 20, height: 20 });
    const b = await shape({ shape: 'rect', width: 20, height: 20 }); // in flow
    const before = children().length;
    const r = await call('boolean_op', { nodeIds: [a, b], op: 'union' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/in flow.*position: absolute.*before the boolean operation/);
    const f = await call('flatten', { nodeIds: [a, b] });
    expect(f.isError).toBe(true);
    expect(textOf(f)).toMatch(/in flow.*before flattening/);
    expect(children()).toHaveLength(before);
  });

  it('get_svg on a non-svg node gives an actionable error', async () => {
    const r = await call('get_svg', { nodeId: ws.frameId });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not an svg');
  });

  it('text_to_outlines: converts when a font is available or explains the error', async () => {
    await call('write_html', {
      html: '<p style="font-family: Arial, sans-serif; font-size: 24px">Hello</p>',
      parentId: ws.frameId,
    });
    const tx = children().find((n) => n.type === 'text')!;
    const r = await call('text_to_outlines', { nodeIds: [tx.id] });
    const t = textOf(r);
    if (r.isError) {
      expect(t).toMatch(/font/i);
    } else {
      expect(children().some((n) => n.type === 'svg')).toBe(true);
      expect(children().some((n) => n.id === tx.id)).toBe(false);
    }
    const none = await call('text_to_outlines', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('nodeIds');
  });

  it('text-to-outlines route: missing node 404 and invalid body 400', async () => {
    const docId = daemon.store.resolveDocId();
    const url = `${daemon.url}/api/docs/${docId}/text-to-outlines`;
    const post = (body: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const miss = await post({ nodeIds: ['tx_missing'] });
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

describe('MCP vectors: in-flow nodes measured by render', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;

  const rect = (id: string, x: number, y: number, width: number, height: number): LayoutNode => ({
    id,
    name: id,
    type: 'svg',
    tag: 'svg',
    x,
    y,
    width,
    height,
    style: {},
    children: [],
  });

  // the parent sits at (10, 10) in the frame, with a 2px border; the in-flow child at (12, 12)+(40, 0)
  const render: RenderProvider = {
    async capture() {
      throw new Error('no capture');
    },
    async measure({ doc, nodeId }): Promise<LayoutNode> {
      const kids = doc.pages[0]!.frames[0]!.children.filter((n) => n.type === 'svg');
      return {
        ...rect(nodeId, 10, 10, 400, 300),
        type: 'frame',
        tag: 'div',
        style: { 'border-left-width': '2px', 'border-top-width': '2px' },
        children: kids.map((k, i) => rect(k.id, 12 + i * 40, 12 + i * 5, 20, 20)),
      };
    },
  };

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false, render });
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
  });

  it('flatten of two in-flow nodes uses the measured boxes (parent padding box)', async () => {
    const make = async (): Promise<string> => {
      const r = await client.callTool({
        name: 'create_shape',
        arguments: { parentId: ws.frameId, shape: 'rect', width: 20, height: 20 },
      });
      return /(sv_[0-9a-z]+)/.exec(textOf(r))![1]!;
    };
    const a = await make();
    const b = await make();
    const f = await client.callTool({
      name: 'flatten',
      arguments: { nodeIds: [a, b], name: 'Together' },
    });
    expect(f.isError, textOf(f)).toBeFalsy();
    const frame = daemon.store.get(daemon.store.resolveDocId()).pages[0]!.frames[0]!;
    const res = frame.children.find((n) => n.name === 'Together')!;
    // a at (12-10-2, 12-10-2) = (0, 0); b at (40, 5), both 20x20
    expect(res.style).toMatchObject({
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '60px',
      height: '25px',
    });
    expect(frame.children.some((n) => n.id === a || n.id === b)).toBe(false);
  });
});
