import { createDocument, createNodeFromTag } from '@mockup/core';
import { describe, expect, it } from 'vitest';
import {
  LruCache,
  MAX_SIDE_PX,
  assertSize,
  cacheKey,
  declaredSize,
  pngSize,
  withTimeout,
} from './main/render-utils.js';

function sampleDoc() {
  const doc = createDocument('T');
  const frame = createNodeFromTag('div', {
    isRoot: true,
    name: 'F',
    styles: { width: '1440px', height: '900px' },
    position: { x: 0, y: 0 },
  });
  doc.pages[0]!.frames.push(frame);
  return { doc, frame };
}

describe('render-utils', () => {
  it('pngSize reads the IHDR', () => {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(1440, 16);
    b.writeUInt32BE(900, 20);
    expect(pngSize(b)).toEqual({ width: 1440, height: 900 });
    expect(() => pngSize(Buffer.from('nothing'))).toThrow();
  });

  it('assertSize limits the final side after scaling', () => {
    expect(() => assertSize(1440, 900, 3)).not.toThrow();
    expect(() => assertSize(MAX_SIDE_PX, 10, 2)).toThrow(/too large/);
    expect(() => assertSize(0, 10, 1)).toThrow(/empty/);
  });

  it('declaredSize reads px from the style', () => {
    const { frame } = sampleDoc();
    expect(declaredSize(frame)).toEqual({ width: 1440, height: 900 });
    expect(declaredSize(undefined)).toEqual({});
  });

  it('cacheKey is stable and changes with scale, tokens, themes and the frame', () => {
    const { doc, frame } = sampleDoc();
    const base = { doc, docId: 'd', nodeId: frame.id, scale: 1, format: 'png', transparent: false };
    const k = cacheKey(base);
    expect(cacheKey({ ...base })).toBe(k);
    expect(cacheKey({ ...base, scale: 2 })).not.toBe(k);
    expect(cacheKey({ ...base, transparent: true })).not.toBe(k);
    expect(cacheKey({ ...base, time: 2 })).not.toBe(k);
    // no time (video poster) ≠ time 0 (first frame)
    expect(cacheKey({ ...base, time: 0 })).not.toBe(k);
    expect(cacheKey({ ...base, time: undefined })).toBe(k);
    const doc2 = structuredClone(doc);
    doc2.tokens['--x'] = '1';
    expect(cacheKey({ ...base, doc: doc2 })).not.toBe(k);
    const doc3 = structuredClone(doc);
    doc3.pages[0]!.frames[0]!.style.width = '800px';
    expect(cacheKey({ ...base, doc: doc3 })).not.toBe(k);
    const doc4 = structuredClone(doc);
    doc4.themes = [{ name: 'dark', overrides: { '--x': '2' } }];
    const k4 = cacheKey({ ...base, doc: doc4 });
    expect(k4).not.toBe(k);
    const doc5 = structuredClone(doc4);
    doc5.themes![0]!.overrides['--x'] = '3';
    expect(cacheKey({ ...base, doc: doc5 })).not.toBe(k4);
  });

  it('LruCache drops the least recently used', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });

  it('withTimeout rejects and calls onTimeout', async () => {
    let called = false;
    await expect(
      withTimeout(new Promise(() => undefined), 20, 'test', () => (called = true)),
    ).rejects.toThrow(/Timed out/);
    expect(called).toBe(true);
    await expect(withTimeout(Promise.resolve(7), 1000, 'ok')).resolves.toBe(7);
  });
});
