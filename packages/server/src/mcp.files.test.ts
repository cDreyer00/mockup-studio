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
      // copia o que importa: o documento do pedido pode ser mutado depois
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
      throw new Error('sem layout');
    },
  };
}

/** Documento fechado com texto e uma imagem que aponta para assets/foto.png. */
function makeImageDoc(dir: string): { file: string; bytes: Buffer } {
  const doc = createDocument('Com imagem');
  const hidden = createNodeFromTag('div', {
    isRoot: true,
    name: 'Oculto',
    position: { x: 0, y: 0 },
  });
  hidden.hidden = true;
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Visível',
    styles: { width: '200px', height: '100px', 'background-image': 'url(assets/fundo.png)' },
    position: { x: 300, y: 0 },
  });
  const img = createNodeFromTag('img', { name: 'Foto' });
  img.src = 'assets/foto.png';
  frame.children.push(img);
  doc.pages[0]!.frames.push(hidden, frame);
  const file = path.join(dir, 'fechado.mockup.json');
  fs.writeFileSync(file, serializeDocument(doc), 'utf8');
  fs.mkdirSync(path.join(dir, 'assets'));
  const bytes = Buffer.from('conteudo-da-foto');
  fs.writeFileSync(path.join(dir, 'assets', 'foto.png'), bytes);
  fs.writeFileSync(path.join(dir, 'assets', 'fundo.png'), 'fundo');
  return { file, bytes };
}

