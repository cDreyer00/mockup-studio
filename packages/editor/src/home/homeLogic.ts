/** Lógica pura da tela inicial: árvore de pastas virtuais e filtros. */
import type { FileEntry, FilesQuery } from '../client/api';

export interface FolderNode {
  /** Caminho completo (`Clientes/Acme`). */
  path: string;
  /** Último segmento. */
  name: string;
  children: FolderNode[];
}

/** Monta a árvore a partir de `folders` (cria os pais implícitos), ordenada por nome. */
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
    list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
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

/** Parâmetros de `GET /api/files` para o filtro e a busca. */
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

/** Ordena o resultado: Recentes (sem busca) só os que têm `recent`, em ordem; demais por nome. */
export function arrangeFiles(
  files: readonly FileEntry[],
  filter: HomeFilter,
  search = '',
): FileEntry[] {
  if (filter.kind === 'recent' && !search.trim()) {
    return files.filter((f) => f.recent !== undefined).sort((a, b) => a.recent! - b.recent!);
  }
  return [...files].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
}

export function sameFilter(a: HomeFilter, b: HomeFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'folder' && b.kind === 'folder') return a.path === b.path;
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag;
  return true;
}

/** Pasta formatada para o cartão. */
export function folderLabel(folder: string | null): string {
  return folder ? folder.split('/').join(' / ') : 'Sem pasta';
}

/** Separa tags digitadas ("a, b  c") em lista única sem vazios. */
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
