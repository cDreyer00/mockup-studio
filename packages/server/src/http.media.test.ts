import fs from 'node:fs';
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

  it('grava .mp4, .json e .riv em assets/ e serve por GET', async () => {
    const mp4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const json = Buffer.from('{"v":"5","fr":30,"layers":[]}');
    const riv = Buffer.from('RIVE-bytes');
    for (const [name, body] of [
      ['clipe.mp4', mp4],
      ['anim.json', json],
      ['hero.riv', riv],
    ] as const) {
      const r = await post(name, body);
      expect(r.status, name).toBe(200);
      expect(await r.json()).toEqual({ src: name });
      expect(fs.readFileSync(path.join(ws.dir, 'assets', name))).toEqual(body);
      const got = await fetch(`${daemon.url}/assets/${id}/${name}`);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer())).toEqual(body);
    }
    expect(await (await post('clipe.mp4', mp4)).json()).toEqual({ src: 'clipe-1.mp4' });
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
    expect((await post('grande.mp4', body)).status).toBe(200);
    expect((await post('grande.riv', body)).status).toBe(200);
    expect(fs.statSync(path.join(ws.dir, 'assets', 'grande.mp4')).size).toBe(body.length);
  });

  it('animação acima de 50 MB é recusada com 413, vídeo do mesmo tamanho passa', async () => {
    const body = Buffer.alloc(51 * 1024 * 1024, 2);
    const r = await post('enorme.json', body);
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(ws.dir, 'assets', 'enorme.json'))).toBe(false);
    expect((await post('enorme.webm', body)).status).toBe(200);
  });

  it('documento inexistente dá 404', async () => {
    expect((await post('a.mp4', Buffer.from('x'), 'doc_inexistente')).status).toBe(404);
  });
});
