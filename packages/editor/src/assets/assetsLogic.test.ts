import { describe, expect, it } from 'vitest';
import type { AssetInfo } from '../client/api';
import { filterAssets, formatBytes, optimizeSummary } from './assetsLogic';

function asset(path: string, uses = 0): AssetInfo {
  return {
    path,
    name: path.split('/').pop()!,
    ext: '.png',
    kind: 'image',
    mime: 'image/png',
    size: 100,
    mtime: 0,
    hash: path,
    cdnUrl: `http://x/cdn/${path}`,
    uses,
    nodeIds: [],
    refKinds: [],
  };
}

describe('filterAssets', () => {
  const list = [asset('b.png', 2), asset('Café.png'), asset('sub/a.png'), asset('img10.png')];

  it('sorts by path (natural)', () => {
    expect(filterAssets(list, { query: '', unusedOnly: false }).map((a) => a.path)).toEqual([
      'b.png',
      'Café.png',
      'img10.png',
      'sub/a.png',
    ]);
  });
  it('search ignores accents and case', () => {
    expect(filterAssets(list, { query: 'CAFE', unusedOnly: false }).map((a) => a.path)).toEqual([
      'Café.png',
    ]);
  });
  it('filters unused', () => {
    const r = filterAssets(list, { query: '', unusedOnly: true });
    expect(r.every((a) => a.uses === 0)).toBe(true);
    expect(r).toHaveLength(3);
  });
});

describe('formatting', () => {
  it('bytes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
  });
  it('optimizer summary', () => {
    expect(optimizeSummary([], 0)).toBe('Nothing to optimize.');
    expect(optimizeSummary([{ before: 204800, after: 51200 }], 1)).toBe(
      '1 image optimized: 200 KB → 50 KB (1 skipped)',
    );
  });
});
