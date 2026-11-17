import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from './index.js';
import {
  ANIMATION_EXTS,
  MAX_ANIMATION_BYTES,
  MAX_ASSET_BYTES,
  MAX_VIDEO_BYTES,
  VIDEO_EXTS,
  maxBytesFor,
  sanitizeAssetName,
} from './http.js';
import { makeWorkspace } from './test-utils.js';

describe('upload de vídeo e animação', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let id: string;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
    });
    id = daemon.store.list()[0]!.docId;
  });
  afterEach(async () => {
    await daemon.close();
    ws.cleanup();
  });

  const post = (name: string, body: Buffer, docId = id) =>
    fetch(`${daemon.url}/api/assets/${docId}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(body),
    });

  it('constantes e maxBytesFor por extensão', () => {
    expect([...VIDEO_EXTS].sort()).toEqual(['.m4v', '.mov', '.mp4', '.ogv', '.webm']);
    expect([...ANIMATION_EXTS].sort()).toEqual(['.json', '.lottie', '.riv']);
    for (const e of VIDEO_EXTS) expect(maxBytesFor(e)).toBe(MAX_VIDEO_BYTES);
    for (const e of ANIMATION_EXTS) expect(maxBytesFor(e)).toBe(MAX_ANIMATION_BYTES);
    for (const e of ['.png', '.jpg', '.svg', '.avif', ''])
      expect(maxBytesFor(e)).toBe(MAX_ASSET_BYTES);
    expect(MAX_VIDEO_BYTES).toBe(500 * 1024 * 1024);
    expect(MAX_ANIMATION_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_ASSET_BYTES).toBe(20 * 1024 * 1024);
  });

  it('sanitizeAssetName aceita vídeo e animação e normaliza a extensão', () => {
    expect(sanitizeAssetName('Meu Clipe.MP4')).toEqual({ base: 'Meu-Clipe', ext: '.mp4' });
    expect(sanitizeAssetName('a.riv')).toEqual({ base: 'a', ext: '.riv' });
    expect(sanitizeAssetName('a.lottie')).toEqual({ base: 'a', ext: '.lottie' });
    expect(() => sanitizeAssetName('a.mkv')).toThrow();
  });

  const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const LOTTIE = Buffer.from('{"v":"5","fr":30,"layers":[]}');
  const RIVE = Buffer.from('RIVE-bytes');
  const padded = (head: Buffer, size: number): Buffer =>
    Buffer.concat([head, Buffer.alloc(size - head.length, 1)]);

  it('grava .mp4, .json e .riv nas subpastas de assets/ e serve por GET', async () => {
    for (const [name, body, src] of [
      ['clipe.mp4', MP4, 'videos/clipe.mp4'],
      ['anim.json', LOTTIE, 'lottie/anim.json'],
      ['hero.riv', RIVE, 'rive/hero.riv'],
    ] as const) {
      const r = await post(name, body);
      expect(r.status, name).toBe(200);
      expect(await r.json()).toEqual({ src });
      expect(fs.readFileSync(path.join(ws.dir, 'assets', src))).toEqual(body);
      const got = await fetch(`${daemon.url}/assets/${id}/${src}`);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer())).toEqual(body);
    }
    expect(await (await post('clipe.mp4', MP4)).json()).toEqual({ src: 'videos/clipe-1.mp4' });
  });

  it('confere os bytes: .riv sem RIVE, .json que não é Lottie e vídeo falso são recusados', async () => {
    expect((await post('x.riv', Buffer.from('nada'))).status).toBe(415);
    expect((await post('x.json', Buffer.from('{"a":1}'))).status).toBe(415);
    expect((await post('y.json', Buffer.from('não é json'))).status).toBe(415);
    expect((await post('x.mp4', Buffer.from('texto qualquer aqui'))).status).toBe(415);
    for (const sub of ['videos', 'lottie', 'rive'])
      expect(fs.existsSync(path.join(ws.dir, 'assets', sub))).toBe(false);
  });

  it('o vídeo vai para videos/ com a extensão detectada nos bytes', async () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    const r = await post('clipe.mp4', webm);
    expect(await r.json()).toEqual({ src: 'videos/clipe.webm' });
  });

  it('recusa extensão fora da lista e corpo vazio', async () => {
    expect((await post('a.mkv', Buffer.from('x'))).status).toBe(400);
    expect((await post('a.exe', Buffer.from('x'))).status).toBe(400);
    expect((await post('a.mp4', Buffer.alloc(0))).status).toBe(400);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'a.mkv'))).toBe(false);
  });

  it('limite por extensão: 21 MB passa em .mp4 e .riv, mas não em .png', async () => {
    const body = Buffer.alloc(21 * 1024 * 1024, 1);
    expect((await post('grande.png', body)).status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'grande.png'))).toBe(false);
    expect((await post('grande.mp4', padded(MP4, body.length))).status).toBe(200);
    expect((await post('grande.riv', padded(Buffer.from('RIVE'), body.length))).status).toBe(200);
    expect(fs.statSync(path.join(ws.dir, 'assets', 'videos', 'grande.mp4')).size).toBe(body.length);
  });

  it('imagem acima de 20 MB é recusada com 413 também com corpo em chunks (sem content-length)', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 22) c.enqueue(new Uint8Array(chunk));
        else c.close();
      },
    });
    const res = await fetch(`${daemon.url}/api/assets/${id}?name=grande.png`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'grande.png'))).toBe(false);
  });

  it('animação acima de 50 MB é recusada com 413, vídeo do mesmo tamanho passa', async () => {
    const body = Buffer.alloc(51 * 1024 * 1024, 2);
    const r = await post('enorme.json', body);
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'lottie', 'enorme.json'))).toBe(false);
    const webm = padded(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), body.length);
    expect((await post('enorme.webm', webm)).status).toBe(200);
  });

  it('documento inexistente dá 404', async () => {
    expect((await post('a.mp4', Buffer.from('x'), 'doc_inexistente')).status).toBe(404);
  });
});

describe('POST /api/assets/:docId/fetch (Lottie/Rive por URL)', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let daemon: DaemonHandle;
  let origin: http.Server;
  let base: string;
  let id: string;

  beforeEach(async () => {
    ws = makeWorkspace();
    daemon = await startDaemon({
      port: 0,
      dataDir: ws.dataDir,
      writeInfo: false,
      openFiles: [ws.file],
    });
    id = daemon.store.list()[0]!.docId;
    origin = http.createServer((req, res) => {
      if (req.url === '/a/loader.json') res.end('{"v":"5","fr":30,"layers":[]}');
      else if (req.url === '/a/x.riv') res.end(Buffer.from('RIVE-bytes'));
      else if (req.url === '/a/falso.json') res.end('{"nada":1}');
      else {
        res.statusCode = 404;
        res.end('no');
      }
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    origin.close();
    await daemon.close();
    ws.cleanup();
  });

  const fetchAsset = (body: unknown, docId = id) =>
    fetch(`${daemon.url}/api/assets/${docId}/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('baixa Lottie e Rive para assets/lottie e assets/rive e devolve o src relativo', async () => {
    const a = await fetchAsset({ url: `${base}/a/loader.json`, kind: 'lottie' });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ src: 'lottie/loader.json' });
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'lottie', 'loader.json'))).toBe(true);
    const b = await fetchAsset({ url: `${base}/a/x.riv`, kind: 'rive' });
    expect(await b.json()).toEqual({ src: 'rive/x.riv' });
  });

  it('recusa conteúdo que não é do tipo, falha de rede, entrada inválida e doc inexistente', async () => {
    expect((await fetchAsset({ url: `${base}/a/falso.json`, kind: 'lottie' })).status).toBe(502);
    expect((await fetchAsset({ url: `${base}/a/x.riv`, kind: 'lottie' })).status).toBe(502);
    expect((await fetchAsset({ url: `${base}/nada.json`, kind: 'lottie' })).status).toBe(502);
    expect((await fetchAsset({ url: 'ftp://x/y.json', kind: 'lottie' })).status).toBe(400);
    expect((await fetchAsset({ url: `${base}/a/x.riv`, kind: 'video' })).status).toBe(400);
    expect((await fetchAsset({ url: `${base}/a/x.riv`, kind: 'rive' }, 'nao_existe')).status).toBe(
      404,
    );
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'lottie'))).toBe(false);
  });
});
