import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  createDocument,
  createNodeFromTag,
  findNode,
  fontFaceCss,
  walk,
  type Node,
} from '@mockup/core';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotAsset,
  type SnapshotPayload,
} from '@mockup/snapshot-core';
import { importSnapshot } from './snapshot/import.js';
import { SnapshotImportError } from './snapshot/validate.js';
import { DocumentStore } from './store.js';
import { makeWorkspace } from './test-utils.js';

/** Valid PNG (IHDR with the requested dimensions, transparent pixels). */
function fakePng(w: number, h: number, extra = 0): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
    Buffer.alloc(extra),
  ]);
}

const pngDataUrl = (w = 4, h = 3): string =>
  `data:image/png;base64,${fakePng(w, h).toString('base64')}`;

interface TestServer {
  base: string;
  hits: string[];
  close(): Promise<void>;
}

/** Local server with an image, fonts (fake bytes) and a 404. */
async function startAssetServer(): Promise<TestServer> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(url);
    if (url === '/img/logo.png') {
      res.setHeader('content-type', 'image/png');
      res.end(fakePng(20, 10));
    } else if (url.startsWith('/fonts/')) {
      res.setHeader('content-type', 'font/woff2');
      res.end(Buffer.from(`wOF2-fake-${url}`));
    } else {
      res.statusCode = 404;
      res.end('no');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const el = (tag: string, opts: Parameters<typeof createNodeFromTag>[1] = {}): Node =>
  createNodeFromTag(tag, opts);

/** Handcrafted payload: two images (data URL and http), url(asset:) background, text, fonts and reference. */
function makePayload(base: string, over: Partial<SnapshotPayload> = {}): SnapshotPayload {
  const root = el('section', {
    name: 'Hero',
    styles: { width: '1200px', height: '600px', 'font-family': 'Brand, sans-serif' },
    children: [
      el('img', {
        src: 'asset:a1',
        attrs: { alt: 'Inline', srcset: 'x 2x' },
        styles: { width: '40px' },
      }),
      el('img', { src: 'asset:a2', attrs: { alt: 'Logo' }, styles: { width: '120px' } }),
      el('div', {
        name: 'Banner',
        styles: { 'background-image': 'url("asset:a1")', height: '80px' },
      }),
      el('h1', { text: 'Title', styles: { 'font-weight': '700' } }),
    ],
  });
  const assets: SnapshotAsset[] = [
    {
      id: 'a1',
      kind: 'image',
      url: 'https://cdn.example.com/img/inline.png',
      dataUrl: pngDataUrl(),
      mime: 'image/png',
    },
    { id: 'a2', kind: 'image', url: `${base}/img/logo.png` },
    { id: 'f1', kind: 'font', url: `${base}/fonts/brand-400.eot` },
    { id: 'f2', kind: 'font', url: `${base}/fonts/brand-400.woff` },
    { id: 'f3', kind: 'font', url: `${base}/fonts/brand-400.woff2` },
    { id: 'f4', kind: 'font', url: `${base}/fonts/brand-700.woff2` },
  ];
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      // same origin as the test server's assets (127.0.0.1 can only be downloaded this way)
      url: `${base}/page`,
      title: 'Example — Home',
      capturedAt: new Date().toISOString(),
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 1,
    },
    root,
    width: 1200,
    height: 600,
    assets,
    fonts: [
      { family: 'Brand', weight: '400', style: 'normal', assetIds: ['f1', 'f2', 'f3'] },
      { family: 'Brand', weight: '700', style: 'normal', assetIds: ['f4'] },
    ],
    reference: { dataUrl: pngDataUrl(8, 6), width: 1200, height: 600 },
    stats: { nodes: 5, truncated: false, warnings: [] },
    ...over,
  };
}

const imports = (store: DocumentStore, docId: string, p: SnapshotPayload, placement = {}) =>
  importSnapshot(store, p, { docId, ...placement }, { source: 'mcp' });

