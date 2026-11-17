import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { optimizeDocAssets } from './assetsService.js';
import { startDaemon, type DaemonHandle } from './index.js';
import type { DocumentStore } from './store.js';
import { makeWorkspace } from './test-utils.js';

type Ws = ReturnType<typeof makeWorkspace>;
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

function fakePng(w: number, h: number, fill = 0): Buffer {
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
  const raw = Buffer.alloc(h * (1 + w * 4), fill);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sha32 = (b: Buffer): string =>
  crypto.createHash('sha256').update(b).digest('hex').slice(0, 32);

describe('assets, CDN and library (HTTP + MCP)', () => {
  let ws: Ws;
  let ws2: Ws;
  let daemon: DaemonHandle;
  let client: Client;
  let base: string;

  beforeEach(async () => {
    ws = makeWorkspace();
    ws2 = makeWorkspace();
    daemon = await startDaemon({ port: 0, dataDir: ws.dataDir, writeInfo: false });
    base = `http://127.0.0.1:${daemon.port}`;
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(daemon.mcpUrl)));
    await client.callTool({ name: 'open_document', arguments: { path: ws.file } });
  });
  afterEach(async () => {
    await client.close();
    await daemon.close();
    ws.cleanup();
    ws2.cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const docId = (): string => daemon.store.resolveDocId();
  const doc = () => daemon.store.get(docId());
  const frame = () => doc().pages[0]!.frames[0]!;
  const upload = (id: string, name: string, bytes: Buffer) =>
    fetch(`${base}/api/assets/${id}?name=${name}`, { method: 'POST', body: new Uint8Array(bytes) });
  const post = (url: string, body: unknown) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('HTTP routes', () => {
    it('/cdn/<hash>.png serves with the contract headers; 404 and invalid names', async () => {
      const png = fakePng(30, 20);
      const hash = sha32(png);
      const lib = await fetch(`${base}/api/library?name=cover.png`, {
        method: 'POST',
        body: new Uint8Array(png),
      });
      expect(lib.status).toBe(200);
      const asset = (await lib.json()) as { hash: string; url: string; width: number };
      expect(asset).toMatchObject({ hash, url: `/cdn/${hash}.png`, width: 30 });

      const r = await fetch(`${base}/cdn/${hash}.png`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);

      expect((await fetch(`${base}/cdn/${'0'.repeat(32)}.png`)).status).toBe(404);
      expect((await fetch(`${base}/cdn/${hash}.jpg`)).status).toBe(404);
      for (const bad of ['..%2Findex.json', 'index.json', `${hash}.exe`, `${hash.slice(1)}.png`]) {
        expect((await fetch(`${base}/cdn/${bad}`)).status).toBe(404);
      }
      expect((await fetch(`${base}/cdn/%2e%2e%2f%2e%2e%2fpackage.json`)).status).toBe(404);
    });

    it('svg is served inline with the restrictive CSP (sandbox, no script)', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>');
      const a = (await (
        await fetch(`${base}/api/library?name=i.svg`, { method: 'POST', body: new Uint8Array(svg) })
      ).json()) as { hash: string };
      const r = await fetch(`${base}/cdn/${a.hash}.svg`);
      expect(r.headers.get('content-type')).toBe('image/svg+xml');
      expect(r.headers.get('content-disposition')).toBe('inline');
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain('sandbox');
      expect(csp).not.toContain('script-src');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('listing does not register on the CDN; the link does', async () => {
      const png = fakePng(12, 10, 9);
      const hash = sha32(png);
      fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ws.dir, 'assets', 'loose.png'), png);
      const list = (await (await fetch(`${base}/api/assets/${docId()}`)).json()) as {
        assets: { path: string; hash: string; cdnUrl: string }[];
      };
      const a = list.assets.find((x) => x.path === 'loose.png')!;
      expect(a.hash).toBe(hash);
      expect(a.cdnUrl).toBe('');
      expect((await fetch(`${base}/cdn/${hash}.png`)).status).toBe(404);

      const link = await post(`/api/assets/${docId()}/link`, { path: 'loose.png' });
      expect(link.status).toBe(200);
      expect((await fetch(`${base}/cdn/${hash}.png`)).status).toBe(200);
      const again = (await (await fetch(`${base}/api/assets/${docId()}`)).json()) as typeof list;
      expect(again.assets.find((x) => x.path === 'loose.png')!.cdnUrl).toBe(
        `${base}/cdn/${hash}.png`,
      );
    });

    it('the same content gives the same link across documents', async () => {
      const open2 = await call('open_document', { path: ws2.file });
      expect(open2.isError, textOf(open2)).toBeFalsy();
      const ids = daemon.store.list().map((d) => d.docId);
      expect(ids).toHaveLength(2);
      const png = fakePng(16, 16, 7);
      await upload(ids[0]!, 'a.png', png);
      await upload(ids[1]!, 'b.png', png);
      const l1 = (await (await fetch(`${base}/api/assets/${ids[0]}`)).json()) as {
        assets: { hash: string; cdnUrl: string }[];
      };
      const l2 = (await (await fetch(`${base}/api/assets/${ids[1]}`)).json()) as typeof l1;
      expect(l1.assets[0]!.hash).toBe(sha32(png));
      expect(l1.assets[0]!.cdnUrl).toBe(l2.assets[0]!.cdnUrl);
      expect(l1.assets[0]!.cdnUrl).toBe(`${base}/cdn/${sha32(png)}.png`);
      expect(daemon.store.assetsDir(ids[0]!)).not.toBe(daemon.store.assetsDir(ids[1]!));
    });

    it('GET /api/assets/:docId lists recursively with uses; DELETE 409 when in use; remove-unused; link', async () => {
      const id = docId();
      const used = fakePng(40, 30, 1);
      const spare = fakePng(10, 10, 2);
      await upload(id, 'used.png', used);
      await upload(id, 'spare.png', spare);
      const sub = path.join(ws.dir, 'assets', 'photos');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'cover.png'), fakePng(12, 12, 3));
      fs.writeFileSync(path.join(ws.dir, 'assets', '.hidden.png'), fakePng(5, 5));
      fs.writeFileSync(path.join(ws.dir, 'assets', 'x.png.tmp'), 'x');
      await call('insert_image', { parentId: ws.frameId, source: path.join(sub, 'cover.png') });
      await call('insert_image', { parentId: ws.frameId, source: path.join(sub, 'cover.png') });
      const imgSrc = frame().children[0]!.src!;
      expect(imgSrc).toBe('cover.png');

      const list = (await (await fetch(`${base}/api/assets/${id}`)).json()) as {
        assets: {
          path: string;
          kind: string;
          uses: number;
          nodeIds: string[];
          width?: number;
          mime: string;
          ext: string;
          name: string;
          mtime: number;
          refKinds: string[];
          size: number;
        }[];
      };
      const byPath = Object.fromEntries(list.assets.map((a) => [a.path, a]));
      expect(Object.keys(byPath).sort()).toEqual([
        'cover-1.png',
        'cover.png',
        'photos/cover.png',
        'spare.png',
        'used.png',
      ]);
      expect(byPath['cover.png']).toMatchObject({
        uses: 1,
        kind: 'image',
        width: 12,
        mime: 'image/png',
        ext: '.png',
        name: 'cover.png',
        refKinds: ['src'],
      });
      expect(byPath['spare.png']!.uses).toBe(0);
      expect(byPath['cover.png']!.nodeIds).toHaveLength(1);

      // in use: 409; with force it removes
      const conflict = await fetch(`${base}/api/assets/${id}?path=cover.png`, { method: 'DELETE' });
      expect(conflict.status).toBe(409);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'cover.png'))).toBe(true);
      expect(
        (await fetch(`${base}/api/assets/${id}?path=..%2Ftest.mockup.json`, { method: 'DELETE' }))
          .status,
      ).toBe(400);
      expect(
        (await fetch(`${base}/api/assets/${id}?path=missing.png`, { method: 'DELETE' })).status,
      ).toBe(404);

      // remove-unused: dryRun does not delete
      const dry = (await (
        await post(`/api/assets/${id}/remove-unused`, { dryRun: true })
      ).json()) as { removed: string[]; kept: number };
      expect(dry.removed.sort()).toEqual(['photos/cover.png', 'spare.png', 'used.png']);
      expect(dry.kept).toBe(2);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'spare.png'))).toBe(true);
      const real = (await (await post(`/api/assets/${id}/remove-unused`, {})).json()) as {
        removed: string[];
      };
      expect(real.removed).toHaveLength(3);
      expect(
        fs
          .readdirSync(path.join(ws.dir, 'assets'))
          .filter((f) => !f.startsWith('.') && !f.endsWith('.tmp')),
      ).toEqual(['cover-1.png', 'cover.png', 'photos']);

      // link
      const link = (await (await post(`/api/assets/${id}/link`, { path: 'cover.png' })).json()) as {
        hash: string;
        url: string;
        cdnPath: string;
      };
      expect(link.url).toBe(`${base}/cdn/${link.hash}.png`);
      expect(link.cdnPath).toBe(`/cdn/${link.hash}.png`);
      expect((await fetch(link.url)).status).toBe(200);

      const forced = await fetch(`${base}/api/assets/${id}?path=cover.png&force=1`, {
        method: 'DELETE',
      });
      expect(await forced.json()).toEqual({ removed: ['cover.png'] });
      expect((await (await fetch(`${base}/api/assets/nope`)).json()) as unknown).toMatchObject({
        error: expect.any(String),
      });
    });

    it('library: lists with search, imports into the document and removes', async () => {
      const png = fakePng(20, 10, 9);
      const a = (await (
        await fetch(`${base}/api/library?name=Logo%20Blue.png`, {
          method: 'POST',
          body: new Uint8Array(png),
        })
      ).json()) as { hash: string };
      const found = (await (await fetch(`${base}/api/library?query=blue`)).json()) as {
        assets: { hash: string; tags: string[]; addedAt: string }[];
      };
      expect(found.assets.map((x) => x.hash)).toEqual([a.hash]);
      expect(found.assets[0]!.tags).toEqual([]);
      expect(
        ((await (await fetch(`${base}/api/library?query=zzz`)).json()) as { assets: unknown[] })
          .assets,
      ).toEqual([]);

      const imp = await post(`/api/library/${a.hash}/import`, { docId: docId() });
      expect(await imp.json()).toEqual({ src: 'Logo-Blue.png' });
      const imp2 = await post(`/api/library/${a.hash}/import`, { docId: docId() });
      expect(await imp2.json()).toEqual({ src: 'Logo-Blue-1.png' });
      expect((await post(`/api/library/${'a'.repeat(32)}/import`, { docId: docId() })).status).toBe(
        404,
      );

      expect(
        await (await fetch(`${base}/api/library/${a.hash}`, { method: 'DELETE' })).json(),
      ).toEqual({ removed: true });
      expect((await fetch(`${base}/cdn/${a.hash}.png`)).status).toBe(404);
      expect((await fetch(`${base}/api/library/${a.hash}`, { method: 'DELETE' })).status).toBe(404);
      const bad = await fetch(`${base}/api/library?name=x.png`, { method: 'POST', body: 'text' });
      expect(bad.status).toBe(400);
    });

    it('/optimize converts and rewrites references', async () => {
      const sharp = (await import('sharp')).default;
      const noise = await sharp(crypto.randomBytes(600 * 300 * 3), {
        raw: { width: 600, height: 300, channels: 3 },
      })
        .png()
        .toBuffer();
      const id = docId();
      const srcFile = path.join(ws.dir, 'noise.png');
      fs.writeFileSync(srcFile, noise);
      await call('insert_image', { parentId: ws.frameId, source: srcFile });
      const r = await post(`/api/assets/${id}/optimize`, { maxWidth: 300 });
      const body = (await r.json()) as {
        results: { path: string; newPath: string; before: number; after: number }[];
        skipped: unknown[];
      };
      expect(r.status).toBe(200);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({ path: 'noise.png', newPath: 'noise.webp' });
      expect(body.results[0]!.after).toBeLessThan(body.results[0]!.before);
    });
  });

  describe('MCP tools', () => {
    it('upload_asset from data URL and from path; list_assets; get_asset_url', async () => {
      const png = fakePng(24, 12, 5);
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const r1 = await call('upload_asset', { source: dataUrl, name: 'card' });
      expect(r1.isError, textOf(r1)).toBeFalsy();
      const t1 = textOf(r1);
      expect(t1).toContain(sha32(png));
      expect(t1).toContain('src (use in img nodes/setSrc): card.png');
      expect(t1).toContain(`${base}/cdn/${sha32(png)}.png`);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'card.png'))).toBe(true);

      const file = path.join(ws.dir, 'Big Photo.png');
      const other = fakePng(50, 40, 6);
      fs.writeFileSync(file, other);
      const r2 = await call('upload_asset', { source: file });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      expect(textOf(r2)).toContain('Big-Photo.png');

      const libOnly = await call('upload_asset', { source: dataUrl, library: true });
      expect(textOf(libOnly)).toContain('library only');
      expect(fs.readdirSync(path.join(ws.dir, 'assets'))).toHaveLength(2);

      const bad = await call('upload_asset', {
        source: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}`,
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('recognized');

      const listed = textOf(await call('list_assets'));
      expect(listed).toContain('2 asset(s)');
      expect(listed).toContain(`card.png 24x12 png 1 KB uses:0 ${base}/cdn/${sha32(png)}.png`);
      expect(textOf(await call('list_assets', { query: 'PHOTO' }))).toContain('1 asset(s)');
      expect(textOf(await call('list_assets', { unused: true }))).toContain('2 asset(s)');
      expect(textOf(await call('list_assets', { scope: 'library' }))).toContain(`id:${sha32(png)}`);

      const byPath = textOf(await call('get_asset_url', { id: 'card.png' }));
      expect(byPath).toContain(`Direct link: ${base}/cdn/${sha32(png)}.png`);
      expect(byPath).toContain('src: card.png');
      expect(byPath).toContain(path.join(ws.dir, 'assets', 'card.png'));
      const byHash = textOf(await call('get_asset_url', { id: sha32(other) }));
      expect(byHash).toContain('src: Big-Photo.png');
      const byUrl = textOf(await call('get_asset_url', { id: `/cdn/${sha32(png)}.png` }));
      expect(byUrl).toContain('src: card.png');
      expect((await call('get_asset_url', { id: 'a'.repeat(32) })).isError).toBe(true);
      expect((await call('get_asset_url', { id: '../outside.png' })).isError).toBe(true);
    });

    it('code export copies images with a daemon /cdn link into assets/cdn/', async () => {
      const png = fakePng(20, 10, 3);
      const hash = sha32(png);
      const up = await call('upload_asset', {
        source: `data:image/png;base64,${png.toString('base64')}`,
        library: true,
      });
      expect(up.isError, textOf(up)).toBeFalsy();
      const link = `${base}/cdn/${hash}.png`;
      const w = await call('write_html', {
        parentId: ws.frameId,
        html: `<section><img src="${link}" alt="cover"><div style="width:20px;height:10px;background-image:url('${link}')"></div></section>`,
      });
      expect(w.isError, textOf(w)).toBeFalsy();
      const out = path.join(ws.dir, 'out');
      const r = await call('export', { nodeIds: [ws.frameId], format: 'html', outputDir: out });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).toContain(`cdn/${hash}.png`);
      const copied = path.join(out, 'assets', 'cdn', `${hash}.png`);
      expect(fs.readFileSync(copied).equals(png)).toBe(true);
      const html = fs.readFileSync(path.join(out, 'desktop.html'), 'utf8');
      expect(html).toContain(`src="assets/cdn/${hash}.png"`);
      expect(html).toContain(`assets/cdn/${hash}.png`);
      expect(html).not.toContain(`${base}/cdn/`);
      // the document keeps the direct link
      expect(frame().children[0]!.children[0]!.src).toBe(link);
    });

    it('optimize_assets converts a large PNG into a smaller WebP, rewrites the src and undo restores it', async () => {
      const sharp = (await import('sharp')).default;
      const noise = await sharp(crypto.randomBytes(800 * 400 * 3), {
        raw: { width: 800, height: 400, channels: 3 },
      })
        .png()
        .toBuffer();
      const file = path.join(ws.dir, 'noise.png');
      fs.writeFileSync(file, noise);
      await call('insert_image', { parentId: ws.frameId, source: file });
      expect(frame().children[0]!.src).toBe('noise.png');
      const rev0 = daemon.store.getRevision(docId());

      const r = await call('optimize_assets', { maxWidth: 400 });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).toContain('noise.png -> noise.webp');
      expect(frame().children[0]!.src).toBe('noise.webp');
      const out = path.join(ws.dir, 'assets', 'noise.webp');
      expect(fs.statSync(out).size).toBeLessThan(noise.length);
      expect((await sharp(fs.readFileSync(out)).metadata()).width).toBe(400);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'noise.png'))).toBe(true);
      expect(daemon.store.getRevision(docId())).toBe(rev0 + 1);

      await call('undo');
      expect(frame().children[0]!.src).toBe('noise.png');

      // original unused: remove_unused_assets (dryRun first)
      await call('redo');
      const dry = textOf(await call('remove_unused_assets', { dryRun: true }));
      expect(dry).toContain('Would remove 1 file(s)');
      expect(dry).toContain('noise.png');
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'noise.png'))).toBe(true);
      const real = textOf(await call('remove_unused_assets'));
      expect(real).toContain('Removed 1 file(s)');
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'noise.png'))).toBe(false);
      expect(fs.existsSync(out)).toBe(true);
      expect(textOf(await call('remove_unused_assets'))).toContain('No unused assets');
    });

    it('optimize_assets re-reads the document before rewriting (does not undo edits made during processing)', async () => {
      const sharp = (await import('sharp')).default;
      const noise = await sharp(crypto.randomBytes(300 * 200 * 3), {
        raw: { width: 300, height: 200, channels: 3 },
      })
        .png()
        .toBuffer();
      fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ws.dir, 'assets', 'photo.png'), noise);
      const w = await call('write_html', {
        parentId: ws.frameId,
        html: '<div class="list"><article><img src="{{photo}}"><h3>{{name}}</h3></article></div>',
      });
      expect(w.isError, textOf(w)).toBeFalsy();
      const b = await call('bind_data', {
        nodeId: frame().children[0]!.id,
        data: [{ photo: 'photo.png', name: 'A' }],
      });
      expect(b.isError, textOf(b)).toBeFalsy();
      const repId = frame().children[0]!.id;

      // Simulates a concurrent edit: right after the service's first read of the document,
      // another client adds an item to the data.
      const real = daemon.store;
      let edited = false;
      const racing = new Proxy(real, {
        get(t, k) {
          if (k === 'get') {
            return (id: string) => {
              const d = t.get(id);
              if (!edited) {
                edited = true;
                t.applyOps(
                  id,
                  [
                    {
                      type: 'setData',
                      changes: [
                        {
                          nodeId: repId,
                          data: [
                            { photo: 'photo.png', name: 'A' },
                            { photo: 'photo.png', name: 'B' },
                          ],
                        },
                      ],
                    },
                  ],
                  { source: 'editor' },
                );
              }
              return d;
            };
          }
          const v = Reflect.get(t, k, t) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as DocumentStore;
      const r = await optimizeDocAssets(
        { store: racing, dataDir: ws.dataDir },
        docId(),
        { format: 'webp' },
        (ops) => real.applyOps(docId(), ops, { source: 'mcp', label: 'optimize_assets' }),
      );
      expect(edited).toBe(true);
      expect(r.results.map((x) => x.newPath)).toEqual(['photo.webp']);
      expect(r.rewritten).toBe(1);
      expect(frame().children[0]!.data).toEqual([
        { photo: 'photo.webp', name: 'A' },
        { photo: 'photo.webp', name: 'B' },
      ]);
    });

    it('optimize_assets keeps images that do not get smaller and ignores SVG', async () => {
      const png = fakePng(8, 8);
      fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ws.dir, 'assets', 'mini.png'), png);
      fs.writeFileSync(
        path.join(ws.dir, 'assets', 'v.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>',
      );
      const r = await call('optimize_assets', { paths: ['mini.png', 'v.svg'], format: 'keep' });
      expect(r.isError, textOf(r)).toBeFalsy();
      const t = textOf(r);
      expect(t).toContain('No image was replaced');
      expect(t).toContain('mini.png: kept');
      expect(t).toContain('v.svg: SVG is vector');
    });
  });
});
