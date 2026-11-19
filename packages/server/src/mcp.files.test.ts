import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDocument, createNodeFromTag, serializeDocument, walk } from '@mockup/core';
import { startDaemon, type CaptureRequest, type DaemonHandle } from './index.js';
import type { RenderProvider } from './render.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function fakeRender(calls: CaptureRequest[]): RenderProvider {
  return {
    async capture(req) {
      // copy what matters: the request document may be mutated later
      calls.push({ ...req, doc: structuredClone(req.doc) });
      return {
        data: PNG,
        mime: 'image/png',
        width: 10,
        height: 10,
        pixelWidth: 10,
        pixelHeight: 10,
      };
    },
    async measure() {
      throw new Error('no layout');
    },
  };
}

/** Closed document with text and an image pointing to assets/photo.png. */
function makeImageDoc(dir: string): { file: string; bytes: Buffer } {
  const doc = createDocument('With image');
  const hidden = createNodeFromTag('div', {
    isRoot: true,
    name: 'Hidden',
    position: { x: 0, y: 0 },
  });
  hidden.hidden = true;
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Visible',
    styles: { width: '200px', height: '100px', 'background-image': 'url(assets/background.png)' },
    position: { x: 300, y: 0 },
  });
  const img = createNodeFromTag('img', { name: 'Photo' });
  img.src = 'assets/photo.png';
  frame.children.push(img);
  doc.pages[0]!.frames.push(hidden, frame);
  const file = path.join(dir, 'closed.mockup.json');
  fs.writeFileSync(file, serializeDocument(doc), 'utf8');
  fs.mkdirSync(path.join(dir, 'assets'));
  const bytes = Buffer.from('photo-content');
  fs.writeFileSync(path.join(dir, 'assets', 'photo.png'), bytes);
  fs.writeFileSync(path.join(dir, 'assets', 'background.png'), 'background');
  return { file, bytes };
}

