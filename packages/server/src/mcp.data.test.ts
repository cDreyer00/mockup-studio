import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findNode, type Node } from '@mockup/core';
import { startDaemon, type DaemonHandle } from './index.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

const TEMPLATE =
  '<div class="list"><article class="card"><h3>{{name}}</h3><p>{{price | on request}}</p></article></div>';

const items = (n: number): { name: string; price: string }[] =>
  Array.from({ length: n }, (_, i) => ({ name: `Product ${i + 1}`, price: `$${i + 1}` }));

describe('MCP: repeater data', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let server: http.Server | undefined;

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
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    ws.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = () => daemon.store.resolveDocId();
  const doc = () => daemon.store.get(docId());
  const frame = () => doc().pages[0]!.frames[0]!;

  /** Writes the template and returns the container (the `div.list`) with its children. */
  async function makeTemplate(): Promise<Node> {
    const r = await call('write_html', { parentId: ws.frameId, html: TEMPLATE });
    expect(r.isError, textOf(r)).toBeFalsy();
    return frame().children[0]!;
  }

  it('bind_data inline: converts the container, preserves the children ids and undo restores it', async () => {
    const box = await makeTemplate();
    const childIds = box.children.map((c) => c.id);
    const before = JSON.stringify(frame());
    const r = await call('bind_data', { nodeId: box.id, data: items(20) });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.type).toBe('repeater');
    expect(rep.id).not.toBe(box.id);
    expect(rep.id.startsWith('rp_')).toBe(true);
    expect(rep.name).toBe(box.name);
    expect(rep.children.map((c) => c.id)).toEqual(childIds);
    expect(rep.data).toHaveLength(20);
    expect(rep.dataSource?.kind).toBe('inline');
    const t = textOf(r);
    expect(t).toContain(rep.id);
    expect(t).toContain('20 item');
    expect(t).toContain('name');
    expect(t).not.toContain('Warning');

    // a single undo restores the original container
    const u = await call('undo');
    expect(u.isError, textOf(u)).toBeFalsy();
    expect(JSON.stringify(frame())).toBe(before);
  });

  it('bind_data on a repeater only swaps the data (same id)', async () => {
    const box = await makeTemplate();
    await call('bind_data', { nodeId: box.id, data: items(3) });
    const rep = frame().children[0]!;
    const r = await call('bind_data', { nodeId: rep.id, data: items(5) });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frame().children[0]!.id).toBe(rep.id);
    expect(frame().children[0]!.data).toHaveLength(5);
  });

  it('JSON file with select; warns about template fields with no column', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'api.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        meta: { total: 4 },
        response: { list: items(4).map((x) => ({ title: x.name })) },
      }),
    );
    const r = await call('bind_data', { nodeId: box.id, path: file, select: 'response.list' });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.data).toHaveLength(4);
    expect(rep.dataSource).toMatchObject({ kind: 'json', path: file, select: 'response.list' });
    expect(rep.dataSource?.fetchedAt).toBeTruthy();
    expect(textOf(r)).toContain('Warning');
    expect(textOf(r)).toContain('{{name}}');
  });

  it('CSV with semicolon and mapping (the warning goes away)', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'products.csv');
    fs.writeFileSync(file, 'title;price\nCoffee;10\n"Tea; green";12\n');
    const r = await call('bind_data', {
      nodeId: box.id,
      path: file,
      mapping: { name: 'title' },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.data).toEqual([
      { title: 'Coffee', price: '10' },
      { title: 'Tea; green', price: '12' },
    ]);
    expect(rep.dataSource).toMatchObject({ kind: 'csv', mapping: { name: 'title' } });
    expect(textOf(r)).not.toContain('Warning');
    const html = textOf(await call('get_code', { nodeId: ws.frameId, format: 'html' }));
    expect(html).toContain('Coffee');
    expect(html).toContain('Tea; green');
  });

  it('pasted text as CSV', async () => {
    const box = await makeTemplate();
    const r = await call('bind_data', {
      nodeId: box.id,
      text: 'name,price\nA,1\nB,2',
      format: 'csv',
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(2);
  });

  it('URL (JSON) and refresh_data after the source changes', async () => {
    const box = await makeTemplate();
    let payload = JSON.stringify(items(2));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`;
    const r = await call('bind_data', { nodeId: box.id, url });
    expect(r.isError, textOf(r)).toBeFalsy();
    const rep = frame().children[0]!;
    expect(rep.data).toHaveLength(2);
    expect(rep.dataSource).toMatchObject({ kind: 'url', url });
    payload = JSON.stringify(items(6));
    const rr = await call('refresh_data', { nodeId: rep.id });
    expect(rr.isError, textOf(rr)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(6);
    expect(textOf(rr)).toContain('6 item');
  });

  it('file refresh_data re-reads the content; inline gives a clear error', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'list.json');
    fs.writeFileSync(file, JSON.stringify(items(2)));
    await call('bind_data', { nodeId: box.id, path: file });
    const rep = frame().children[0]!;
    fs.writeFileSync(file, JSON.stringify(items(7)));
    const r = await call('refresh_data', { nodeId: rep.id });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(7);
    // undoes only the refresh
    await call('undo');
    expect(frame().children[0]!.data).toHaveLength(2);

    await call('bind_data', { nodeId: rep.id, data: items(1) });
    const bad = await call('refresh_data', { nodeId: rep.id });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('bind_data');
  });

  it('get_data shows source, columns, fields and the first rows', async () => {
    const box = await makeTemplate();
    await call('bind_data', { nodeId: box.id, data: items(30) });
    const rep = frame().children[0]!;
    const t = textOf(await call('get_data', { nodeId: rep.id }));
    expect(t).toContain('30 item');
    expect(t).toContain('Columns: name, price');
    expect(t).toContain('Template fields: name, price');
    expect(t).toContain('| 0 | Product 1 | $1 |');
    expect(t).toContain('| 19 | Product 20 |');
    expect(t).not.toContain('Product 21');
    const few = textOf(await call('get_data', { nodeId: rep.id, limit: 2 }));
    expect(few).toContain('First 2 of 30');
    const notRep = await call('get_data', { nodeId: ws.frameId });
    expect(notRep.isError).toBe(true);
  });

  it('export html contains the 20 items', async () => {
    const box = await makeTemplate();
    await call('bind_data', { nodeId: box.id, data: items(20) });
    const out = path.join(ws.dir, 'out');
    const r = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
    expect(r.isError, textOf(r)).toBeFalsy();
    const file = fs.readdirSync(out).find((f) => f.endsWith('.html'))!;
    const html = fs.readFileSync(path.join(out, file), 'utf8');
    expect(html.match(/<article/g)).toHaveLength(20);
    expect(html).toContain('Product 20');
    expect(html).not.toContain('{{');
  });

  it('export copies the images coming from the data into assets/', async () => {
    const r1 = await call('write_html', {
      parentId: ws.frameId,
      html: '<div class="g"><img src="{{photo}}" alt=""></div>',
    });
    expect(r1.isError, textOf(r1)).toBeFalsy();
    fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(ws.dir, 'assets', 'a.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    fs.writeFileSync(
      path.join(ws.dir, 'assets', 'b.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    const box = frame().children[0]!;
    await call('bind_data', { nodeId: box.id, data: [{ photo: 'a.svg' }, { photo: 'b.svg' }] });
    const out = path.join(ws.dir, 'out2');
    const r = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(fs.existsSync(path.join(out, 'assets', 'a.svg'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'assets', 'b.svg'))).toBe(true);
  });

  it('limits and clear errors', async () => {
    const box = await makeTemplate();
    const big = await call('bind_data', { nodeId: box.id, data: items(1001) });
    expect(big.isError).toBe(true);
    expect(textOf(big)).toContain('1000');
    expect(frame().children[0]!.type).not.toBe('repeater');

    const limited = await call('bind_data', { nodeId: box.id, data: items(1001), limit: 5 });
    expect(limited.isError, textOf(limited)).toBeFalsy();
    expect(frame().children[0]!.data).toHaveLength(5);

    const cur = frame().children[0]!.id;
    const none = await call('bind_data', { nodeId: cur });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('exactly one source');
    const two = await call('bind_data', { nodeId: cur, data: [], path: 'C:/x.json' });
    expect(two.isError).toBe(true);
    const rel = await call('bind_data', { nodeId: cur, path: 'data.json' });
    expect(textOf(rel)).toContain('absolute');
    const root = await call('bind_data', { nodeId: ws.frameId, data: items(2) });
    expect(root.isError).toBe(true);
    expect(textOf(root)).toContain('root frame');
  });

  it('path refuses hidden folders and files, .txt, traversal and symlinks to hidden ones', async () => {
    const box = await makeTemplate();
    const put = (rel: string, content: string): string => {
      const f = path.join(ws.dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      return f;
    };
    const secret = JSON.stringify([{ name: 'SECRET' }]);
    const ssh = put('.ssh/keys.json', secret);
    const claude = put('.claude/.credentials.json', secret);
    const txt = put('notes.txt', 'name\nSECRET\n');
    const traversal = path.join(ws.dir, 'sub', '..', '.claude', '.credentials.json');
    const attempts = [ssh, claude, traversal];
    const link = path.join(ws.dir, 'shortcut.json');
    try {
      fs.symlinkSync(claude, link, 'file');
      attempts.push(link);
    } catch {
      // no permission for symlinks (Windows without developer mode): the rest of the test still applies
    }
    for (const p of attempts) {
      const r = await call('bind_data', { nodeId: box.id, path: p });
      expect(r.isError, p).toBe(true);
      expect(textOf(r)).toContain('hidden');
      expect(textOf(r)).not.toContain('SECRET');
    }
    const t = await call('bind_data', { nodeId: box.id, path: txt });
    expect(t.isError).toBe(true);
    expect(textOf(t)).toContain('.txt');
    expect(frame().children[0]!.type).not.toBe('repeater');
    expect(JSON.stringify(doc())).not.toContain('SECRET');

    // a path with ".." that ends in a regular folder is still accepted
    put('data/ok.json', JSON.stringify(items(2)));
    const ok = await call('bind_data', {
      nodeId: box.id,
      path: path.join(ws.dir, 'sub', '..', 'data', 'ok.json'),
    });
    expect(ok.isError, textOf(ok)).toBeFalsy();
  });

  it('get_html marks the repeater and write_html replace with the mark preserves the data', async () => {
    const box = await makeTemplate();
    const file = path.join(ws.dir, 'list.json');
    fs.writeFileSync(file, JSON.stringify(items(5)));
    await call('bind_data', { nodeId: box.id, path: file });
    const rep = frame().children[0]!;
    const html = textOf(await call('get_html', { nodeId: rep.id }));
    expect(html).toContain(`data-mockup-repeat="${rep.id}"`);
    expect(html).toContain('data-repeat="5"');
    expect(html).toContain('{{name}}');

    const edited = html.replace('on request', 'by quote');
    const w = await call('write_html', { parentId: rep.id, mode: 'replace', html: edited });
    expect(w.isError, textOf(w)).toBeFalsy();
    expect(textOf(w)).not.toContain('Warning');
    const back = frame().children[0]!;
    expect(back.type).toBe('repeater');
    expect(back.data).toEqual(items(5));
    expect(back.dataSource).toMatchObject({ kind: 'json', path: file });
    expect(back.attrs['data-mockup-repeat']).toBeUndefined();
    expect(back.attrs['data-repeat']).toBeUndefined();
    expect(JSON.stringify(back.children)).toContain('by quote');
    expect(textOf(await call('get_code', { nodeId: ws.frameId, format: 'html' }))).toContain(
      'Product 5',
    );

    // without the mark: becomes a regular container, but the response warns and undo restores it
    const plain = html.replace(/ data-mockup-repeat="[^"]*"/, '').replace(/ data-repeat="\d+"/, '');
    const lost = await call('write_html', { parentId: back.id, mode: 'replace', html: plain });
    expect(textOf(lost)).toContain('lost');
    expect(textOf(lost)).toContain(`${back.id} (5 items)`);
    expect(frame().children[0]!.type).not.toBe('repeater');
    await call('undo');
    expect(frame().children[0]!.type).toBe('repeater');
    expect(frame().children[0]!.data).toHaveLength(5);
  });

  it('container without children asks for the template first', async () => {
    const r1 = await call('write_html', {
      parentId: ws.frameId,
      html: '<div class="empty"></div>',
    });
    expect(r1.isError, textOf(r1)).toBeFalsy();
    const empty = frame().children[0]!;
    const r = await call('bind_data', { nodeId: empty.id, data: items(2) });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('write_html');
    expect(textOf(r)).toContain('{{name}}');
  });

  describe('HTTP routes', () => {
    const post = (url: string, body: unknown) =>
      fetch(`${daemon.url}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('bind converts and refresh re-reads (source editor, a single undo entry)', async () => {
      const box = await makeTemplate();
      const file = path.join(ws.dir, 'route.json');
      fs.writeFileSync(file, JSON.stringify(items(3)));
      const res = await post(`/api/data/${docId()}/${box.id}/bind`, { path: file });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nodeId: string; count: number; columns: string[] };
      expect(body.count).toBe(3);
      expect(body.columns).toEqual(['name', 'price']);
      expect(body.nodeId.startsWith('rp_')).toBe(true);
      expect(findNode(doc(), body.nodeId)?.node.type).toBe('repeater');

      fs.writeFileSync(file, JSON.stringify(items(9)));
      const rr = await post(`/api/data/${docId()}/${body.nodeId}/refresh`, {});
      expect(rr.status).toBe(200);
      expect(((await rr.json()) as { count: number }).count).toBe(9);

      const bad = await post(`/api/data/${docId()}/${body.nodeId}/bind`, {
        data: items(1),
        text: 'x',
      });
      expect(bad.status).toBe(400);
      await post(`/api/data/${docId()}/${body.nodeId}/bind`, { data: items(1) });
      const inline = await post(`/api/data/${docId()}/${body.nodeId}/refresh`, {});
      expect(inline.status).toBe(400);
      const missing = await post(`/api/data/${docId()}/does_not_exist/bind`, { data: items(1) });
      expect(missing.status).toBe(400);
      const noDoc = await post(`/api/data/doc_xx/${box.id}/bind`, { data: items(1) });
      expect(noDoc.status).toBe(404);
    });

    it('bind from the editor only reads path from the document folder or home and requires a local Origin', async () => {
      const box = await makeTemplate();
      const other = makeWorkspace();
      const home = path.join(ws.dir, 'fake-home');
      fs.mkdirSync(home);
      const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
      try {
        const outside = path.join(other.dir, 'outside.json');
        fs.writeFileSync(outside, JSON.stringify(items(2)));
        const r = await post(`/api/data/${docId()}/${box.id}/bind`, { path: outside });
        expect(r.status).toBe(400);
        expect(((await r.json()) as { error: string }).error).toContain("document's folder");

        fs.mkdirSync(path.join(ws.dir, '.hidden'));
        const hidden = path.join(ws.dir, '.hidden', 'x.json');
        fs.writeFileSync(hidden, JSON.stringify(items(2)));
        const h = await post(`/api/data/${docId()}/${box.id}/bind`, { path: hidden });
        expect(h.status).toBe(400);

        const evil = await fetch(`${daemon.url}/api/data/${docId()}/${box.id}/bind`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://example.com' },
          body: JSON.stringify({ text: '[{"name":"x"}]' }),
        });
        expect(evil.status).toBe(403);

        const inDoc = path.join(ws.dir, 'near.json');
        fs.writeFileSync(inDoc, JSON.stringify(items(2)));
        const ok = await post(`/api/data/${docId()}/${box.id}/bind`, { path: inDoc });
        expect(ok.status).toBe(200);
      } finally {
        spy.mockRestore();
        other.cleanup();
      }
    });
  });
});
