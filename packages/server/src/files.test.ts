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

/** Creates a .mockup.json with a text in the frame. */
function makeDoc(name: string, text: string, sub = ''): string {
  const doc = createDocument(name);
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'Frame',
    styles: { width: '100px', height: '100px' },
    position: { x: 0, y: 0 },
  });
  const t = createNodeFromTag('p', { name: 'Text' });
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

describe('normalization', () => {
  it('folders and tags', () => {
    expect(normalizeFolder(' Clients\\ Acme //x/ ')).toBe('Clients/Acme/x');
    expect(() => normalizeFolder('a/../b')).toThrow(FilesError);
    expect(normalizeTags([' Draft ', 'draft', '', 'Café', 'cafe', 3])).toEqual(['Draft', 'Café']);
  });
});

describe('FileIndex', () => {
  it('nested folders: create, rename and delete', async () => {
    const a = makeDoc('a', 'x');
    const b = makeDoc('b', 'y');
    const idx = new FileIndex(store, dataDir);
    expect(await idx.createFolder('Clients/Acme')).toEqual(['Clients', 'Clients/Acme']);
    await idx.setMeta(a, { folder: 'Clients/Acme' });
    await idx.setMeta(b, { folder: 'Clients' });

    const direct = await idx.list({ folder: 'Clients' });
    expect(direct.files.map((f) => f.name)).toEqual(['b']);
    const rec = await idx.list({ folder: 'Clients', recursive: true });
    expect(rec.files.map((f) => f.name).sort()).toEqual(['a', 'b']);
    expect((await idx.list()).files).toHaveLength(2);

    await idx.renameFolder('Clients', 'Accounts');
    expect(idx.folders()).toEqual(['Accounts', 'Accounts/Acme']);
    expect((await idx.get(a))!.folder).toBe('Accounts/Acme');
    await expect(idx.renameFolder('Accounts', 'Accounts/Acme/x')).rejects.toThrow(/into itself/);
    await expect(idx.renameFolder('Nothing', 'X')).rejects.toThrow(/not found/);

    await idx.deleteFolder('Accounts/Acme');
    expect(idx.folders()).toEqual(['Accounts']);
    expect((await idx.get(a))!.folder).toBe('Accounts');
    await idx.deleteFolder('Accounts');
    expect((await idx.get(a))!.folder).toBeNull();
    expect((await idx.get(b))!.folder).toBeNull();
    expect(idx.folders()).toEqual([]);
  });

  it('tags and favorites', async () => {
    const a = makeDoc('a', 'x');
    const b = makeDoc('b', 'y');
    const idx = new FileIndex(store, dataDir);
    await idx.setMeta(a, { tags: [' Client ', 'client', 'Draft'], favorite: true });
    await idx.setMeta(b, { addTags: ['final'] });
    await idx.setMeta(a, { removeTags: ['DRAFT'], addTags: ['new'] });
    expect((await idx.get(a))!.tags).toEqual(['Client', 'new']);
    expect((await idx.list({ tag: 'CLIENT' })).files.map((f) => f.name)).toEqual(['a']);
    expect((await idx.list({ favorites: true })).files.map((f) => f.name)).toEqual(['a']);
    expect((await idx.list()).tags).toEqual(['Client', 'final', 'new']);
    await idx.setMeta(a, { favorite: false });
    expect((await idx.list({ favorites: true })).files).toHaveLength(0);
    await expect(idx.setMeta(path.join(dir, 'x.mockup.json'), {})).rejects.toThrow(/not found/);
    await expect(idx.setMeta(path.join(dir, 'x.txt'), {})).rejects.toThrow(/mockup\.json/);
  });

  it('search by name, tag and content, accent-insensitive', async () => {
    const a = makeDoc('proposal', 'Résumé of the monthly plan');
    const b = makeDoc('other', 'Nothing here');
    const idx = new FileIndex(store, dataDir);
    await idx.add(dir);
    await idx.setMeta(b, { tags: ['Café'] });
    const byContent = (await idx.list({ query: 'RESUME' })).files;
    expect(byContent.map((f) => f.path)).toEqual([a]);
    expect(byContent[0]!.match!.field).toBe('content');
    expect(byContent[0]!.match!.snippet).toContain('Résumé');
    expect((await idx.list({ query: 'prop' })).files[0]!.match!.field).toBe('name');
    const byTag = (await idx.list({ query: 'cafe' })).files;
    expect(byTag.map((f) => f.path)).toEqual([b]);
    expect(byTag[0]!.match!.field).toBe('tag');
    expect((await idx.list({ query: 'plan zzz' })).files).toHaveLength(0);
    expect((await idx.list({ query: 'monthly plan' })).files).toHaveLength(1);
  });

  it('pages, frames, missing and recents', async () => {
    const a = makeDoc('a', 'x');
    const idx = new FileIndex(store, dataDir);
    await idx.add(a);
    fs.writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify([a]));
    const e = (await idx.get(a))!;
    expect(e).toMatchObject({ pages: 1, frames: 1, recent: 0, open: false, name: 'a' });
    fs.rmSync(a);
    expect((await idx.get(a))!.missing).toBe(true);
    await idx.forget(a);
    // still listed through the recents, but outside the index
    expect((await idx.get(a))!.tags).toEqual([]);
  });

  it('add on a folder registers up to 2 levels', async () => {
    makeDoc('n0', 'x');
    makeDoc('n1', 'x', 'p1');
    makeDoc('n2', 'x', 'p1/p2');
    makeDoc('n3', 'x', 'p1/p2/p3');
    const idx = new FileIndex(store, dataDir);
    const { added } = { added: await idx.add(dir) };
    expect(added.map((f) => f.name).sort()).toEqual(['n0', 'n1', 'n2']);
    await expect(idx.add(path.join(dir, 'does-not-exist'))).rejects.toThrow(/not found/);
  });

  it('open documents are added automatically and the subscription is unique', async () => {
    const a = makeDoc('a', 'live text');
    const idx = getFileIndex(store, dataDir);
    expect(getFileIndex(store, dataDir)).toBe(idx);
    const info = await store.open(a);
    await idx.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(saved.files)).toEqual([path.resolve(a)]);
    expect(saved.files[path.resolve(a)].lastOpenedAt).toBeTruthy();
    const e = (await idx.get(a))!;
    expect(e).toMatchObject({ open: true, docId: info.docId });
    // in-memory content (not saved yet)
    const p = store.get(info.docId).pages[0]!.frames[0]!.children[0]!;
    store.applyOps(info.docId, [{ type: 'setText', changes: [{ nodeId: p.id, text: 'news' }] }], {
      source: 'mcp',
    });
    expect((await idx.list({ query: 'news' })).files).toHaveLength(1);
    expect(store.listenerCount('doc:opened')).toBe(1);
    await store.closeAll();
  });

  it('persists to files.json and reads it back; a corrupted file becomes an empty index', async () => {
    const a = makeDoc('a', 'x');
    const idx = new FileIndex(store, dataDir);
    await idx.setMeta(a, { folder: 'Z/Y', tags: ['t'], favorite: true });
    await idx.createFolder('Empty');
    await idx.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.folders).toEqual(expect.arrayContaining(['Z', 'Z/Y', 'Empty']));
    expect(raw.files[path.resolve(a)]).toMatchObject({
      folder: 'Z/Y',
      tags: ['t'],
      favorite: true,
    });
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const again = new FileIndex(new DocumentStore({ dataDir }), dataDir);
    expect((await again.get(a))!).toMatchObject({ folder: 'Z/Y', tags: ['t'], favorite: true });

    fs.writeFileSync(path.join(dataDir, 'files.json'), '{ broken', 'utf8');
    const broken = new FileIndex(new DocumentStore({ dataDir }), dataDir);
    expect((await broken.list()).files).toEqual([]);
    expect(broken.folders()).toEqual([]);
  });

  it('concurrent writes are not lost', async () => {
    const files = [makeDoc('a', 'x'), makeDoc('b', 'x'), makeDoc('c', 'x')];
    const idx = new FileIndex(store, dataDir);
    await Promise.all(files.map((f, i) => idx.setMeta(f, { tags: [`t${i}`] })));
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(raw.files)).toHaveLength(3);
  });

  it('without dataDir it uses an in-memory index', async () => {
    const a = makeDoc('a', 'x');
    const idx = new FileIndex(new DocumentStore(), undefined);
    await idx.setMeta(a, { tags: ['m'] });
    expect((await idx.get(a))!.tags).toEqual(['m']);
    expect(fs.existsSync(path.join(dataDir, 'files.json'))).toBe(false);
  });
});