describe('files and search (HTTP and MCP)', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let calls: CaptureRequest[];
  let client: Client | undefined;

  const start = async (
    render?: RenderProvider,
    trash?: (p: string) => Promise<void>,
  ): Promise<void> => {
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
      render,
      trash,
    });
  };
  const get = (p: string) => fetch(`${daemon.url}${p}`);
  const post = (p: string, body: unknown) =>
    fetch(`${daemon.url}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const connect = async (): Promise<Client> => {
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    return client;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await (client ?? (await connect())).callTool({ name, arguments: args });
    return { text: textOf(r), isError: (r as { isError?: boolean }).isError === true };
  };

  beforeEach(() => {
    ws = makeWorkspace();
    calls = [];
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await daemon.close();
    ws.cleanup();
  });

  it('GET /api/files lists the open document and accepts filters', async () => {
    await start();
    const r = await (await get('/api/files')).json();
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({
      path: path.resolve(ws.file),
      name: 'test',
      open: true,
      folder: null,
      favorite: false,
      pages: 1,
      frames: 1,
      recent: 0,
    });
    expect(r.files[0].docId).toBe(daemon.store.list()[0]!.docId);
    expect(r).toMatchObject({ folders: [], tags: [] });
    expect((await (await get('/api/files?favorites=1')).json()).files).toHaveLength(0);
    expect((await (await get('/api/files?query=desktop')).json()).files[0].match.field).toBe(
      'content',
    );
  });

  it('meta, folders, add, forget', async () => {
    await start();
    const p = path.resolve(ws.file);
    const meta = await post('/api/files/meta', {
      path: p,
      folder: 'Clients/Acme',
      tags: ['a', 'A', ' b '],
      favorite: true,
    });
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      folder: 'Clients/Acme',
      tags: ['a', 'b'],
      favorite: true,
    });
    expect((await post('/api/files/meta', { path: 'relative.mockup.json' })).status).toBe(400);
    expect((await post('/api/files/meta', { path: path.join(ws.dir, 'x.json') })).status).toBe(400);
    expect(
      (await post('/api/files/meta', { path: path.join(ws.dir, 'x.mockup.json') })).status,
    ).toBe(404);

    const list = await (await get('/api/files?folder=Clients')).json();
    expect(list.files).toHaveLength(0);
    expect((await (await get('/api/files?folder=Clients&recursive=1')).json()).files).toHaveLength(
      1,
    );
    expect(list.folders).toEqual(['Clients', 'Clients/Acme']);

    const ren = await post('/api/files/folders', {
      action: 'rename',
      path: 'Clients',
      to: 'Accounts',
    });
    expect(await ren.json()).toEqual({ folders: ['Accounts', 'Accounts/Acme'] });
    expect(
      await (await post('/api/files/folders', { action: 'create', path: 'Other/Sub' })).json(),
    ).toEqual({ folders: ['Accounts', 'Accounts/Acme', 'Other', 'Other/Sub'] });
    await post('/api/files/folders', { action: 'delete', path: 'Accounts' });
    const after = await (await get('/api/files')).json();
    expect(after.files[0].folder).toBeNull();
    expect((await post('/api/files/folders', { action: 'delete', path: 'Nothing' })).status).toBe(
      404,
    );
    expect((await post('/api/files/folders', { action: 'x', path: 'a' })).status).toBe(400);

    const other = path.join(ws.dir, 'sub');
    fs.mkdirSync(other);
    fs.copyFileSync(ws.file, path.join(other, 'other.mockup.json'));
    const added = await (await post('/api/files/add', { path: other })).json();
    expect(added.added.map((f: { name: string }) => f.name)).toEqual(['other']);
    expect(
      (await post('/api/files/forget', { path: path.join(other, 'other.mockup.json') })).status,
    ).toBe(200);
    const idx = JSON.parse(fs.readFileSync(path.join(ws.dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(idx.files)).toEqual([p]);
  });

  it('GET /api/search/nodes in the open documents and in a docId', async () => {
    await start();
    const docId = daemon.store.list()[0]!.docId;
    const r = await (await get('/api/search/nodes?query=tag:div')).json();
    expect(r.matches[0]).toMatchObject({ docId, tag: 'div' });
    expect(
      (await (await get(`/api/search/nodes?query=desktop&docId=${docId}`)).json()).matches,
    ).toHaveLength(1);
    expect((await get('/api/search/nodes')).status).toBe(400);
    expect((await get('/api/search/nodes?query=a&docId=doc_missing')).status).toBe(404);
  });

  it('thumbnail: 503 without render, 400, 404 and cache', async () => {
    await start();
    const url = `/api/files/thumbnail?path=${encodeURIComponent(path.resolve(ws.file))}`;
    const r503 = await get(url);
    expect(r503.status).toBe(503);
    expect((await r503.json()).error).toMatch(/render/i);
    await daemon.close();

    await start(fakeRender(calls));
    const ok = await get(`${url}&w=9999`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      nodeId: ws.frameId,
      scale: 1,
      format: 'png',
      maxWidth: 1024,
      docId: daemon.store.list()[0]!.docId,
    });
    expect(fs.readdirSync(path.join(ws.dataDir, 'thumbs'))).toHaveLength(1);
    await get(`${url}&w=9999`);
    expect(calls).toHaveLength(1); // disk cache
    await get(url);
    expect(calls[1]).toMatchObject({ maxWidth: 480 });

    expect(
      (
        await get(
          '/api/files/thumbnail?path=' +
            encodeURIComponent(ws.file.replace('.mockup.json', '.txt')),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await get(
          '/api/files/thumbnail?path=' + encodeURIComponent(path.join(ws.dir, 'x.mockup.json')),
        )
      ).status,
    ).toBe(404);
    const empty = path.join(ws.dir, 'empty.mockup.json');
    fs.writeFileSync(empty, serializeDocument(createDocument('Empty')), 'utf8');
    await post('/api/files/add', { path: empty });
    expect((await get('/api/files/thumbnail?path=' + encodeURIComponent(empty))).status).toBe(404);
  });

  it('thumbnail of a closed document embeds images as data URLs', async () => {
    await start(fakeRender(calls));
    const { file, bytes } = makeImageDoc(ws.dir);
    const thumb = `/api/files/thumbnail?path=${encodeURIComponent(file)}&w=200`;
    // outside the index, the recents and the open documents: does not render
    const unknown = await get(thumb);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toContain('not in the list');
    expect(calls).toHaveLength(0);
    expect((await post('/api/files/add', { path: file })).status).toBe(200);
    const r = await get(thumb);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    const frame = req.doc.pages[0]!.frames.find((f) => f.id === req.nodeId)!;
    expect(frame.name).toBe('Visible'); // skips the hidden frame
    const imgs: string[] = [];
    walk(frame, (n) => {
      if (n.src) imgs.push(n.src);
    });
    expect(imgs).toEqual([`data:image/png;base64,${bytes.toString('base64')}`]);
    expect(frame.style['background-image']).toBe(
      `url("data:image/png;base64,${Buffer.from('background').toString('base64')}")`,
    );
    expect(req.assetsDir).toBe(path.join(ws.dir, 'assets'));
    expect(req.maxWidth).toBe(200);
    // the file on disk was not changed
    expect(fs.readFileSync(file, 'utf8')).toContain('assets/photo.png');
  });

  it('MCP tools: list_files, tag_file, manage_folders, move_files', async () => {
    await start();
    const p = path.resolve(ws.file);
    const docId = daemon.store.list()[0]!.docId;

    let r = await call('tag_file', { path: p, add: ['Client', 'client'], favorite: true });
    expect(r.text).toContain('tags: Client');
    expect(r.text).toContain('favorite: yes');
    r = await call('tag_file', { docId, remove: ['client'], add: ['final'] });
    expect(r.text).toContain('tags: final');
    expect((await call('tag_file', { path: p })).isError).toBe(true);
    expect((await call('tag_file', { path: 'rel.mockup.json', add: ['x'] })).text).toMatch(
      /absolute/,
    );

    expect(
      (await call('manage_folders', { action: 'create', path: 'Clients/Acme' })).text,
    ).toContain('Clients/Acme (0');
    r = await call('move_files', { paths: [p], folder: 'Clients/Acme' });
    expect(r.text).toContain('-> Clients/Acme');
    expect((await call('manage_folders', { action: 'list' })).text).toContain(
      'Clients/Acme (1 file',
    );
    expect((await call('manage_folders', { action: 'rename', path: 'Clients' })).isError).toBe(
      true,
    );
    await call('manage_folders', { action: 'rename', path: 'Clients', to: 'Accounts' });

    r = await call('list_files', {
      folder: 'Accounts',
      recursive: true,
      tag: 'final',
      favorites: true,
    });
    expect(r.text).toContain('Folders: Accounts, Accounts/Acme');
    expect(r.text).toContain('Tags: final');
    expect(r.text).toContain(
      `${p} | folder: Accounts/Acme | tags: final | favorite | 1 page(s), 1 frame(s) | open (${docId})`,
    );
    r = await call('list_files', { query: 'desktop' });
    expect(r.text).toContain('matched in content');
    expect((await call('list_files', { folder: 'Accounts' })).text).toContain('0 file(s)');

    expect((await call('move_files', { docIds: [docId], folder: null })).text).toContain(
      '(no folder)',
    );
    await call('manage_folders', { action: 'delete', path: 'Accounts' });
    expect((await call('manage_folders', { action: 'list' })).text).toContain('(no folders)');
  });

  it('POST /api/files/forget on an open document closes it and keeps it out of the list', async () => {
    await start();
    const p = path.resolve(ws.file);
    expect((await (await get('/api/files')).json()).files).toHaveLength(1);
    expect((await post('/api/files/forget', { path: p })).status).toBe(200);
    expect(daemon.store.list()).toEqual([]);
    expect((await (await get('/api/files')).json()).files).toEqual([]);
    expect((await get(`/api/files/thumbnail?path=${encodeURIComponent(p)}`)).status).toBe(404);
    expect(fs.existsSync(p)).toBe(true);
    // opening it again registers it again
    await daemon.store.open(p);
    expect((await (await get('/api/files')).json()).files).toHaveLength(1);
  });

  it('POST /api/files/delete: dry run, trash provider, errors', async () => {
    const trashed: string[] = [];
    await start(undefined, async (p) => {
      trashed.push(p);
      fs.rmSync(p);
    });
    const p = path.resolve(ws.file);
    const plan = await (await post('/api/files/delete', { path: p, dryRun: true })).json();
    expect(plan).toMatchObject({ path: p, name: 'test', open: true, mode: 'trash', assets: [] });
    expect(fs.existsSync(p)).toBe(true);
    expect(daemon.store.list()).toHaveLength(1);

    const r = await post('/api/files/delete', { path: p });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ mode: 'trash', open: true });
    expect(trashed).toEqual([p]);
    expect(daemon.store.list()).toEqual([]);
    expect((await (await get('/api/files')).json()).files).toEqual([]);

    expect((await post('/api/files/delete', { path: p })).status).toBe(404);
    expect((await post('/api/files/delete', { path: path.join(ws.dir, 'x.txt') })).status).toBe(
      400,
    );
    expect((await post('/api/files/delete', { path: 'rel.mockup.json' })).status).toBe(400);
    expect((await post('/api/files/delete', { path: p, dryRun: 'yes' })).status).toBe(400);
  });

  it('MCP tools: forget_file and delete_file', async () => {
    await start();
    const p = path.resolve(ws.file);
    const docId = daemon.store.list()[0]!.docId;
    let r = await call('forget_file', { docId });
    expect(r.text).toContain('removed from the list (the document was closed first)');
    expect(daemon.store.list()).toEqual([]);
    expect((await call('list_files')).text).toContain('0 file(s)');
    expect((await call('forget_file', { path: p })).text).toContain('was not in the list');
    expect((await call('forget_file', { path: 'rel.mockup.json' })).isError).toBe(true);

    const { file } = makeImageDoc(ws.dir);
    const other = path.join(ws.dir, 'other.mockup.json');
    fs.writeFileSync(other, fs.readFileSync(file, 'utf8').replace('assets/photo.png', 'x.png'));
    r = await call('delete_file', { path: file });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('confirm: true');
    r = await call('delete_file', { path: file, dryRun: true });
    expect(r.text).toContain('deleted permanently');
    expect(r.text).toContain('photo.png');
    expect(r.text).toContain(
      'Assets kept (another document in the folder may use them): background.png',
    );
    expect(fs.existsSync(file)).toBe(true);
    r = await call('delete_file', { path: file, confirm: true });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('deleted permanently (no trash)');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'photo.png'))).toBe(false);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'background.png'))).toBe(true);
    r = await call('delete_file', { path: file, confirm: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('File not found');
    const tools = (await client!.listTools()).tools;
    expect(tools.find((t) => t.name === 'delete_file')!.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it('search_nodes tool', async () => {
    await start();
    const docId = daemon.store.list()[0]!.docId;
    let r = await call('search_nodes', { query: 'tag:div' });
    expect(r.text).toContain(`${docId} ${ws.frameId} "Desktop" div`);
    r = await call('search_nodes', { query: 'name:desktop', docId, limit: 1 });
    expect(r.text).toContain('name:');
    expect((await call('search_nodes', { query: 'zzzz' })).text).toContain('No nodes');
    expect((await call('search_nodes', { query: '  ' })).isError).toBe(true);
  });
});