describe('importSnapshot', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startAssetServer();
  });
  afterAll(async () => {
    await srv.close();
  });

  describe('unsaved document', () => {
    let store: DocumentStore;
    let docId: string;
    beforeEach(() => {
      store = new DocumentStore();
      const doc = createDocument('Memory');
      (store as unknown as { register(d: unknown, p: null): unknown }).register(doc, null);
      docId = doc.id;
    });

    it('embeds images as data URLs, skips fonts with a warning and creates the hidden reference', async () => {
      const r = await imports(store, docId, makePayload(srv.base));
      const doc = store.get(docId);
      const page = doc.pages[0]!;
      expect(page.frames).toHaveLength(2);
      const frame = findNode(doc, r.frameId)!.node;
      expect(frame.type).toBe('frame');
      expect(frame.name).toBe('Example — Home');
      expect(frame.position).toEqual({ x: 0, y: 0 });
      expect(frame.style).toMatchObject({ position: 'relative', width: '1200px', height: '600px' });
      expect(frame.id.startsWith('fr_')).toBe(true);

      const imgs = frame.children.filter((c) => c.type === 'image');
      expect(imgs[0]!.src).toMatch(/^data:image\/png;base64,/);
      expect(imgs[1]!.src).toMatch(/^data:image\/png;base64,/);
      expect(imgs[0]!.attrs.srcset).toBeUndefined();
      expect(frame.children[2]!.style['background-image']).toMatch(
        /^url\("data:image\/png;base64,/,
      );
      expect(srv.hits).toContain('/img/logo.png');

      expect(r.images).toBe(2);
      expect(r.nodes).toBe(5);
      expect(r.method).toBe('snapshot');
      expect(r.fonts).toEqual([]);
      expect(doc.fonts).toEqual([]);
      expect(r.warnings.join('\n')).toContain('save the document to import fonts');

      const ref = findNode(doc, r.referenceId!)!.node;
      expect(ref.hidden).toBe(true);
      expect(ref.name).toBe('Reference — Example — Home');
      expect(ref.position).toEqual({ x: 1200 + 40, y: 0 });
      expect(ref.children[0]!.src).toMatch(/^data:image\/png/);
      expect(ref.children[0]!.style).toMatchObject({ width: '1200px', height: '600px' });
    });

    it("new ids (never the payload's) and a single history entry", async () => {
      const p = makePayload(srv.base);
      const sourceIds = new Set<string>();
      walk(p.root, (n) => void sourceIds.add(n.id));
      const r = await imports(store, docId, p);
      const doc = store.get(docId);
      walk(findNode(doc, r.frameId)!.node, (n) => expect(sourceIds.has(n.id)).toBe(false));
      expect(store.undo(docId, 'editor')).not.toBeNull();
      expect(store.get(docId).pages[0]!.frames).toHaveLength(0);
      expect(store.undo(docId, 'editor')).toBeNull();
    });

    it("default position: right of the last frame (+80) with the first frame's y; explicit x/y; name and reference:false", async () => {
      const first = await imports(store, docId, makePayload(srv.base), {
        reference: false,
        x: 100,
        y: 50,
      });
      expect(first.referenceId).toBeUndefined();
      expect(findNode(store.get(docId), first.frameId)!.node.position).toEqual({ x: 100, y: 50 });
      const second = await imports(store, docId, makePayload(srv.base), {
        reference: false,
        name: 'Other',
      });
      const f = findNode(store.get(docId), second.frameId)!.node;
      expect(f.name).toBe('Other');
      expect(f.position).toEqual({ x: 100 + 1200 + 80, y: 50 });
    });

    it('a failing asset becomes an empty src / url() replaced by none, with a warning', async () => {
      const p = makePayload(srv.base);
      p.assets = [
        { id: 'a1', kind: 'image', url: `${srv.base}/missing.png` },
        { id: 'a2', kind: 'image', url: 'ftp://example.com/x.png' },
      ];
      p.fonts = [];
      const r = await imports(store, docId, p);
      const frame = findNode(store.get(docId), r.frameId)!.node;
      expect(frame.children[0]!.src).toBe('');
      expect(frame.children[1]!.src).toBe('');
      expect(frame.children[2]!.style['background-image']).toBe('none');
      expect(r.images).toBe(0);
      expect(r.warnings.some((w) => w.includes('missing.png'))).toBe(true);
      expect(r.warnings.some((w) => w.includes('ftp://'))).toBe(true);
    });

    it('a non-image is rejected with a warning; a large background (>2 MB) uses the original URL', async () => {
      const p = makePayload(srv.base);
      p.assets = [
        {
          id: 'a1',
          kind: 'image',
          url: 'https://cdn.example.com/big.png',
          dataUrl: `data:image/png;base64,${fakePng(4, 4, 2.5 * 1024 * 1024).toString('base64')}`,
        },
        { id: 'a2', kind: 'image', url: 'https://x/y.png', dataUrl: 'data:image/png;base64,AAAA' },
      ];
      p.fonts = [];
      const r = await imports(store, docId, p);
      const frame = findNode(store.get(docId), r.frameId)!.node;
      expect(frame.children[2]!.style['background-image']).toBe(
        'url("https://cdn.example.com/big.png")',
      );
      expect(frame.children[1]!.src).toBe('');
      expect(r.warnings.join('\n')).toContain('too large to embed');
      expect(r.warnings.join('\n')).toContain('not a recognized image');
    });

    it('a local-network asset from another origin is blocked with a warning and no file', async () => {
      const p = makePayload(srv.base);
      p.source.url = 'https://example.com/';
      p.assets = [{ id: 'a2', kind: 'image', url: `${srv.base}/img/logo.png` }];
      p.fonts = [];
      const before = srv.hits.length;
      const r = await imports(store, docId, p);
      expect(srv.hits.length).toBe(before);
      expect(findNode(store.get(docId), r.frameId)!.node.children[1]!.src).toBe('');
      expect(r.warnings.join('\n')).toContain('local-network destination blocked: 127.0.0.1');
    });

    it('a local-network font from another origin is also blocked, with no file', async () => {
      const ws = makeWorkspace();
      const saved = new DocumentStore({ dataDir: ws.dataDir, autosaveMs: 60_000 });
      try {
        const id = (await saved.open(ws.file)).docId;
        const p = makePayload(srv.base);
        p.source.url = 'https://example.com/';
        const r = await imports(saved, id, p);
        expect(r.fonts).toEqual([]);
        expect(r.warnings.join('\n')).toContain('local-network destination blocked');
        expect(fs.existsSync(path.join(ws.dir, 'assets', 'fonts'))).toBe(false);
      } finally {
        await saved.closeAll();
        ws.cleanup();
      }
    });

    it('with source.url on the same origin as the local asset, it downloads normally', async () => {
      const p = makePayload(srv.base);
      p.source.url = `${srv.base}/other-page`;
      const r = await imports(store, docId, p);
      const frame = findNode(store.get(docId), r.frameId)!.node;
      expect(frame.children[1]!.src).toMatch(/^data:image\/png;base64,/);
      expect(r.warnings.join('\n')).not.toContain('local-network');
    });

    it('exceeding the total budget gives a single warning and the remaining asset gets no file', async () => {
      const png = pngDataUrl();
      const p = makePayload(srv.base);
      p.assets = [
        { id: 'a1', kind: 'image', url: 'https://cdn.example.com/1.png', dataUrl: png },
        { id: 'a2', kind: 'image', url: 'https://cdn.example.com/2.png', dataUrl: png },
      ];
      p.fonts = [];
      const size = Buffer.from(png.split(',')[1]!, 'base64').length;
      const r = await importSnapshot(
        store,
        p,
        { docId },
        { source: 'mcp', maxTotalBytes: size + 1 },
      );
      const frame = findNode(store.get(docId), r.frameId)!.node;
      // one asset fits in the budget (load order does not matter), the other gets no file
      const srcs = [frame.children[0]!.src, frame.children[1]!.src];
      expect(srcs.filter((s) => s.startsWith('data:'))).toHaveLength(1);
      expect(srcs.filter((s) => s === '')).toHaveLength(1);
      const budget = r.warnings.filter((w) => w.includes('budget'));
      expect(budget).toHaveLength(1);
      expect(budget[0]).toContain('exhausted');
    });

    it('removes dangerous URLs from href/formaction/xlink:href and keeps regular ones and asset:', async () => {
      const p = makePayload(srv.base);
      p.root.children.push(
        el('a', { attrs: { href: 'javascript:alert(1)' } }),
        el('button', { attrs: { formaction: ' JaVa\tScript:x()' } }),
        el('a', { attrs: { href: 'https://example.com/ok' } }),
        el('a', { attrs: { 'xlink:href': 'data:text/html,<script>1</script>' } }),
      );
      const r = await imports(store, docId, p);
      const kids = findNode(store.get(docId), r.frameId)!.node.children;
      const attrsOf = (i: number) => kids[kids.length - 4 + i]!.attrs;
      expect(attrsOf(0).href).toBeUndefined();
      expect(attrsOf(1).formaction).toBeUndefined();
      expect(attrsOf(2).href).toBe('https://example.com/ok');
      expect(attrsOf(3)['xlink:href']).toBeUndefined();
      expect(kids[0]!.src).toMatch(/^data:image\/png/);
      expect(r.warnings.join('\n')).toContain('removed for safety');
    });

    it('sanitizes on* attributes and blocked tags instead of failing', async () => {
      const p = makePayload(srv.base);
      p.root.children.push(el('div', { attrs: { onclick: 'x()' } }));
      (p.root.children as Node[]).push({ ...el('div'), tag: 'script' });
      const r = await imports(store, docId, p);
      const frame = findNode(store.get(docId), r.frameId)!.node;
      expect(frame.children.some((c) => c.tag === 'script')).toBe(false);
      expect(frame.children.at(-1)!.attrs.onclick).toBeUndefined();
      expect(r.warnings.join('\n')).toContain('removed for safety');
    });
  });

  describe('usage errors', () => {
    it('invalid payload, version, too many nodes, no document and nonexistent document/page', async () => {
      const store = new DocumentStore();
      const p = makePayload(srv.base);
      await expect(importSnapshot(store, { foo: 1 }, {}, { source: 'mcp' })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Invalid snapshot'),
      });
      await expect(
        importSnapshot(store, { ...p, version: 2 }, {}, { source: 'mcp' }),
      ).rejects.toThrow(/unsupported snapshot version/);
      const big = {
        ...p,
        root: { ...p.root, children: Array.from({ length: 5001 }, () => el('div')) },
      };
      await expect(importSnapshot(store, big, {}, { source: 'mcp' })).rejects.toThrow(
        /more than 5000 nodes/,
      );
      await expect(importSnapshot(store, p, {}, { source: 'mcp' })).rejects.toMatchObject({
        status: 409,
      });
      const doc = createDocument('x');
      (store as unknown as { register(d: unknown, p: null): unknown }).register(doc, null);
      await expect(
        importSnapshot(store, p, { docId: 'doc_missing' }, { source: 'mcp' }),
      ).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        importSnapshot(store, p, { pageId: 'pg_missing' }, { source: 'mcp' }),
      ).rejects.toBeInstanceOf(SnapshotImportError);
      await expect(
        importSnapshot(
          store,
          { ...p, root: { ...p.root, children: [{ id: 1 }] } },
          {},
          { source: 'mcp' },
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('saved document', () => {
    let ws: ReturnType<typeof makeWorkspace>;
    let store: DocumentStore;
    let docId: string;
    beforeEach(async () => {
      ws = makeWorkspace();
      store = new DocumentStore({ dataDir: ws.dataDir, autosaveMs: 60_000 });
      docId = (await store.open(ws.file)).docId;
    });
    afterEach(async () => {
      await store.closeAll();
      ws.cleanup();
    });
    const assets = (): string => path.join(ws.dir, 'assets');

    it('writes images to assets/ (URL name, no duplicates), fonts to assets/fonts and the reference', async () => {
      const r = await imports(store, docId, makePayload(srv.base));
      const doc = store.get(docId);
      const frame = findNode(doc, r.frameId)!.node;
      expect(frame.children[0]!.src).toBe('inline.png');
      expect(frame.children[1]!.src).toBe('logo.png');
      // the url() background is embedded even with assets/ (the canvas does not resolve relative paths in styles)
      expect(frame.children[2]!.style['background-image']).toMatch(/^url\("data:image\/png/);
      expect(fs.existsSync(path.join(assets(), 'inline.png'))).toBe(true);
      expect(fs.readFileSync(path.join(assets(), 'logo.png'))).toEqual(fakePng(20, 10));

      // fonts: the best format (woff2), name with weight/style/hash
      const fontFiles = fs.readdirSync(path.join(assets(), 'fonts')).sort();
      expect(fontFiles).toHaveLength(2);
      expect(fontFiles[0]).toMatch(/^brand-400-normal-[0-9a-f]{8}\.woff2$/);
      expect(fontFiles[1]).toMatch(/^brand-700-normal-[0-9a-f]{8}\.woff2$/);
      expect(r.fonts).toEqual(['Brand']);
      const brand = doc.fonts.find((f) => f.family === 'Brand')!;
      expect(brand.source).toBe('file');
      expect(brand.files!.map((f) => f.replace(/-[0-9a-f]{8}/, ''))).toEqual([
        'fonts/brand-400-normal.woff2',
        'fonts/brand-700-normal.woff2',
      ]);
      expect(brand.weights).toEqual([400, 700]);
      expect(brand.styles).toEqual(['normal', 'normal']);
      const css = fontFaceCss(doc, (f) => `/assets/${f}`);
      expect(css).toContain('font-weight:400;font-style:normal');
      expect(css).toContain('font-weight:700;font-style:normal');

      const refFile = fs.readdirSync(assets()).find((f) => f.startsWith('reference-'));
      expect(refFile).toMatch(/\.png$/);
      expect(findNode(doc, r.referenceId!)!.node.children[0]!.src).toBe(refFile);
      expect(srv.hits.filter((h) => h.endsWith('brand-400.eot'))).toHaveLength(0);
    });

    it('re-importing reuses files with the same content and does not duplicate fonts', async () => {
      await imports(store, docId, makePayload(srv.base));
      const before = fs.readdirSync(assets()).sort();
      const fontsBefore = fs.readdirSync(path.join(assets(), 'fonts')).sort();
      const r2 = await imports(store, docId, makePayload(srv.base));
      expect(fs.readdirSync(assets()).sort()).toEqual(before);
      expect(fs.readdirSync(path.join(assets(), 'fonts')).sort()).toEqual(fontsBefore);
      const doc = store.get(docId);
      expect(doc.fonts).toHaveLength(1);
      expect(doc.fonts[0]!.files).toHaveLength(2);
      expect(findNode(doc, r2.frameId)!.node.children[0]!.src).toBe('inline.png');
    });

    it('a file with the same name and different content gets a suffix, without overwriting', async () => {
      fs.mkdirSync(assets());
      fs.writeFileSync(path.join(assets(), 'logo.png'), fakePng(2, 2));
      const r = await imports(store, docId, makePayload(srv.base));
      expect(findNode(store.get(docId), r.frameId)!.node.children[1]!.src).toBe('logo-1.png');
      expect(fs.readFileSync(path.join(assets(), 'logo.png'))).toEqual(fakePng(2, 2));
    });

    it('variable font (range) uses the same format as add_font: one file and weights with the extremes', async () => {
      const p = makePayload(srv.base);
      p.fonts = [{ family: 'Vari', weight: '100 900', style: 'normal', assetIds: ['f3'] }];
      await imports(store, docId, p);
      const v = store.get(docId).fonts[0]!;
      expect(v.files).toHaveLength(1);
      expect(v.files![0]).toMatch(/^fonts\/vari-100-900-normal-[0-9a-f]{8}\.woff2$/);
      expect(v.weights).toEqual([100, 900]);
      expect(fontFaceCss(store.get(docId), (f) => f)).toContain('font-weight:100 900');
    });

    it('existing family: files added without duplicating; one from another source is left untouched', async () => {
      store.applyOps(
        docId,
        [
          {
            type: 'setFonts',
            fonts: [
              {
                family: 'Brand',
                source: 'file',
                files: ['fonts/old-400.woff2'],
                weights: [400],
                styles: ['normal'],
              },
              { family: 'Local One', source: 'local' },
            ],
          },
        ],
        { source: 'mcp' },
      );
      const p = makePayload(srv.base);
      p.fonts = [
        { family: 'Brand', weight: '400', style: 'normal', assetIds: ['f3'] },
        { family: 'Brand', weight: '700', style: 'normal', assetIds: ['f4'] },
        { family: 'Local One', weight: '400', style: 'normal', assetIds: ['f3'] },
      ];
      const r = await imports(store, docId, p);
      const fonts = store.get(docId).fonts;
      const brand = fonts.find((f) => f.family === 'Brand')!;
      // 400/normal already existed: only 700 is added
      expect(brand.files).toHaveLength(2);
      expect(brand.files![0]).toBe('fonts/old-400.woff2');
      expect(brand.weights).toEqual([400, 700]);
      expect(fonts.find((f) => f.family === 'Local One')).toEqual({
        family: 'Local One',
        source: 'local',
      });
      expect(r.warnings.join('\n')).toContain('Local One');
      expect(r.fonts).toEqual(['Brand']);
    });

    it('accepts payloads larger than 20 MB in the pipeline (a 17 MB image is written to assets/)', async () => {
      const p = makePayload(srv.base);
      p.assets[0]!.dataUrl = `data:image/png;base64,${fakePng(4, 4, 17 * 1024 * 1024).toString('base64')}`;
      p.fonts = [];
      const r = await imports(store, docId, p);
      expect(r.images).toBe(2);
      expect(fs.statSync(path.join(assets(), 'inline.png')).size).toBeGreaterThan(17 * 1024 * 1024);
    });
  });
});
