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

describe('Library (local CDN)', () => {
  let dir: string;
  let lib: Library;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-lib-'));
    lib = new Library(path.join(dir, 'cdn'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('stable 32-hex hash and content-idempotent entry', () => {
    const bytes = fakePng(30, 20);
    const a = lib.add(bytes, { name: 'Cover.png' });
    const b = lib.add(Buffer.from(bytes), { name: 'other-name.png' });
    expect(a.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(a.hash).toBe(hashBytes(bytes));
    expect(b.hash).toBe(a.hash);
    expect(b.name).toBe('Cover.png');
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

  it('persists the index (atomically) and reloads in another instance', () => {
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

  it('searches by name and tag ignoring accents and case; removes', () => {
    const a = lib.add(fakePng(8, 8), { name: 'Logo-Caf\u00e9.png', tags: ['Brand'] });
    const b = lib.add(fakePng(9, 9), { name: 'photo.png' });
    expect(lib.list('cafe').map((x) => x.hash)).toEqual([a.hash]);
    expect(lib.list('BRAND').map((x) => x.hash)).toEqual([a.hash]);
    expect(lib.list('photo').map((x) => x.hash)).toEqual([b.hash]);
    expect(lib.list('nonexistent')).toEqual([]);
    expect(lib.remove(a.hash)).toBe(true);
    expect(lib.remove(a.hash)).toBe(false);
    expect(lib.list().map((x) => x.hash)).toEqual([b.hash]);
    expect(lib.fileFor(`${a.hash}.png`)).toBeNull();
  });

  it('imports into assets/ without overwriting', async () => {
    const a = lib.add(fakePng(8, 8), { name: 'My Photo.png' });
    const assets = path.join(dir, 'assets');
    expect(await lib.importTo(a.hash, assets)).toBe('My-Photo.png');
    expect(await lib.importTo(a.hash, assets)).toBe('My-Photo-1.png');
    expect(fs.readdirSync(assets).sort()).toEqual(['My-Photo-1.png', 'My-Photo.png']);
  });

  it('rejects content that is neither an image nor a font; recognizes fonts by signature', () => {
    expect(() => lib.add(Buffer.from('any text with no format'))).toThrow(/recognized/);
    const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 1)]);
    expect(detectAsset(woff2)).toMatchObject({ ext: '.woff2', kind: 'font' });
    expect(lib.add(woff2, { name: 'f.woff2' }).mime).toBe('font/woff2');
  });

  it('getLibrary is a per-folder singleton and uses a temporary folder without dataDir', () => {
    expect(getLibrary(dir)).toBe(getLibrary(dir));
    expect(getLibrary().dir).toContain(`mockup-cdn-${process.pid}`);
  });

  it('safeStem sanitizes names', () => {
    expect(safeStem('C:\\x\\My Photo (1).png')).toBe('My-Photo--1-');
    expect(safeStem('', 'image')).toBe('image');
    expect(safeStem('nul.png')).toBe('nul-file');
  });
});
