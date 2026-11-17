import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CDN_FILE_RE, Library, detectAsset, getLibrary, hashBytes, safeStem } from './library.js';

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

describe('Library (CDN local)', () => {
  let dir: string;
  let lib: Library;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-lib-'));
    lib = new Library(path.join(dir, 'cdn'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('hash estável de 32 hex e entrada idempotente por conteúdo', () => {
    const bytes = fakePng(30, 20);
    const a = lib.add(bytes, { name: 'Capa.png' });
    const b = lib.add(Buffer.from(bytes), { name: 'outro-nome.png' });
    expect(a.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(a.hash).toBe(hashBytes(bytes));
    expect(b.hash).toBe(a.hash);
    expect(b.name).toBe('Capa.png');
    expect(a).toMatchObject({
      ext: 'png',
      mime: 'image/png',
      width: 30,
      height: 20,
      size: bytes.length,
    });
    expect(a.url).toBe(`/cdn/${a.hash}.png`);
    expect(CDN_FILE_RE.test(`${a.hash}.png`)).toBe(true);
    expect(lib.list()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'cdn', `${a.hash}.png`))).toBe(true);
  });

  it('persiste o índice (atômico) e recarrega em outra instância', () => {
    const a = lib.add(fakePng(8, 8), { name: 'a.png', tags: ['logo'] });
    expect(fs.readdirSync(path.join(dir, 'cdn')).some((f) => f.endsWith('.tmp'))).toBe(false);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'cdn', 'index.json'), 'utf8'));
    expect(index.assets[a.hash]).toMatchObject({
      name: 'a.png',
      mime: 'image/png',
      tags: ['logo'],
    });
    const again = new Library(path.join(dir, 'cdn'));
    expect(again.get(a.hash)).toMatchObject({ name: 'a.png', tags: ['logo'] });
  });

  it('busca por nome e tag sem acento nem caixa; remove', () => {
    const a = lib.add(fakePng(8, 8), { name: 'Logotipo-Água.png', tags: ['Marca'] });
    const b = lib.add(fakePng(9, 9), { name: 'foto.png' });
    expect(lib.list('agua').map((x) => x.hash)).toEqual([a.hash]);
    expect(lib.list('MARCA').map((x) => x.hash)).toEqual([a.hash]);
    expect(lib.list('foto').map((x) => x.hash)).toEqual([b.hash]);
    expect(lib.list('inexistente')).toEqual([]);
    expect(lib.remove(a.hash)).toBe(true);
    expect(lib.remove(a.hash)).toBe(false);
    expect(lib.list().map((x) => x.hash)).toEqual([b.hash]);
    expect(lib.fileFor(`${a.hash}.png`)).toBeNull();
  });

  it('importa para assets/ sem sobrescrever', async () => {
    const a = lib.add(fakePng(8, 8), { name: 'Minha Foto.png' });
    const assets = path.join(dir, 'assets');
    expect(await lib.importTo(a.hash, assets)).toBe('Minha-Foto.png');
    expect(await lib.importTo(a.hash, assets)).toBe('Minha-Foto-1.png');
    expect(fs.readdirSync(assets).sort()).toEqual(['Minha-Foto-1.png', 'Minha-Foto.png']);
  });

  it('rejeita conteúdo que não é imagem nem fonte; reconhece fontes pela assinatura', () => {
    expect(() => lib.add(Buffer.from('texto qualquer sem formato'))).toThrow(/reconhecida/);
    const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 1)]);
    expect(detectAsset(woff2)).toMatchObject({ ext: '.woff2', kind: 'font' });
    expect(lib.add(woff2, { name: 'f.woff2' }).mime).toBe('font/woff2');
  });

  it('getLibrary é singleton por pasta e usa uma pasta temporária sem dataDir', () => {
    expect(getLibrary(dir)).toBe(getLibrary(dir));
    expect(getLibrary().dir).toContain(`mockup-cdn-${process.pid}`);
  });

  it('safeStem sanitiza nomes', () => {
    expect(safeStem('C:\\x\\Minha Foto (1).png')).toBe('Minha-Foto--1-');
    expect(safeStem('', 'imagem')).toBe('imagem');
    expect(safeStem('nul.png')).toBe('nul-arquivo');
  });
});
