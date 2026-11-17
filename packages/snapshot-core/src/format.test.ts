import { describe, expect, it } from 'vitest';
import {
  assetRefId,
  decodeClipboard,
  encodeClipboard,
  isSnapshotPayload,
  looksLikeSnapshot,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SnapshotPayload,
} from './format.js';

function payload(): SnapshotPayload {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    source: {
      url: 'https://example.com/',
      title: 'Example',
      capturedAt: '2026-01-01T00:00:00.000Z',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 2,
    },
    root: {
      id: 'el_aaaaaaaa',
      type: 'element',
      name: 'Hero',
      tag: 'section',
      attrs: {},
      style: { width: '100px' },
      children: [],
      locked: false,
      hidden: false,
    },
    width: 100,
    height: 50,
    assets: [{ id: 'a1', kind: 'image', url: 'https://example.com/a.png' }],
    fonts: [],
    stats: { nodes: 1, truncated: false, warnings: [] },
  };
}

describe('assetRefId', () => {
  it('extracts the id from asset:<id>', () => {
    expect(assetRefId('asset:a1')).toBe('a1');
    expect(assetRefId('asset:img-2_x')).toBe('img-2_x');
  });

  it('rejects what is not a valid reference', () => {
    expect(assetRefId('a1')).toBeNull();
    expect(assetRefId('asset:')).toBeNull();
    expect(assetRefId('asset:a b')).toBeNull();
    expect(assetRefId('asset:' + 'x'.repeat(33))).toBeNull();
    expect(assetRefId(undefined)).toBeNull();
    expect(assetRefId('https://x/asset:a1')).toBeNull();
  });
});

describe('clipboard', () => {
  it('encode starts with the recognized prefix and decode returns the payload', () => {
    const text = encodeClipboard(payload());
    expect(text.startsWith('{"format":"mockup-snapshot"')).toBe(true);
    expect(looksLikeSnapshot(text)).toBe(true);
    expect(decodeClipboard(text)).toEqual(payload());
  });

  it('looksLikeSnapshot accepts leading whitespace and rejects other texts', () => {
    expect(looksLikeSnapshot('  \n {  "format" : "mockup-snapshot", "version": 1}')).toBe(true);
    expect(looksLikeSnapshot('{"format":"other"}')).toBe(false);
    expect(looksLikeSnapshot('any text')).toBe(false);
    expect(looksLikeSnapshot('')).toBe(false);
    expect(looksLikeSnapshot(null)).toBe(false);
  });

  it('decode returns null for invalid or incomplete JSON', () => {
    expect(decodeClipboard('{"format":"mockup-snapshot", broken')).toBeNull();
    expect(
      decodeClipboard('{"format":"mockup-snapshot","version":2,"root":{},"assets":[]}'),
    ).toBeNull();
    expect(decodeClipboard('{"format":"mockup-snapshot","version":1}')).toBeNull();
    expect(decodeClipboard(undefined)).toBeNull();
  });

  it('isSnapshotPayload checks format, version, root and assets', () => {
    expect(isSnapshotPayload(payload())).toBe(true);
    expect(isSnapshotPayload({ ...payload(), assets: undefined })).toBe(false);
    expect(isSnapshotPayload(null)).toBe(false);
    expect(isSnapshotPayload('x')).toBe(false);
  });
});
