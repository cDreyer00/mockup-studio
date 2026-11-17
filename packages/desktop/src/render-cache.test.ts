import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocument, createNodeFromTag } from '@mockup/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LruCache,
  MAX_SIDE_PX,
  assertViewport,
  assetFingerprints,
  cacheKey,
  referencedAssets,
} from './main/render-utils.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function docWithAssets() {
  const doc = createDocument('T');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'F',
    styles: { width: '400px', height: '300px', 'background-image': "url('./bg.png')" },
    position: { x: 0, y: 0 },
  });
  const img = createNodeFromTag('img', { name: 'foto' });
  img.type = 'image';
  img.src = 'foto.png';
  const remoto = createNodeFromTag('img', { name: 'remota' });
  remoto.type = 'image';
  remoto.src = 'https://exemplo.com/x.png';
  frame.children.push(img, remoto);
  doc.pages[0]!.frames.push(frame);
  doc.fonts.push({ family: 'Inter', source: 'file', files: ['fonts/inter.woff2'] });
  return { doc, frameId: frame.id };
}

describe('cache de render por arquivos referenciados', () => {
  it('lista src de imagens, url() relativos e arquivos de fontes (sem data:/http)', () => {
    const { doc, frameId } = docWithAssets();
    expect(referencedAssets(doc, frameId)).toEqual(['bg.png', 'fonts/inter.woff2', 'foto.png']);
  });

  it('trocar o arquivo (mesmo nome) muda a chave; ausente e `..` são ignorados', () => {
    const { doc, frameId } = docWithAssets();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mockup-assets-'));
    dirs.push(dir);
    const foto = path.join(dir, 'foto.png');
    fs.writeFileSync(foto, 'aaaa');
    const base = { doc, docId: 'd', nodeId: frameId, scale: 1, format: 'png', transparent: false };
    const key = (): string =>
      cacheKey({ ...base, assets: assetFingerprints(dir, referencedAssets(doc, frameId)) });
    const k1 = key();
    expect(key()).toBe(k1);
    fs.writeFileSync(foto, 'bbbbbbbb');
    const k2 = key();
    expect(k2).not.toBe(k1);
    fs.writeFileSync(foto, 'bbbbbbbb');
    fs.utimesSync(foto, new Date(1e12), new Date(1e12 + 5000));
    expect(key()).not.toBe(k2);
    expect(assetFingerprints(dir, ['../fora.png', 'nao-existe.png'])).toEqual([]);
    expect(assetFingerprints(null, ['foto.png'])).toEqual([]);
  });
});

describe('LruCache por bytes', () => {
  it('descarta os menos usados quando a soma passa do limite', () => {
    const c = new LruCache<Buffer>(10, (b) => b.length);
    c.set('a', Buffer.alloc(4));
    c.set('b', Buffer.alloc(4));
    c.get('a');
    c.set('c', Buffer.alloc(4));
    expect(c.get('b')).toBeUndefined();
    expect(c.bytes).toBe(8);
    c.set('grande', Buffer.alloc(11));
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
  });
});

describe('assertViewport', () => {
  it('limita frame × escala antes de redimensionar a janela', () => {
    expect(() => assertViewport(1440, 900, 3)).not.toThrow();
    expect(() => assertViewport(MAX_SIDE_PX / 2 + 1, 100, 2)).toThrow(/grande demais.*escala 2/);
  });
});
