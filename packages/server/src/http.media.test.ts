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

describe('video and animation upload', () => {
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

  it('constants and maxBytesFor by extension', () => {
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

  it('sanitizeAssetName accepts video and animation and normalizes the extension', () => {
    expect(sanitizeAssetName('My Clip.MP4')).toEqual({ base: 'My-Clip', ext: '.mp4' });
    expect(sanitizeAssetName('a.riv')).toEqual({ base: 'a', ext: '.riv' });
    expect(sanitizeAssetName('a.lottie')).toEqual({ base: 'a', ext: '.lottie' });
    expect(() => sanitizeAssetName('a.mkv')).toThrow();
  });

  const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const LOTTIE = Buffer.from('{"v":"5","fr":30,"layers":[]}');
  const RIVE = Buffer.from('RIVE-bytes');
  const padded = (head: Buffer, size: number): Buffer =>
    Buffer.concat([head, Buffer.alloc(size - head.length, 1)]);

  it('writes .mp4, .json and .riv into the assets/ subfolders and serves via GET', async () => {
    for (const [name, body, src] of [
      ['clip.mp4', MP4, 'videos/clip.mp4'],
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
    expect(await (await post('clip.mp4', MP4)).json()).toEqual({ src: 'videos/clip-1.mp4' });
  });

  it('checks the bytes: .riv without RIVE, a non-Lottie .json and a fake video are rejected', async () => {
    expect((await post('x.riv', Buffer.from('nothing'))).status).toBe(415);
    expect((await post('x.json', Buffer.from('{"a":1}'))).status).toBe(415);
    expect((await post('y.json', Buffer.from('not json'))).status).toBe(415);
    expect((await post('x.mp4', Buffer.from('any text here'))).status).toBe(415);
    for (const sub of ['videos', 'lottie', 'rive'])
      expect(fs.existsSync(path.join(ws.dir, 'assets', sub))).toBe(false);
  });

  it('the video goes to videos/ with the extension detected from the bytes', async () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    const r = await post('clip.mp4', webm);
    expect(await r.json()).toEqual({ src: 'videos/clip.webm' });
  });

  it('rejects an extension outside the list and an empty body', async () => {
    expect((await post('a.mkv', Buffer.from('x'))).status).toBe(400);
    expect((await post('a.exe', Buffer.from('x'))).status).toBe(400);
    expect((await post('a.mp4', Buffer.alloc(0))).status).toBe(400);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'a.mkv'))).toBe(false);
  });

  it('limit by extension: 21 MB passes for .mp4 and .riv, but not for .png', async () => {
    const body = Buffer.alloc(21 * 1024 * 1024, 1);
    expect((await post('big.png', body)).status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'big.png'))).toBe(false);
    expect((await post('big.mp4', padded(MP4, body.length))).status).toBe(200);
    expect((await post('big.riv', padded(Buffer.from('RIVE'), body.length))).status).toBe(200);
    expect(fs.statSync(path.join(ws.dir, 'assets', 'videos', 'big.mp4')).size).toBe(body.length);
  });

  it('an image above 20 MB is rejected with 413 also with a chunked body (no content-length)', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 22) c.enqueue(new Uint8Array(chunk));
        else c.close();
      },
    });
    const res = await fetch(`${daemon.url}/api/assets/${id}?name=big.png`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'big.png'))).toBe(false);
  });

  it('an animation above 50 MB is rejected with 413, a video of the same size passes', async () => {
    const body = Buffer.alloc(51 * 1024 * 1024, 2);
    const r = await post('huge.json', body);
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'lottie', 'huge.json'))).toBe(false);
    const webm = padded(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), body.length);
    expect((await post('huge.webm', webm)).status).toBe(200);
  });

  it('a missing document gives 404', async () => {
    expect((await post('a.mp4', Buffer.from('x'), 'doc_missing')).status).toBe(404);
  });
});

describe('POST /api/assets/:docId/fetch (Lottie/Rive by URL)', () => {
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
      else if (req.url === '/a/fake.json') res.end('{"nothing":1}');
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

  it('downloads Lottie and Rive into assets/lottie and assets/rive and returns the relative src', async () => {
    const a = await fetchAsset({ url: `${base}/a/loader.json`, kind: 'lottie' });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ src: 'lottie/loader.json' });
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'lottie', 'loader.json'))).toBe(true);
    const b = await fetchAsset({ url: `${base}/a/x.riv`, kind: 'rive' });
    expect(await b.json()).toEqual({ src: 'rive/x.riv' });
  });

  it('rejects content of the wrong type, network failure, invalid input and a missing doc', async () => {
    expect((await fetchAsset({ url: `${base}/a/fake.json`, kind: 'lottie' })).status).toBe(502);
    expect((await fetchAsset({ url: `${base}/a/x.riv`, kind: 'lottie' })).status).toBe(502);
    expect((await fetchAsset({ url: `${base}/nothing.json`, kind: 'lottie' })).status).toBe(502);
    expect((await fetchAsset({ url: 'ftp://x/y.json', kind: 'lottie' })).status).toBe(400);
    expect((await fetchAsset({ url: `${base}/a/x.riv`, kind: 'video' })).status).toBe(400);
    expect(
      (await fetchAsset({ url: `${base}/a/x.riv`, kind: 'rive' }, 'does_not_exist')).status,
    ).toBe(404);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'lottie'))).toBe(false);
  });
});
