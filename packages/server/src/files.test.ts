import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNodeFromTag, serializeDocument } from '@mockup/core';
import { FileIndex, FilesError, getFileIndex, normalizeFolder, normalizeTags } from './files.js';
import { DocumentStore } from './store.js';

let dir: string;
let dataDir: string;
let store: DocumentStore;

/** Cria um .mockup.json com um texto no frame. */
function makeDoc(name: string, text: string, sub = ''): string {
  const doc = createDocument(name);
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Frame',
    styles: { width: '100px', height: '100px' },
    position: { x: 0, y: 0 },
  });
  const t = createNodeFromTag('p', { name: 'Texto' });
  t.text = text;
  frame.children.push(t);
  doc.pages[0]!.frames.push(frame);
  const file = path.join(dir, sub, `${name}.mockup.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeDocument(doc), 'utf8');
  return file;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-files-'));
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  store = new DocumentStore({ dataDir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalização', () => {
  it('pastas e tags', () => {
    expect(normalizeFolder(' Clientes\\ Acme //x/ ')).toBe('Clientes/Acme/x');
    expect(() => normalizeFolder('a/../b')).toThrow(FilesError);
    expect(normalizeTags([' Rascunho ', 'rascunho', '', 'Ação', 'acao', 3])).toEqual([
      'Rascunho',
      'Ação',
    ]);
  });
});

describe('FileIndex', () => {
  it('pastas aninhadas: create, rename e delete', async () => {
    const a = makeDoc('a', 'x');
    const b = makeDoc('b', 'y');
    const idx = new FileIndex(store, dataDir);
    expect(await idx.createFolder('Clientes/Acme')).toEqual(['Clientes', 'Clientes/Acme']);
    await idx.setMeta(a, { folder: 'Clientes/Acme' });
    await idx.setMeta(b, { folder: 'Clientes' });

    const direct = await idx.list({ folder: 'Clientes' });
    expect(direct.files.map((f) => f.name)).toEqual(['b']);
    const rec = await idx.list({ folder: 'Clientes', recursive: true });
    expect(rec.files.map((f) => f.name).sort()).toEqual(['a', 'b']);
    expect((await idx.list()).files).toHaveLength(2);

    await idx.renameFolder('Clientes', 'Contas');
    expect(idx.folders()).toEqual(['Contas', 'Contas/Acme']);
    expect((await idx.get(a))!.folder).toBe('Contas/Acme');
    await expect(idx.renameFolder('Contas', 'Contas/Acme/x')).rejects.toThrow(/dentro dela/);
    await expect(idx.renameFolder('Nada', 'X')).rejects.toThrow(/não encontrada/);

    await idx.deleteFolder('Contas/Acme');
    expect(idx.folders()).toEqual(['Contas']);
    expect((await idx.get(a))!.folder).toBe('Contas');
    await idx.deleteFolder('Contas');
    expect((await idx.get(a))!.folder).toBeNull();
    expect((await idx.get(b))!.folder).toBeNull();
    expect(idx.folders()).toEqual([]);
  });

  it('tags e favoritos', async () => {
    const a = makeDoc('a', 'x');
    const b = makeDoc('b', 'y');
    const idx = new FileIndex(store, dataDir);
    await idx.setMeta(a, { tags: [' Cliente ', 'cliente', 'Rascunho'], favorite: true });
    await idx.setMeta(b, { addTags: ['final'] });
    await idx.setMeta(a, { removeTags: ['RASCUNHO'], addTags: ['novo'] });
    expect((await idx.get(a))!.tags).toEqual(['Cliente', 'novo']);
    expect((await idx.list({ tag: 'CLIENTE' })).files.map((f) => f.name)).toEqual(['a']);
    expect((await idx.list({ favorites: true })).files.map((f) => f.name)).toEqual(['a']);
    expect((await idx.list()).tags).toEqual(['Cliente', 'final', 'novo']);
    await idx.setMeta(a, { favorite: false });
    expect((await idx.list({ favorites: true })).files).toHaveLength(0);
    await expect(idx.setMeta(path.join(dir, 'x.mockup.json'), {})).rejects.toThrow(
      /não encontrado/,
    );
    await expect(idx.setMeta(path.join(dir, 'x.txt'), {})).rejects.toThrow(/mockup\.json/);
  });

  it('busca por nome, tag e conteúdo sem acento', async () => {
    const a = makeDoc('proposta', 'Preço do plano mensal');
    const b = makeDoc('outro', 'Nada aqui');
    const idx = new FileIndex(store, dataDir);
    await idx.add(dir);
    await idx.setMeta(b, { tags: ['Ação'] });
    const byContent = (await idx.list({ query: 'PRECO' })).files;
    expect(byContent.map((f) => f.path)).toEqual([a]);
    expect(byContent[0]!.match!.field).toBe('content');
    expect(byContent[0]!.match!.snippet).toContain('Preço');
    expect((await idx.list({ query: 'prop' })).files[0]!.match!.field).toBe('name');
    const byTag = (await idx.list({ query: 'acao' })).files;
    expect(byTag.map((f) => f.path)).toEqual([b]);
    expect(byTag[0]!.match!.field).toBe('tag');
    expect((await idx.list({ query: 'plano zzz' })).files).toHaveLength(0);
    expect((await idx.list({ query: 'plano mensal' })).files).toHaveLength(1);
  });

  it('páginas, frames, ausente e recentes', async () => {
    const a = makeDoc('a', 'x');
    const idx = new FileIndex(store, dataDir);
    await idx.add(a);
    fs.writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify([a]));
    const e = (await idx.get(a))!;
    expect(e).toMatchObject({ pages: 1, frames: 1, recent: 0, open: false, name: 'a' });
    fs.rmSync(a);
    expect((await idx.get(a))!.missing).toBe(true);
    await idx.forget(a);
    // continua listado pelos recentes, mas fora do índice
    expect((await idx.get(a))!.tags).toEqual([]);
  });

  it('add de pasta registra até 2 níveis', async () => {
    makeDoc('n0', 'x');
    makeDoc('n1', 'x', 'p1');
    makeDoc('n2', 'x', 'p1/p2');
    makeDoc('n3', 'x', 'p1/p2/p3');
    const idx = new FileIndex(store, dataDir);
    const { added } = { added: await idx.add(dir) };
    expect(added.map((f) => f.name).sort()).toEqual(['n0', 'n1', 'n2']);
    await expect(idx.add(path.join(dir, 'nao-existe'))).rejects.toThrow(/não encontrado/);
  });

  it('documentos abertos entram sozinhos e a assinatura é única', async () => {
    const a = makeDoc('a', 'texto vivo');
    const idx = getFileIndex(store, dataDir);
    expect(getFileIndex(store, dataDir)).toBe(idx);
    const info = await store.open(a);
    await idx.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(saved.files)).toEqual([path.resolve(a)]);
    expect(saved.files[path.resolve(a)].lastOpenedAt).toBeTruthy();
    const e = (await idx.get(a))!;
    expect(e).toMatchObject({ open: true, docId: info.docId });
    // conteúdo em memória (ainda não salvo)
    const p = store.get(info.docId).pages[0]!.frames[0]!.children[0]!;
    store.applyOps(
      info.docId,
      [{ type: 'setText', changes: [{ nodeId: p.id, text: 'novidade' }] }],
      {
        source: 'mcp',
      },
    );
    expect((await idx.list({ query: 'novidade' })).files).toHaveLength(1);
    expect(store.listenerCount('doc:opened')).toBe(1);
    await store.closeAll();
  });

  it('persiste no files.json e relê; arquivo corrompido vira índice vazio', async () => {
    const a = makeDoc('a', 'x');
    const idx = new FileIndex(store, dataDir);
    await idx.setMeta(a, { folder: 'Z/Y', tags: ['t'], favorite: true });
    await idx.createFolder('Vazia');
    await idx.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.folders).toEqual(expect.arrayContaining(['Z', 'Z/Y', 'Vazia']));
    expect(raw.files[path.resolve(a)]).toMatchObject({
      folder: 'Z/Y',
      tags: ['t'],
      favorite: true,
    });
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const again = new FileIndex(new DocumentStore({ dataDir }), dataDir);
    expect((await again.get(a))!).toMatchObject({ folder: 'Z/Y', tags: ['t'], favorite: true });

    fs.writeFileSync(path.join(dataDir, 'files.json'), '{ quebrado', 'utf8');
    const broken = new FileIndex(new DocumentStore({ dataDir }), dataDir);
    expect((await broken.list()).files).toEqual([]);
    expect(broken.folders()).toEqual([]);
  });

  it('gravações simultâneas não se perdem', async () => {
    const files = [makeDoc('a', 'x'), makeDoc('b', 'x'), makeDoc('c', 'x')];
    const idx = new FileIndex(store, dataDir);
    await Promise.all(files.map((f, i) => idx.setMeta(f, { tags: [`t${i}`] })));
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(raw.files)).toHaveLength(3);
  });

  it('sem dataDir usa índice em memória', async () => {
    const a = makeDoc('a', 'x');
    const idx = new FileIndex(new DocumentStore(), undefined);
    await idx.setMeta(a, { tags: ['m'] });
    expect((await idx.get(a))!.tags).toEqual(['m']);
    expect(fs.existsSync(path.join(dataDir, 'files.json'))).toBe(false);
  });
});
