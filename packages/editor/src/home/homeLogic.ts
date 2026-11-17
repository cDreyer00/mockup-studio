/** Pure logic of the home screen: virtual folder tree and filters. */
import type { FileEntry, FilesQuery } from '../client/api';

export interface FolderNode {
  /** Full path (`Clients/Acme`). */
  path: string;
  /** Last segment. */
  name: string;
  children: FolderNode[];
}

/** Builds the tree from `folders` (creating implicit parents), sorted by name. */
export function buildFolderTree(folders: readonly string[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const index = new Map<string, FolderNode>();
  const ensure = (path: string): FolderNode => {
    const found = index.get(path);
    if (found) return found;
    const cut = path.lastIndexOf('/');
    const node: FolderNode = { path, name: path.slice(cut + 1), children: [] };
    index.set(path, node);
    (cut < 0 ? roots : ensure(path.slice(0, cut)).children).push(node);
    return node;
  };
  for (const raw of folders) {
    const path = raw
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('/');
    if (path) ensure(path);
  }
  const sort = (list: FolderNode[]): void => {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

export type HomeFilter =
  | { kind: 'recent' }
  | { kind: 'favorites' }
  | { kind: 'all' }
  | { kind: 'folder'; path: string }
  | { kind: 'tag'; tag: string };

export const DEFAULT_FILTER: HomeFilter = { kind: 'recent' };

/** `GET /api/files` parameters for the filter and search. */
export function buildFilesQuery(filter: HomeFilter, search: string): FilesQuery {
  const q: FilesQuery = {};
  const text = search.trim();
  if (text) q.query = text;
  if (filter.kind === 'favorites') q.favorites = true;
  else if (filter.kind === 'folder') {
    q.folder = filter.path;
    q.recursive = true;
  } else if (filter.kind === 'tag') q.tag = filter.tag;
  return q;
}

/** Sorts the result: Recent (without search) keeps only files with `recent`, in order; the rest by name. */
export function arrangeFiles(
  files: readonly FileEntry[],
  filter: HomeFilter,
  search = '',
): FileEntry[] {
  if (filter.kind === 'recent' && !search.trim()) {
    return files.filter((f) => f.recent !== undefined).sort((a, b) => a.recent! - b.recent!);
  }
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function sameFilter(a: HomeFilter, b: HomeFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'folder' && b.kind === 'folder') return a.path === b.path;
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag;
  return true;
}

/** Folder formatted for the card. */
export function folderLabel(folder: string | null): string {
  return folder ? folder.split('/').join(' / ') : 'No folder';
}

/** Splits typed tags ("a, b  c") into a unique list without empty entries. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,;\n]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}
