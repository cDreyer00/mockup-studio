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

describe('assets, CDN e biblioteca (HTTP + MCP)', () => {
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
    client = new Client({ name: 'teste', version: '0.0.0' });
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

  describe('rotas HTTP', () => {
    it('/cdn/<hash>.png serve com os headers do contrato; 404 e nomes inválidos', async () => {
      const png = fakePng(30, 20);
      const hash = sha32(png);
      const lib = await fetch(`${base}/api/library?name=capa.png`, {
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

    it('svg sai como attachment', async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>');
      const a = (await (
        await fetch(`${base}/api/library?name=i.svg`, { method: 'POST', body: new Uint8Array(svg) })
      ).json()) as { hash: string };
      const r = await fetch(`${base}/cdn/${a.hash}.svg`);
      expect(r.headers.get('content-type')).toBe('image/svg+xml');
      expect(r.headers.get('content-disposition')).toBe('attachment');
    });

    it('listar não registra no CDN; o link registra', async () => {
      const png = fakePng(12, 10, 9);
      const hash = sha32(png);
      fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ws.dir, 'assets', 'solto.png'), png);
      const list = (await (await fetch(`${base}/api/assets/${docId()}`)).json()) as {
        assets: { path: string; hash: string; cdnUrl: string }[];
      };
      const a = list.assets.find((x) => x.path === 'solto.png')!;
      expect(a.hash).toBe(hash);
      expect(a.cdnUrl).toBe('');
      expect((await fetch(`${base}/cdn/${hash}.png`)).status).toBe(404);

      const link = await post(`/api/assets/${docId()}/link`, { path: 'solto.png' });
      expect(link.status).toBe(200);
      expect((await fetch(`${base}/cdn/${hash}.png`)).status).toBe(200);
      const again = (await (await fetch(`${base}/api/assets/${docId()}`)).json()) as typeof list;
      expect(again.assets.find((x) => x.path === 'solto.png')!.cdnUrl).toBe(
        `${base}/cdn/${hash}.png`,
      );
    });

    it('o mesmo conteúdo dá o mesmo link entre documentos', async () => {
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

    it('GET /api/assets/:docId lista recursivo com usos; DELETE 409 em uso; remove-unused; link', async () => {
      const id = docId();
      const used = fakePng(40, 30, 1);
      const spare = fakePng(10, 10, 2);
      await upload(id, 'usada.png', used);
      await upload(id, 'sobra.png', spare);
      const sub = path.join(ws.dir, 'assets', 'fotos');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'capa.png'), fakePng(12, 12, 3));
      fs.writeFileSync(path.join(ws.dir, 'assets', '.oculto.png'), fakePng(5, 5));
      fs.writeFileSync(path.join(ws.dir, 'assets', 'x.png.tmp'), 'x');
      await call('insert_image', { parentId: ws.frameId, source: path.join(sub, 'capa.png') });
      await call('insert_image', { parentId: ws.frameId, source: path.join(sub, 'capa.png') });
      const imgSrc = frame().children[0]!.src!;
      expect(imgSrc).toBe('capa.png');

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
        'capa-1.png',
        'capa.png',
        'fotos/capa.png',
        'sobra.png',
        'usada.png',
      ]);
      expect(byPath['capa.png']).toMatchObject({
        uses: 1,
        kind: 'image',
        width: 12,
        mime: 'image/png',
        ext: '.png',
        name: 'capa.png',
        refKinds: ['src'],
      });
      expect(byPath['sobra.png']!.uses).toBe(0);
      expect(byPath['capa.png']!.nodeIds).toHaveLength(1);

      // em uso: 409; com force remove
      const conflict = await fetch(`${base}/api/assets/${id}?path=capa.png`, { method: 'DELETE' });
      expect(conflict.status).toBe(409);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'capa.png'))).toBe(true);
      expect(
        (await fetch(`${base}/api/assets/${id}?path=..%2Fteste.mockup.json`, { method: 'DELETE' }))
          .status,
      ).toBe(400);
      expect(
        (await fetch(`${base}/api/assets/${id}?path=nao.png`, { method: 'DELETE' })).status,
      ).toBe(404);

      // remove-unused: dryRun não apaga
      const dry = (await (
        await post(`/api/assets/${id}/remove-unused`, { dryRun: true })
      ).json()) as { removed: string[]; kept: number };
      expect(dry.removed.sort()).toEqual(['fotos/capa.png', 'sobra.png', 'usada.png']);
      expect(dry.kept).toBe(2);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'sobra.png'))).toBe(true);
      const real = (await (await post(`/api/assets/${id}/remove-unused`, {})).json()) as {
        removed: string[];
      };
      expect(real.removed).toHaveLength(3);
      expect(
        fs
          .readdirSync(path.join(ws.dir, 'assets'))
          .filter((f) => !f.startsWith('.') && !f.endsWith('.tmp')),
      ).toEqual(['capa-1.png', 'capa.png', 'fotos']);

      // link
      const link = (await (await post(`/api/assets/${id}/link`, { path: 'capa.png' })).json()) as {
        hash: string;
        url: string;
        cdnPath: string;
      };
      expect(link.url).toBe(`${base}/cdn/${link.hash}.png`);
      expect(link.cdnPath).toBe(`/cdn/${link.hash}.png`);
      expect((await fetch(link.url)).status).toBe(200);

      const forced = await fetch(`${base}/api/assets/${id}?path=capa.png&force=1`, {
        method: 'DELETE',
      });
      expect(await forced.json()).toEqual({ removed: ['capa.png'] });
      expect((await (await fetch(`${base}/api/assets/nope`)).json()) as unknown).toMatchObject({
        error: expect.any(String),
      });
    });

    it('biblioteca: lista com busca, importa para o documento e remove', async () => {
      const png = fakePng(20, 10, 9);
      const a = (await (
        await fetch(`${base}/api/library?name=Logo%20Azul.png`, {
          method: 'POST',
          body: new Uint8Array(png),
        })
      ).json()) as { hash: string };
      const found = (await (await fetch(`${base}/api/library?query=azul`)).json()) as {
        assets: { hash: string; tags: string[]; addedAt: string }[];
      };
      expect(found.assets.map((x) => x.hash)).toEqual([a.hash]);
      expect(found.assets[0]!.tags).toEqual([]);
      expect(
        ((await (await fetch(`${base}/api/library?query=zzz`)).json()) as { assets: unknown[] })
          .assets,
      ).toEqual([]);

      const imp = await post(`/api/library/${a.hash}/import`, { docId: docId() });
      expect(await imp.json()).toEqual({ src: 'Logo-Azul.png' });
      const imp2 = await post(`/api/library/${a.hash}/import`, { docId: docId() });
      expect(await imp2.json()).toEqual({ src: 'Logo-Azul-1.png' });
      expect((await post(`/api/library/${'a'.repeat(32)}/import`, { docId: docId() })).status).toBe(
        404,
      );

      expect(
        await (await fetch(`${base}/api/library/${a.hash}`, { method: 'DELETE' })).json(),
      ).toEqual({ removed: true });
      expect((await fetch(`${base}/cdn/${a.hash}.png`)).status).toBe(404);
      expect((await fetch(`${base}/api/library/${a.hash}`, { method: 'DELETE' })).status).toBe(404);
      const bad = await fetch(`${base}/api/library?name=x.png`, { method: 'POST', body: 'texto' });
      expect(bad.status).toBe(400);
    });

    it('/optimize converte e reescreve referências', async () => {
      const sharp = (await import('sharp')).default;
      const noise = await sharp(crypto.randomBytes(600 * 300 * 3), {
        raw: { width: 600, height: 300, channels: 3 },
      })
        .png()
        .toBuffer();
      const id = docId();
      const origem = path.join(ws.dir, 'ruido.png');
      fs.writeFileSync(origem, noise);
      await call('insert_image', { parentId: ws.frameId, source: origem });
      const r = await post(`/api/assets/${id}/optimize`, { maxWidth: 300 });
      const body = (await r.json()) as {
        results: { path: string; newPath: string; before: number; after: number }[];
        skipped: unknown[];
      };
      expect(r.status).toBe(200);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({ path: 'ruido.png', newPath: 'ruido.webp' });
      expect(body.results[0]!.after).toBeLessThan(body.results[0]!.before);
    });
  });

  describe('ferramentas MCP', () => {
    it('upload_asset de data URL e de caminho; list_assets; get_asset_url', async () => {
      const png = fakePng(24, 12, 5);
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const r1 = await call('upload_asset', { source: dataUrl, name: 'cartao' });
      expect(r1.isError, textOf(r1)).toBeFalsy();
      const t1 = textOf(r1);
      expect(t1).toContain(sha32(png));
      expect(t1).toContain('src (use em nós img/setSrc): cartao.png');
      expect(t1).toContain(`${base}/cdn/${sha32(png)}.png`);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'cartao.png'))).toBe(true);

      const file = path.join(ws.dir, 'Foto Grande.png');
      const other = fakePng(50, 40, 6);
      fs.writeFileSync(file, other);
      const r2 = await call('upload_asset', { source: file });
      expect(r2.isError, textOf(r2)).toBeFalsy();
      expect(textOf(r2)).toContain('Foto-Grande.png');

      const libOnly = await call('upload_asset', { source: dataUrl, library: true });
      expect(textOf(libOnly)).toContain('só na biblioteca');
      expect(fs.readdirSync(path.join(ws.dir, 'assets'))).toHaveLength(2);

      const bad = await call('upload_asset', {
        source: `data:text/plain;base64,${Buffer.from('oi').toString('base64')}`,
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain('reconhecida');

      const listed = textOf(await call('list_assets'));
      expect(listed).toContain('2 asset(s)');
      expect(listed).toContain(`cartao.png 24x12 png 1 KB usos:0 ${base}/cdn/${sha32(png)}.png`);
      expect(textOf(await call('list_assets', { query: 'FOTO' }))).toContain('1 asset(s)');
      expect(textOf(await call('list_assets', { unused: true }))).toContain('2 asset(s)');
      expect(textOf(await call('list_assets', { scope: 'library' }))).toContain(`id:${sha32(png)}`);

      const byPath = textOf(await call('get_asset_url', { id: 'cartao.png' }));
      expect(byPath).toContain(`Link direto: ${base}/cdn/${sha32(png)}.png`);
      expect(byPath).toContain('src: cartao.png');
      expect(byPath).toContain(path.join(ws.dir, 'assets', 'cartao.png'));
      const byHash = textOf(await call('get_asset_url', { id: sha32(other) }));
      expect(byHash).toContain('src: Foto-Grande.png');
      const byUrl = textOf(await call('get_asset_url', { id: `/cdn/${sha32(png)}.png` }));
      expect(byUrl).toContain('src: cartao.png');
      expect((await call('get_asset_url', { id: 'a'.repeat(32) })).isError).toBe(true);
      expect((await call('get_asset_url', { id: '../fora.png' })).isError).toBe(true);
    });

    it('optimize_assets converte PNG grande em WebP menor, reescreve o src e o undo restaura', async () => {
      const sharp = (await import('sharp')).default;
      const noise = await sharp(crypto.randomBytes(800 * 400 * 3), {
        raw: { width: 800, height: 400, channels: 3 },
      })
        .png()
        .toBuffer();
      const file = path.join(ws.dir, 'ruido.png');
      fs.writeFileSync(file, noise);
      await call('insert_image', { parentId: ws.frameId, source: file });
      expect(frame().children[0]!.src).toBe('ruido.png');
      const rev0 = daemon.store.getRevision(docId());

      const r = await call('optimize_assets', { maxWidth: 400 });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).toContain('ruido.png -> ruido.webp');
      expect(frame().children[0]!.src).toBe('ruido.webp');
      const out = path.join(ws.dir, 'assets', 'ruido.webp');
      expect(fs.statSync(out).size).toBeLessThan(noise.length);
      expect((await sharp(fs.readFileSync(out)).metadata()).width).toBe(400);
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'ruido.png'))).toBe(true);
      expect(daemon.store.getRevision(docId())).toBe(rev0 + 1);

      await call('undo');
      expect(frame().children[0]!.src).toBe('ruido.png');

      // sem uso do original: remove_unused_assets (dryRun primeiro)
      await call('redo');
      const dry = textOf(await call('remove_unused_assets', { dryRun: true }));
      expect(dry).toContain('Seriam removidos 1 arquivo(s)');
      expect(dry).toContain('ruido.png');
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'ruido.png'))).toBe(true);
      const real = textOf(await call('remove_unused_assets'));
      expect(real).toContain('Removidos 1 arquivo(s)');
      expect(fs.existsSync(path.join(ws.dir, 'assets', 'ruido.png'))).toBe(false);
      expect(fs.existsSync(out)).toBe(true);
      expect(textOf(await call('remove_unused_assets'))).toContain('Nenhum asset sem uso');
    });

    it('optimize_assets relê o documento antes de reescrever (não desfaz edições feitas durante o processamento)', async () => {
      const sharp = (await import('sharp')).default;
      const noise = await sharp(crypto.randomBytes(300 * 200 * 3), {
        raw: { width: 300, height: 200, channels: 3 },
      })
        .png()
        .toBuffer();
      fs.mkdirSync(path.join(ws.dir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ws.dir, 'assets', 'foto.png'), noise);
      const w = await call('write_html', {
        parentId: ws.frameId,
        html: '<div class="lista"><article><img src="{{foto}}"><h3>{{nome}}</h3></article></div>',
      });
      expect(w.isError, textOf(w)).toBeFalsy();
      const b = await call('bind_data', {
        nodeId: frame().children[0]!.id,
        data: [{ foto: 'foto.png', nome: 'A' }],
      });
      expect(b.isError, textOf(b)).toBeFalsy();
      const repId = frame().children[0]!.id;

      // Simula uma edição concorrente: logo depois da primeira leitura do documento pelo serviço,
      // outro cliente acrescenta um item aos dados.
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
                            { foto: 'foto.png', nome: 'A' },
                            { foto: 'foto.png', nome: 'B' },
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
      expect(r.results.map((x) => x.newPath)).toEqual(['foto.webp']);
      expect(r.rewritten).toBe(1);
      expect(frame().children[0]!.data).toEqual([
        { foto: 'foto.webp', nome: 'A' },
        { foto: 'foto.webp', nome: 'B' },
      ]);
    });

    it('optimize_assets mantém imagens que não ficam menores e ignora SVG', async () => {
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
      expect(t).toContain('Nenhuma imagem foi substituída');
      expect(t).toContain('mini.png: mantido');
      expect(t).toContain('v.svg: SVG é vetorial');
    });
  });
});
