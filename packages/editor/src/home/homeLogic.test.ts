import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../client/api';
import { arrangeFiles, buildFilesQuery, buildFolderTree, parseTags, sameFilter } from './homeLogic';

function file(name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/p/${name}.mockup.json`,
    name,
    folder: null,
    tags: [],
    favorite: false,
    open: false,
    mtime: 0,
    size: 1,
    pages: 1,
    frames: 1,
    ...extra,
  };
}

describe('buildFolderTree', () => {
  it('nests by "/" creating implicit parents and sorts', () => {
    const tree = buildFolderTree(['Clients/Acme/Sites', 'Zeta', 'Clients', 'Alfa']);
    expect(tree.map((n) => n.path)).toEqual(['Alfa', 'Clients', 'Zeta']);
    const acme = tree[1]!.children[0]!;
    expect(acme).toMatchObject({ path: 'Clients/Acme', name: 'Acme' });
    expect(acme.children[0]!.path).toBe('Clients/Acme/Sites');
  });
  it('implicit parent without the parent folder listed', () => {
    const tree = buildFolderTree(['A/B']);
    expect(tree[0]!.path).toBe('A');
    expect(tree[0]!.children[0]!.path).toBe('A/B');
  });
  it('ignores empty entries and normalizes slashes', () => {
    expect(buildFolderTree(['', ' / ', '/X/'])).toHaveLength(1);
  });
});

describe('buildFilesQuery', () => {
  it('builds the parameters per filter', () => {
    expect(buildFilesQuery({ kind: 'recent' }, '')).toEqual({});
    expect(buildFilesQuery({ kind: 'favorites' }, ' x ')).toEqual({ favorites: true, query: 'x' });
    expect(buildFilesQuery({ kind: 'folder', path: 'A/B' }, '')).toEqual({
      folder: 'A/B',
      recursive: true,
    });
    expect(buildFilesQuery({ kind: 'tag', tag: 'client' }, '')).toEqual({ tag: 'client' });
  });
});

describe('arrangeFiles', () => {
  const list = [file('b', { recent: 1 }), file('a'), file('c', { recent: 0 })];
  it('recent: only recent files, in order', () => {
    expect(arrangeFiles(list, { kind: 'recent' }).map((f) => f.name)).toEqual(['c', 'b']);
  });
  it('with search or other filters: by name', () => {
    expect(arrangeFiles(list, { kind: 'recent' }, 'x').map((f) => f.name)).toEqual(['a', 'b', 'c']);
    expect(arrangeFiles(list, { kind: 'all' }).map((f) => f.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('utilities', () => {
  it('sameFilter', () => {
    expect(sameFilter({ kind: 'all' }, { kind: 'all' })).toBe(true);
    expect(sameFilter({ kind: 'tag', tag: 'a' }, { kind: 'tag', tag: 'b' })).toBe(false);
    expect(sameFilter({ kind: 'folder', path: 'a' }, { kind: 'folder', path: 'a' })).toBe(true);
  });
  it('parseTags', () => {
    expect(parseTags('a, b;; a\nc')).toEqual(['a', 'b', 'c']);
  });
});