describe('arquivos e busca (HTTP e MCP)', () => {
  let ws: Ws;
  let daemon: DaemonHandle;
  let calls: CaptureRequest[];
  let client: Client | undefined;

  const start = async (render?: RenderProvider): Promise<void> => {
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
      render,
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
    client = new Client({ name: 'teste', version: '0.0.0' });
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

  it('GET /api/files lista o documento aberto e aceita filtros', async () => {
    await start();
    const r = await (await get('/api/files')).json();
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({
      path: path.resolve(ws.file),
      name: 'teste',
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

  it('meta, pastas, add, forget', async () => {
    await start();
    const p = path.resolve(ws.file);
    const meta = await post('/api/files/meta', {
      path: p,
      folder: 'Clientes/Acme',
      tags: ['a', 'A', ' b '],
      favorite: true,
    });
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      folder: 'Clientes/Acme',
      tags: ['a', 'b'],
      favorite: true,
    });
    expect((await post('/api/files/meta', { path: 'relativo.mockup.json' })).status).toBe(400);
    expect((await post('/api/files/meta', { path: path.join(ws.dir, 'x.json') })).status).toBe(400);
    expect(
      (await post('/api/files/meta', { path: path.join(ws.dir, 'x.mockup.json') })).status,
    ).toBe(404);

    const list = await (await get('/api/files?folder=Clientes')).json();
    expect(list.files).toHaveLength(0);
    expect((await (await get('/api/files?folder=Clientes&recursive=1')).json()).files).toHaveLength(
      1,
    );
    expect(list.folders).toEqual(['Clientes', 'Clientes/Acme']);

    const ren = await post('/api/files/folders', {
      action: 'rename',
      path: 'Clientes',
      to: 'Contas',
    });
    expect(await ren.json()).toEqual({ folders: ['Contas', 'Contas/Acme'] });
    expect(
      await (await post('/api/files/folders', { action: 'create', path: 'Outra/Sub' })).json(),
    ).toEqual({ folders: ['Contas', 'Contas/Acme', 'Outra', 'Outra/Sub'] });
    await post('/api/files/folders', { action: 'delete', path: 'Contas' });
    const after = await (await get('/api/files')).json();
    expect(after.files[0].folder).toBeNull();
    expect((await post('/api/files/folders', { action: 'delete', path: 'Nada' })).status).toBe(404);
    expect((await post('/api/files/folders', { action: 'x', path: 'a' })).status).toBe(400);

    const other = path.join(ws.dir, 'sub');
    fs.mkdirSync(other);
    fs.copyFileSync(ws.file, path.join(other, 'outro.mockup.json'));
    const added = await (await post('/api/files/add', { path: other })).json();
    expect(added.added.map((f: { name: string }) => f.name)).toEqual(['outro']);
    expect(
      (await post('/api/files/forget', { path: path.join(other, 'outro.mockup.json') })).status,
    ).toBe(200);
    const idx = JSON.parse(fs.readFileSync(path.join(ws.dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(idx.files)).toEqual([p]);
  });

  it('GET /api/search/nodes nos abertos e em um docId', async () => {
    await start();
    const docId = daemon.store.list()[0]!.docId;
    const r = await (await get('/api/search/nodes?query=tag:div')).json();
    expect(r.matches[0]).toMatchObject({ docId, tag: 'div' });
    expect(
      (await (await get(`/api/search/nodes?query=desktop&docId=${docId}`)).json()).matches,
    ).toHaveLength(1);
    expect((await get('/api/search/nodes')).status).toBe(400);
    expect((await get('/api/search/nodes?query=a&docId=doc_nao')).status).toBe(404);
  });

  it('miniatura: 503 sem render, 400, 404 e cache', async () => {
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
    expect(calls).toHaveLength(1); // cache em disco
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
    const empty = path.join(ws.dir, 'vazio.mockup.json');
    fs.writeFileSync(empty, serializeDocument(createDocument('Vazio')), 'utf8');
    await post('/api/files/add', { path: empty });
    expect((await get('/api/files/thumbnail?path=' + encodeURIComponent(empty))).status).toBe(404);
  });

  it('miniatura de documento fechado embute imagens como data URL', async () => {
    await start(fakeRender(calls));
    const { file, bytes } = makeImageDoc(ws.dir);
    const thumb = `/api/files/thumbnail?path=${encodeURIComponent(file)}&w=200`;
    // fora do índice, dos recentes e dos abertos: não renderiza
    const unknown = await get(thumb);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toContain('fora da lista');
    expect(calls).toHaveLength(0);
    expect((await post('/api/files/add', { path: file })).status).toBe(200);
    const r = await get(thumb);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    const frame = req.doc.pages[0]!.frames.find((f) => f.id === req.nodeId)!;
    expect(frame.name).toBe('Visível'); // pula o frame oculto
    const imgs: string[] = [];
    walk(frame, (n) => {
      if (n.src) imgs.push(n.src);
    });
    expect(imgs).toEqual([`data:image/png;base64,${bytes.toString('base64')}`]);
    expect(frame.style['background-image']).toBe(
      `url("data:image/png;base64,${Buffer.from('fundo').toString('base64')}")`,
    );
    expect(req.assetsDir).toBe(path.join(ws.dir, 'assets'));
    expect(req.maxWidth).toBe(200);
    // o arquivo em disco não foi alterado
    expect(fs.readFileSync(file, 'utf8')).toContain('assets/foto.png');
  });

  it('ferramentas MCP: list_files, tag_file, manage_folders, move_files', async () => {
    await start();
    const p = path.resolve(ws.file);
    const docId = daemon.store.list()[0]!.docId;

    let r = await call('tag_file', { path: p, add: ['Cliente', 'cliente'], favorite: true });
    expect(r.text).toContain('tags: Cliente');
    expect(r.text).toContain('favorito: sim');
    r = await call('tag_file', { docId, remove: ['cliente'], add: ['final'] });
    expect(r.text).toContain('tags: final');
    expect((await call('tag_file', { path: p })).isError).toBe(true);
    expect((await call('tag_file', { path: 'rel.mockup.json', add: ['x'] })).text).toMatch(
      /absoluto/,
    );

    expect(
      (await call('manage_folders', { action: 'create', path: 'Clientes/Acme' })).text,
    ).toContain('Clientes/Acme (0');
    r = await call('move_files', { paths: [p], folder: 'Clientes/Acme' });
    expect(r.text).toContain('-> Clientes/Acme');
    expect((await call('manage_folders', { action: 'list' })).text).toContain(
      'Clientes/Acme (1 arquivo',
    );
    expect((await call('manage_folders', { action: 'rename', path: 'Clientes' })).isError).toBe(
      true,
    );
    await call('manage_folders', { action: 'rename', path: 'Clientes', to: 'Contas' });

    r = await call('list_files', {
      folder: 'Contas',
      recursive: true,
      tag: 'final',
      favorites: true,
    });
    expect(r.text).toContain('Pastas: Contas, Contas/Acme');
    expect(r.text).toContain('Tags: final');
    expect(r.text).toContain(
      `${p} | pasta: Contas/Acme | tags: final | favorito | 1 pág., 1 frames | aberto (${docId})`,
    );
    r = await call('list_files', { query: 'desktop' });
    expect(r.text).toContain('casou em content');
    expect((await call('list_files', { folder: 'Contas' })).text).toContain('0 arquivo(s)');

    expect((await call('move_files', { docIds: [docId], folder: null })).text).toContain(
      '(sem pasta)',
    );
    await call('manage_folders', { action: 'delete', path: 'Contas' });
    expect((await call('manage_folders', { action: 'list' })).text).toContain('(nenhuma pasta)');
  });

  it('ferramenta search_nodes', async () => {
    await start();
    const docId = daemon.store.list()[0]!.docId;
    let r = await call('search_nodes', { query: 'tag:div' });
    expect(r.text).toContain(`${docId} ${ws.frameId} "Desktop" div`);
    r = await call('search_nodes', { query: 'name:desktop', docId, limit: 1 });
    expect(r.text).toContain('name:');
    expect((await call('search_nodes', { query: 'zzzz' })).text).toContain('Nenhum nó');
    expect((await call('search_nodes', { query: '  ' })).isError).toBe(true);
  });
});
