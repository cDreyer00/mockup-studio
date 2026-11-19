import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // forgotten: gone from the index and from the recents
    expect((await idx.list()).files).toEqual([]);
  });

  it('forget removes the file from the list for good: index, recents and open documents', async () => {
    const a = makeDoc('a', 'x');
    const b = makeDoc('b', 'y');
    const idx = getFileIndex(store, dataDir);
    const info = await store.open(a);
    await store.open(b);
    const p = store.get(info.docId).pages[0]!.frames[0]!.children[0]!;
    store.applyOps(
      info.docId,
      [{ type: 'setText', changes: [{ nodeId: p.id, text: 'unsaved' }] }],
      {
        source: 'mcp',
      },
    );
    const names = async (): Promise<string[]> => (await idx.list()).files.map((f) => f.name).sort();
    expect(await names()).toEqual(['a', 'b']);

    await idx.forget(a);
    // the open document is closed first (pending changes saved), then forgotten
    expect(store.list().map((d) => d.path)).toEqual([path.resolve(b)]);
    expect(fs.readFileSync(a, 'utf8')).toContain('unsaved');
    expect(await names()).toEqual(['b']);
    const recent = JSON.parse(fs.readFileSync(path.join(dataDir, 'recent.json'), 'utf8'));
    expect(recent).toEqual([path.resolve(b)]);
    await idx.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'files.json'), 'utf8'));
    expect(Object.keys(saved.files)).toEqual([path.resolve(b)]);
    // a fresh index (next daemon start) does not bring it back either
    expect(
      (await new FileIndex(new DocumentStore({ dataDir }), dataDir).list()).files,
    ).toHaveLength(1);
    expect(idx.isKnown(a)).toBe(false);

    // opening it again explicitly registers it as usual
    await store.open(a);
    expect(await names()).toEqual(['a', 'b']);
    await store.closeAll();
  });

  it('forget also drops the cached thumbnails of the file', async () => {
    const a = makeDoc('a', 'x');
    const b = makeDoc('b', 'x');
    const idx = new FileIndex(store, dataDir);
    await idx.add(dir);
    const thumbs = path.join(dataDir, 'thumbs');
    fs.mkdirSync(thumbs);
    const hash = (p: string): string =>
      createHash('sha1')
        .update(process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
        .digest('hex');
    for (const w of [240, 480]) {
      fs.writeFileSync(path.join(thumbs, `${hash(a)}-${w}.png`), 'x');
      fs.writeFileSync(path.join(thumbs, `${hash(b)}-${w}.png`), 'x');
    }
    await idx.forget(a);
    expect(fs.readdirSync(thumbs).sort()).toEqual([`${hash(b)}-240.png`, `${hash(b)}-480.png`]);
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

describe('FileIndex.deleteFile', () => {
  /** Document in `dir` whose frame uses the given asset paths (img src, background and font). */
  function docUsing(name: string, assets: { img?: string[]; bg?: string; font?: string }): string {
    const doc = createDocument(name);
    const frame = createNodeFromTag('div', {
      isRoot: true,
      name: 'Frame',
      styles: assets.bg ? { 'background-image': `url(assets/${assets.bg})` } : {},
      position: { x: 0, y: 0 },
    });
    for (const src of assets.img ?? []) {
      const img = createNodeFromTag('img', { name: 'Img' });
      img.src = `assets/${src}`;
      frame.children.push(img);
    }
    doc.pages[0]!.frames.push(frame);
    if (assets.font) doc.fonts.push({ family: 'Brand', source: 'file', files: [assets.font] });
    const file = path.join(dir, `${name}.mockup.json`);
    fs.writeFileSync(file, serializeDocument(doc), 'utf8');
    return file;
  }
  const asset = (rel: string): string => {
    const f = path.join(dir, 'assets', ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rel);
    return f;
  };
  const listed = async (idx: FileIndex): Promise<string[]> =>
    (await idx.list()).files.map((f) => f.name).sort();

  it('removes the file and its exclusive assets, keeps shared and unreferenced ones', async () => {
    const a = docUsing('a', {
      img: ['only-a.png', 'shared.png'],
      bg: 'bg-a.png',
      font: 'fonts/a.woff2',
    });
    const b = docUsing('b', { img: ['shared.png', 'only-b.png'] });
    for (const r of ['only-a.png', 'shared.png', 'bg-a.png', 'fonts/a.woff2', 'only-b.png'])
      asset(r);
    asset('orphan.png');
    const idx = new FileIndex(store, dataDir);
    await idx.add(dir);
    fs.writeFileSync(path.join(dataDir, 'recent.json'), JSON.stringify([a, b]));

    const plan = await idx.deleteFile(a, { dryRun: true });
    expect(plan).toMatchObject({
      name: 'a',
      mode: 'permanent',
      open: false,
      assets: ['bg-a.png', 'fonts/a.woff2', 'only-a.png'],
      keptAssets: ['shared.png'],
    });
    expect(fs.existsSync(a)).toBe(true);

    const r = await idx.deleteFile(a);
    expect(r.assets).toEqual(['bg-a.png', 'fonts/a.woff2', 'only-a.png']);
    expect(r.failedAssets).toEqual([]);
    expect(fs.existsSync(a)).toBe(false);
    const left = fs.readdirSync(path.join(dir, 'assets')).sort();
    // fonts/ became empty and is removed too
    expect(left).toEqual(['only-b.png', 'orphan.png', 'shared.png']);
    expect(await listed(idx)).toEqual(['b']);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'recent.json'), 'utf8'))).toEqual([b]);
  });

  it('uses the trash provider when given and removes an empty assets folder', async () => {
    const a = docUsing('a', { img: ['x.png'] });
    asset('x.png');
    const idx = new FileIndex(store, dataDir);
    const trashed: string[] = [];
    const r = await idx.deleteFile(a, {
      trash: async (p) => {
        trashed.push(p);
        fs.rmSync(p);
      },
    });
    expect(r.mode).toBe('trash');
    expect(trashed).toEqual([path.resolve(a), path.join(dir, 'assets', 'x.png')]);
    expect(fs.existsSync(path.join(dir, 'assets'))).toBe(false);
  });

  it('a failing trash aborts before touching the assets', async () => {
    const a = docUsing('a', { img: ['x.png'] });
    asset('x.png');
    const idx = new FileIndex(store, dataDir);
    await expect(
      idx.deleteFile(a, {
        trash: async () => {
          throw new Error('no recycle bin');
        },
      }),
    ).rejects.toThrow(/no recycle bin/);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'assets', 'x.png'))).toBe(true);
  });

  it('closes an open document first, with no autosave bringing it back', async () => {
    const a = docUsing('a', { img: ['x.png'] });
    asset('x.png');
    const s = new DocumentStore({ dataDir, autosaveMs: 5 });
    const idx = getFileIndex(s, dataDir);
    const info = await s.open(a);
    const frame = s.get(info.docId).pages[0]!.frames[0]!;
    s.applyOps(
      info.docId,
      [{ type: 'updateStyles', changes: [{ nodeId: frame.id, set: { color: 'red' } }] }],
      {
        source: 'mcp',
      },
    );
    expect((await idx.deleteFile(a, { dryRun: true })).open).toBe(true);
    const r = await idx.deleteFile(a);
    expect(r.open).toBe(true);
    expect(s.list()).toEqual([]);
    await new Promise((res) => setTimeout(res, 50));
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'assets'))).toBe(false);
    expect(await listed(idx)).toEqual([]);
  });

  it('an open sibling with unsaved references keeps the asset', async () => {
    const a = docUsing('a', { img: ['x.png'] });
    const b = docUsing('b', {});
    asset('x.png');
    const idx = getFileIndex(store, dataDir);
    const info = await store.open(b);
    const frame = store.get(info.docId).pages[0]!.frames[0]!;
    store.applyOps(
      info.docId,
      [
        {
          type: 'updateStyles',
          changes: [{ nodeId: frame.id, set: { 'background-image': 'url(assets/x.png)' } }],
        },
      ],
      { source: 'mcp' },
    );
    const r = await idx.deleteFile(a);
    expect(r.assets).toEqual([]);
    expect(r.keptAssets).toEqual(['x.png']);
    expect(fs.existsSync(path.join(dir, 'assets', 'x.png'))).toBe(true);
    await store.closeAll();
  });

  it('an unreadable sibling keeps every asset', async () => {
    const a = docUsing('a', { img: ['x.png'] });
    asset('x.png');
    fs.mkdirSync(path.join(dir, 'weird.mockup.json'));
    fs.writeFileSync(path.join(dir, 'broken.mockup.json'), '{ not json');
    const idx = new FileIndex(store, dataDir);
    // a broken sibling is still read as text: no mention of x.png, so it goes
    expect((await idx.deleteFile(a, { dryRun: true })).assets).toEqual(['x.png']);
    const sibling = path.join(dir, 'broken.mockup.json');
    const realRead = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (String(file) === sibling) return Promise.reject(new Error('EACCES'));
      return (realRead as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.readFile);
    try {
      expect(await idx.deleteFile(a, { dryRun: true })).toMatchObject({
        assets: [],
        keptAssets: ['x.png'],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('errors for missing files, folders and non-.mockup.json paths', async () => {
    const idx = new FileIndex(store, dataDir);
    await expect(idx.deleteFile(path.join(dir, 'nope.mockup.json'))).rejects.toThrow(
      /File not found/,
    );
    fs.mkdirSync(path.join(dir, 'folder.mockup.json'));
    await expect(idx.deleteFile(path.join(dir, 'folder.mockup.json'))).rejects.toThrow(
      /Not a file/,
    );
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    await expect(idx.deleteFile(path.join(dir, 'notes.txt'))).rejects.toThrow(/mockup\.json/);
    await expect(idx.deleteFile('relative.mockup.json')).rejects.toThrow(/absolute/);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });
});
