/**
 * Typed HTTP client for the assets, library, files and search routes (phase 6 contract).
 * Uses URLs relative to the page origin, like `client/daemon.ts` (the Vite proxy covers /api).
 */
import type { NodeMatch } from '@mockup/core';

export interface AssetInfo {
  /** Relative to `assets/`, with forward slashes. */
  path: string;
  name: string;
  ext: string;
  kind: 'image' | 'font' | 'other';
  mime: string;
  size: number;
  width?: number;
  height?: number;
  mtime: number;
  hash: string;
  cdnUrl: string;
  /** Number of nodes that use the file. */
  uses: number;
  nodeIds: string[];
  refKinds: ('src' | 'style' | 'font' | 'data')[];
}

export interface LibraryAsset {
  hash: string;
  ext: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  addedAt: number;
  tags: string[];
  url: string;
}

export interface FileEntry {
  path: string;
  name: string;
  folder: string | null;
  tags: string[];
  favorite: boolean;
  open: boolean;
  docId?: string;
  mtime: number;
  size: number;
  pages: number;
  frames: number;
  missing?: boolean;
  /** Position in recent.json (0 = most recent). */
  recent?: number;
  match?: { field: 'name' | 'tag' | 'content'; snippet: string };
}

export interface FilesQuery {
  folder?: string;
  tag?: string;
  query?: string;
  favorites?: boolean;
  recursive?: boolean;
}

export interface FilesResult {
  files: FileEntry[];
  folders: string[];
  tags: string[];
}

export interface OptimizeResult {
  results: { path: string; newPath: string; before: number; after: number }[];
  skipped: unknown[];
}

export interface FileMetaPatch {
  folder?: string | null;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  favorite?: boolean;
}

/** HTTP error with the status (e.g. 409 = asset in use). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('No connection to the daemon. Check that it is running.', 0);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return body;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const enc = encodeURIComponent;

/** Builds `?a=1&b=2` ignoring empty values. */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** URL to display a document asset (thumbnail/preview). */
export function assetViewUrl(docId: string, path: string): string {
  return `/assets/${enc(docId)}/${path.split('/').map(enc).join('/')}`;
}

/** URL of the thumbnail of a home screen file. */
export function thumbnailUrl(path: string, mtime?: number, w = 480): string {
  return `/api/files/thumbnail${queryString({ path, w, v: mtime })}`;
}

function contentType(file: Blob): HeadersInit {
  return { 'Content-Type': file.type || 'application/octet-stream' };
}

export const api = {
  assets: {
    list: async (docId: string): Promise<AssetInfo[]> =>
      (await request<{ assets: AssetInfo[] }>(`/api/assets/${enc(docId)}`)).assets ?? [],
    upload: async (docId: string, file: Blob, name: string): Promise<string> => {
      const r = await request<{ src: string }>(`/api/assets/${enc(docId)}?name=${enc(name)}`, {
        method: 'POST',
        headers: contentType(file),
        body: file,
      });
      return r.src;
    },
    remove: (docId: string, path: string, force = false): Promise<{ removed: string[] }> =>
      request(`/api/assets/${enc(docId)}${queryString({ path, force })}`, { method: 'DELETE' }),
    removeUnused: (docId: string, dryRun = false): Promise<{ removed: string[]; kept: number }> =>
      request(`/api/assets/${enc(docId)}/remove-unused`, json({ dryRun })),
    link: (docId: string, path: string): Promise<{ hash: string; url: string; cdnPath: string }> =>
      request(`/api/assets/${enc(docId)}/link`, json({ path })),
    optimize: (
      docId: string,
      opts: { paths?: string[]; maxWidth?: number; format?: 'webp' | 'keep'; quality?: number },
    ): Promise<OptimizeResult> => request(`/api/assets/${enc(docId)}/optimize`, json(opts)),
  },
  library: {
    list: async (query?: string): Promise<LibraryAsset[]> =>
      (await request<{ assets: LibraryAsset[] }>(`/api/library${queryString({ query })}`)).assets ??
      [],
    upload: (file: Blob, name: string): Promise<LibraryAsset> =>
      request(`/api/library?name=${enc(name)}`, {
        method: 'POST',
        headers: contentType(file),
        body: file,
      }),
    import: async (hash: string, docId: string): Promise<string> =>
      (await request<{ src: string }>(`/api/library/${enc(hash)}/import`, json({ docId }))).src,
    remove: (hash: string): Promise<{ removed: boolean }> =>
      request(`/api/library/${enc(hash)}`, { method: 'DELETE' }),
  },
  files: {
    list: async (q: FilesQuery = {}): Promise<FilesResult> => {
      const r = await request<Partial<FilesResult>>(
        `/api/files${queryString({
          folder: q.folder,
          tag: q.tag,
          query: q.query,
          favorites: q.favorites,
          recursive: q.recursive,
        })}`,
      );
      return { files: r.files ?? [], folders: r.folders ?? [], tags: r.tags ?? [] };
    },
    meta: (path: string, patch: FileMetaPatch): Promise<FileEntry> =>
      request('/api/files/meta', json({ path, ...patch })),
    folders: async (
      action: 'create' | 'rename' | 'delete',
      path: string,
      to?: string,
    ): Promise<string[]> =>
      (
        await request<{ folders: string[] }>(
          '/api/files/folders',
          json({ action, path, ...(to !== undefined ? { to } : {}) }),
        )
      ).folders,
    add: async (path: string): Promise<FileEntry[]> =>
      (await request<{ added: FileEntry[] }>('/api/files/add', json({ path }))).added ?? [],
    forget: (path: string): Promise<{ ok: true }> => request('/api/files/forget', json({ path })),
  },
  search: {
    nodes: async (query: string, docId?: string): Promise<(NodeMatch & { docId: string })[]> =>
      (
        await request<{ matches: (NodeMatch & { docId: string })[] }>(
          `/api/search/nodes${queryString({ query, docId })}`,
        )
      ).matches ?? [],
  },
};
