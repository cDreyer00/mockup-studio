/**
 * Mockup Studio file index (`files.json` in the data folder): nested virtual folders,
 * tags, favorites and search (name, tag and content) over the known documents, plus thumbnails.
 * One index per `DocumentStore` (`getFileIndex`), which follows the store events.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assetPathOf,
  documentText,
  foldText,
  parseDocument,
  type Document,
  type Node,
} from '@mockup/core';
import { assetDataUrl } from './assets.js';
import { DOCUMENT_EXT, readRecent } from './paths.js';
import type { RenderProvider } from './render.js';
import type { DocumentStore } from './store.js';

export interface FileMeta {
  folder?: string;
  tags: string[];
  favorite?: boolean;
  addedAt: string;
  lastOpenedAt?: string;
}

interface IndexData {
  version: 1;
  folders: string[];
  files: Record<string, FileMeta>;
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
  recent?: number;
  match?: { field: 'name' | 'tag' | 'content'; snippet: string };
}

export interface FileListOptions {
  /** Folder (`Clients/Acme`); empty/absent = all; `/` = only those without a folder. */
  folder?: string | null;
  tag?: string;
  query?: string;
  favorites?: boolean;
  /** Includes the files in the subfolders of `folder`. */
  recursive?: boolean;
}

export interface FileMetaChange {
  folder?: string | null;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  favorite?: boolean;
}

/** Error caused by the request (invalid path, missing folder...): the HTTP layer returns the 4xx. */
export class FilesError extends Error {
  readonly expose = true;
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FilesError';
  }
}

const MAX_READ_BYTES = 64 * 1024 * 1024;
const SCAN_SKIP = new Set(['node_modules', 'assets']);
let tmpCounter = 0;

const isWin = process.platform === 'win32';
const sameKey = (a: string, b: string): boolean =>
  isWin ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Normalizes a virtual folder path: forward slashes, no empty parts or `.`/`..`. `''` = root. */
export function normalizeFolder(input: string): string {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..')) {
    throw new FilesError(
      400,
      `Invalid folder path: "${input}". Use names separated by "/", without "." or "..". E.g.: "Clients/Acme".`,
    );
  }
  return parts.join('/');
}

/** Tags trimmed, without empty ones or duplicates (case/accent-insensitive). */
export function normalizeTags(tags: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim();
    const k = foldText(v);
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const ancestorsOf = (folder: string): string[] => {
  const parts = folder.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
};
const parentOf = (folder: string): string => folder.split('/').slice(0, -1).join('/');
const inside = (folder: string, root: string): boolean =>
  folder === root || folder.startsWith(root + '/');

interface ContentCache {
  mtime: number;
  size: number;
  /** Revision of the open document (closed files use -1). */
  revision: number;
  pages: number;
  frames: number;
  title: string;
  text: string;
  folded?: string;
}

function snippetAround(text: string, folded: string, term: string): string {
  const i = folded.indexOf(term);
  const start = Math.max(0, i - 30);
  const s = text
    .slice(start, start + 90)
    .replace(/\s+/g, ' ')
    .trim();
  return (start > 0 ? '…' : '') + s + (start + 90 < text.length ? '…' : '');
}

export class FileIndex {
  private data: IndexData = { version: 1, folders: [], files: {} };
  private dataDir: string | undefined;
  private writing: Promise<void> = Promise.resolve();
  private cache = new Map<string, ContentCache>();
  private thumbJobs = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly store: DocumentStore,
    dataDir?: string,
  ) {
    this.useDataDir(dataDir);
    for (const info of store.list()) if (info.path) this.touch(info.path, true);
    store.on('doc:opened', (e) => {
      if (e.info.path) this.touch(e.info.path, true);
    });
    store.on('doc:saved', (e) => this.touch(e.path, false));
  }

  /** Starts using `dataDir` (reads `files.json`); only applies if there was no data folder yet. */
  useDataDir(dataDir?: string): void {
    if (!dataDir || this.dataDir) return;
    this.dataDir = dataDir;
    const loaded = this.readDisk();
    // what was already in memory (files opened before the data folder) wins
    for (const [k, v] of Object.entries(loaded.files)) if (!this.find(k)) this.data.files[k] = v;
    this.data.folders = [...new Set([...loaded.folders, ...this.data.folders])];
    if (Object.keys(this.data.files).length > Object.keys(loaded.files).length) void this.persist();
  }

  private get file(): string | undefined {
    return this.dataDir ? path.join(this.dataDir, 'files.json') : undefined;
  }

  private readDisk(): IndexData {
    const out: IndexData = { version: 1, folders: [], files: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file!, 'utf8'));
    } catch {
      return out;
    }
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.folders)) {
      for (const f of r.folders) {
        if (typeof f !== 'string') continue;
        try {
          const n = normalizeFolder(f);
          if (n) out.folders.push(n);
        } catch {
          /* invalid folder ignored */
        }
      }
    }
    if (r.files && typeof r.files === 'object' && !Array.isArray(r.files)) {
      for (const [p, m] of Object.entries(r.files as Record<string, unknown>)) {
        if (!m || typeof m !== 'object') continue;
        const o = m as Record<string, unknown>;
        let folder: string | undefined;
        if (typeof o.folder === 'string') {
          try {
            folder = normalizeFolder(o.folder) || undefined;
          } catch {
            folder = undefined;
          }
        }
        const meta: FileMeta = {
          tags: Array.isArray(o.tags) ? normalizeTags(o.tags) : [],
          addedAt: typeof o.addedAt === 'string' ? o.addedAt : new Date().toISOString(),
        };
        if (folder) meta.folder = folder;
        if (o.favorite === true) meta.favorite = true;
        if (typeof o.lastOpenedAt === 'string') meta.lastOpenedAt = o.lastOpenedAt;
        out.files[p] = meta;
      }
    }
    return out;
  }

  /** Writes the current state (temp file + rename, queued: no write is lost). */
  persist(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const run = async (): Promise<void> => {
      const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
        for (let attempt = 0; ; attempt++) {
          try {
            await fs.promises.rename(tmp, file);
            break;
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code ?? '';
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 3) throw e;
            await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
          }
        }
      } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
        console.error(
          '[mockup-daemon] failed to write files.json:',
          e instanceof Error ? e.message : e,
        );
      }
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /** Waits for pending writes. */
  flush(): Promise<void> {
    return this.writing;
  }

  private find(p: string): string | undefined {
    const abs = path.resolve(p);
    if (abs in this.data.files) return abs;
    if (isWin) return Object.keys(this.data.files).find((k) => sameKey(k, abs));
    return undefined;
  }

  private ensure(p: string): { key: string; meta: FileMeta; created: boolean } {
    const found = this.find(p);
    if (found) return { key: found, meta: this.data.files[found]!, created: false };
    const key = path.resolve(p);
    const meta: FileMeta = { tags: [], addedAt: new Date().toISOString() };
    this.data.files[key] = meta;
    return { key, meta, created: true };
  }

  /** Registers the file (opened/created/saved). `opened` updates `lastOpenedAt`. */
  private touch(p: string, opened: boolean): void {
    if (!p.toLowerCase().endsWith(DOCUMENT_EXT)) return;
    const { meta, created } = this.ensure(p);
    if (opened) meta.lastOpenedAt = new Date().toISOString();
    if (created || opened) void this.persist();
  }

  /* ---------- folders ---------- */

  /** Existing folders: the created ones and the ancestors of those used by files. */
  folders(): string[] {
    const set = new Set<string>();
    for (const f of this.data.folders) for (const a of ancestorsOf(f)) set.add(a);
    for (const m of Object.values(this.data.files)) {
      if (m.folder) for (const a of ancestorsOf(m.folder)) set.add(a);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'en-US'));
  }

  async createFolder(p: string): Promise<string[]> {
    const f = normalizeFolder(p);
    if (!f) throw new FilesError(400, 'Provide the folder name. E.g.: "Clients/Acme".');
    for (const a of ancestorsOf(f)) if (!this.data.folders.includes(a)) this.data.folders.push(a);
    await this.persist();
    return this.folders();
  }

  async renameFolder(from: string, to: string): Promise<string[]> {
    const src = normalizeFolder(from);
    const dst = normalizeFolder(to);
    if (!src || !dst) throw new FilesError(400, 'Provide the source folder and the new path (to).');
    if (!this.folders().includes(src))
      throw new FilesError(404, `Folder not found: "${src}". See the folders with list_files.`);
    if (src === dst) return this.folders();
    if (inside(dst, src)) throw new FilesError(400, `Cannot move "${src}" into itself ("${dst}").`);
    if (this.folders().includes(dst))
      throw new FilesError(
        409,
        `Folder "${dst}" already exists. Choose another name or move the files with move_files.`,
      );
    const remap = (f: string): string => (inside(f, src) ? dst + f.slice(src.length) : f);
    const folders = new Set<string>();
    for (const f of this.data.folders) folders.add(remap(f));
    for (const a of ancestorsOf(dst)) folders.add(a);
    this.data.folders = [...folders];
    for (const m of Object.values(this.data.files)) if (m.folder) m.folder = remap(m.folder);
    await this.persist();
    return this.folders();
  }

  async deleteFolder(p: string): Promise<string[]> {
    const f = normalizeFolder(p);
    if (!f) throw new FilesError(400, 'Provide the folder to delete. E.g.: "Clients/Acme".');
    if (!this.folders().includes(f))
      throw new FilesError(404, `Folder not found: "${f}". See the folders with list_files.`);
    const parent = parentOf(f);
    for (const m of Object.values(this.data.files)) {
      if (m.folder && inside(m.folder, f)) {
        if (parent) m.folder = parent;
        else delete m.folder;
      }
    }
    this.data.folders = this.data.folders.filter((x) => !inside(x, f));
    await this.persist();
    return this.folders();
  }

  /* ---------- files ---------- */

  /** Absolute path of a `.mockup.json` (400 otherwise). */
  static requireDocPath(p: unknown): string {
    if (typeof p !== 'string' || !p.trim())
      throw new FilesError(400, 'Provide the absolute path of the file (path).');
    if (!path.isAbsolute(p))
      throw new FilesError(
        400,
        `The path must be absolute: "${p}". E.g.: "C:/projects/site.mockup.json".`,
      );
    if (!p.toLowerCase().endsWith(DOCUMENT_EXT))
      throw new FilesError(400, `The file must end in ${DOCUMENT_EXT}: "${p}".`);
    return path.resolve(p);
  }

  async setMeta(p: string, change: FileMetaChange): Promise<FileEntry> {
    const abs = FileIndex.requireDocPath(p);
    const known = this.find(abs) !== undefined;
    const isOpen = this.store.list().some((d) => d.path && sameKey(path.resolve(d.path), abs));
    if (!known && !isOpen && !fs.existsSync(abs))
      throw new FilesError(404, `File not found: ${abs}`);
    let folder: string | undefined | null;
    if (change.folder !== undefined) {
      folder = change.folder === null ? null : normalizeFolder(change.folder) || null;
    }
    const { meta } = this.ensure(abs);
    if (folder !== undefined) {
      if (folder === null) delete meta.folder;
      else {
        meta.folder = folder;
        for (const a of ancestorsOf(folder)) {
          if (!this.data.folders.includes(a)) this.data.folders.push(a);
        }
      }
    }
    if (change.tags) meta.tags = normalizeTags(change.tags);
    if (change.removeTags?.length) {
      const drop = new Set(normalizeTags(change.removeTags).map(foldText));
      meta.tags = meta.tags.filter((t) => !drop.has(foldText(t)));
    }
    if (change.addTags?.length) meta.tags = normalizeTags([...meta.tags, ...change.addTags]);
    if (change.favorite !== undefined) {
      if (change.favorite) meta.favorite = true;
      else delete meta.favorite;
    }
    await this.persist();
    const [entry] = await this.entries([abs]);
    return entry!;
  }

  async forget(p: string): Promise<void> {
    const key = this.find(p);
    if (key) {
      delete this.data.files[key];
      this.cache.delete(key);
      await this.persist();
    }
  }

  /** Registers a `.mockup.json` file or those in a folder (up to 2 levels). */
  async add(p: string): Promise<FileEntry[]> {
    if (typeof p !== 'string' || !path.isAbsolute(p))
      throw new FilesError(400, `Provide an absolute path of a file or folder. Received: "${p}".`);
    const abs = path.resolve(p);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      throw new FilesError(404, `Path not found: ${abs}`);
    }
    const found: string[] = [];
    if (st.isDirectory()) {
      const scan = async (dir: string, depth: number): Promise<void> => {
        let items: fs.Dirent[];
        try {
          items = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, it.name);
          if (it.isFile() && it.name.toLowerCase().endsWith(DOCUMENT_EXT)) found.push(full);
          else if (
            it.isDirectory() &&
            depth < 2 &&
            !it.name.startsWith('.') &&
            !SCAN_SKIP.has(it.name)
          )
            await scan(full, depth + 1);
        }
      };
      await scan(abs, 0);
    } else if (abs.toLowerCase().endsWith(DOCUMENT_EXT)) {
      found.push(abs);
    } else {
      throw new FilesError(400, `Use a ${DOCUMENT_EXT} file or a folder: "${abs}".`);
    }
    let changed = false;
    for (const f of found) if (this.ensure(f).created) changed = true;
    if (changed) await this.persist();
    return this.entries(found);
  }

  /* ---------- reading ---------- */

  /** Whether the path is in the index, in the recents or open (what the home screen shows). */
  isKnown(p: string): boolean {
    const abs = path.resolve(p);
    if (this.find(abs)) return true;
    if (readRecent(this.dataDir).some((r) => sameKey(path.resolve(r), abs))) return true;
    return !!this.openDocFor(abs);
  }

  /** File entry, if the path is in the index, open or in the recents. */
  async get(p: string): Promise<FileEntry | undefined> {
    const [e] = await this.entries([path.resolve(p)]);
    return e;
  }

  private openDocFor(p: string): { docId: string; revision: number } | undefined {
    for (const d of this.store.list()) {
      if (d.path && sameKey(path.resolve(d.path), p))
        return { docId: d.docId, revision: d.revision };
    }
    return undefined;
  }

  private async loadContent(key: string, st: fs.Stats | null): Promise<ContentCache | undefined> {
    const open = this.openDocFor(key);
    const cached = this.cache.get(key);
    const mtime = st?.mtimeMs ?? 0;
    const size = st?.size ?? 0;
    if (open) {
      if (cached && cached.revision === open.revision) return cached;
      let doc: Document;
      try {
        doc = this.store.get(open.docId);
      } catch {
        return undefined;
      }
      const c = this.summarize(doc, mtime, size, open.revision);
      this.cache.set(key, c);
      return c;
    }
    if (!st) return undefined;
    if (cached && cached.revision === -1 && cached.mtime === mtime && cached.size === size)
      return cached;
    if (st.size > MAX_READ_BYTES) return undefined;
    try {
      const doc = parseDocument(await fs.promises.readFile(key, 'utf8'));
      const c = this.summarize(doc, mtime, size, -1);
      this.cache.set(key, c);
      return c;
    } catch {
      return undefined;
    }
  }

  private summarize(doc: Document, mtime: number, size: number, revision: number): ContentCache {
    return {
      mtime,
      size,
      revision,
      pages: doc.pages.length,
      frames: doc.pages.reduce((n, p) => n + p.frames.length, 0),
      title: doc.name,
      text: documentText(doc),
    };
  }

  /** Builds the entries for the given paths (no filter). */
  private async entries(paths: string[], query?: string): Promise<FileEntry[]> {
    const recent = readRecent(this.dataDir).map((p) => path.resolve(p));
    const terms = query
      ? query
          .match(/"[^"]*"|\S+/g)
          ?.map((t) => foldText(t.replace(/"/g, '')))
          .filter(Boolean)
      : [];
    const out: FileEntry[] = [];
    for (const p of paths) {
      const key = this.find(p) ?? p;
      const meta = this.data.files[key];
      let st: fs.Stats | null = null;
      try {
        st = await fs.promises.stat(key);
      } catch {
        st = null;
      }
      const open = this.openDocFor(key);
      const content = await this.loadContent(key, st);
      const name = path.basename(key).replace(/\.mockup\.json$/i, '');
      const entry: FileEntry = {
        path: key,
        name,
        folder: meta?.folder ?? null,
        tags: meta ? [...meta.tags] : [],
        favorite: meta?.favorite === true,
        open: !!open,
        mtime: st?.mtimeMs ?? 0,
        size: st?.size ?? 0,
        pages: content?.pages ?? 0,
        frames: content?.frames ?? 0,
      };
      if (open) entry.docId = open.docId;
      if (!st) entry.missing = true;
      const ri = recent.findIndex((r) => sameKey(r, key));
      if (ri >= 0) entry.recent = ri;
      if (terms && terms.length > 0) {
        const m = this.matchQuery(entry, content, terms);
        if (!m) continue;
        entry.match = m;
      }
      out.push(entry);
    }
    return out;
  }

  private matchQuery(
    entry: FileEntry,
    content: ContentCache | undefined,
    terms: string[],
  ): FileEntry['match'] | undefined {
    const nameF = foldText(`${entry.name} ${content?.title ?? ''}`);
    const tagsF = foldText(entry.tags.join('\n'));
    let folded = '';
    if (content) folded = content.folded ??= foldText(content.text);
    const where = (t: string): 'name' | 'tag' | 'content' | null =>
      nameF.includes(t)
        ? 'name'
        : tagsF.includes(t)
          ? 'tag'
          : folded.includes(t)
            ? 'content'
            : null;
    const fields = terms.map(where);
    if (fields.some((f) => f === null)) return undefined;
    const field = fields[0]!;
    const term = terms[0]!;
    if (field === 'name') return { field, snippet: entry.name };
    if (field === 'tag')
      return { field, snippet: entry.tags.find((t) => foldText(t).includes(term)) ?? '' };
    return { field, snippet: snippetAround(content!.text, folded, term) };
  }

  /** Lists the known files (index, recents and open) with the filters. */
  async list(opts: FileListOptions = {}): Promise<{
    files: FileEntry[];
    folders: string[];
    tags: string[];
  }> {
    const keys: string[] = [];
    const add = (p: string): void => {
      const k = this.find(p) ?? path.resolve(p);
      if (!keys.some((x) => sameKey(x, k))) keys.push(k);
    };
    for (const p of Object.keys(this.data.files)) add(p);
    for (const p of readRecent(this.dataDir)) add(p);
    for (const d of this.store.list()) if (d.path) add(d.path);

    let files = await this.entries(keys, opts.query?.trim() || undefined);
    const folderArg = opts.folder == null ? '' : opts.folder.trim();
    if (folderArg) {
      if (folderArg === '/' || folderArg === '.') files = files.filter((f) => f.folder === null);
      else {
        const folder = normalizeFolder(folderArg);
        files = files.filter((f) =>
          opts.recursive ? f.folder !== null && inside(f.folder, folder) : f.folder === folder,
        );
      }
    }
    if (opts.tag?.trim()) {
      const t = foldText(opts.tag.trim());
      files = files.filter((f) => f.tags.some((x) => foldText(x) === t));
    }
    if (opts.favorites) files = files.filter((f) => f.favorite);

    files.sort((a, b) => {
      if (a.open !== b.open) return a.open ? -1 : 1;
      const ra = a.recent ?? Infinity;
      const rb = b.recent ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name, 'en-US');
    });

    const allTags = new Map<string, string>();
    for (const m of Object.values(this.data.files)) {
      for (const t of m.tags) if (!allTags.has(foldText(t))) allTags.set(foldText(t), t);
    }
    return {
      files,
      folders: this.folders(),
      tags: [...allTags.values()].sort((a, b) => a.localeCompare(b, 'en-US')),
    };
  }

  /* ---------- thumbnails ---------- */

  /**
   * PNG of the first visible frame of the first page that has frames. Closed document: images and
   * `url(assets/...)` in the frame become data URLs (the render page only serves `/assets/<docId>/`
   * for open documents; ~20 MB limit in total). Limitation: embedded fonts
   * (`source: 'file'`) of closed documents are not loaded (the thumbnail uses the fallback
   * font). Cached in `<dataDir>/thumbs/<sha1(path)>-<w>.png`, invalidated by the file mtime.
   */
  async thumbnail(p: string, width: number, render: RenderProvider): Promise<Buffer> {
    const abs = FileIndex.requireDocPath(p);
    const key = this.find(abs) ?? abs;
    const open = this.openDocFor(key);
    let st: fs.Stats | null = null;
    try {
      st = await fs.promises.stat(key);
    } catch {
      st = null;
    }
    if (!open && !st) throw new FilesError(404, `File not found: ${abs}`);

    let dirty = false;
    if (open) {
      try {
        dirty = this.store.getInfo(open.docId).dirty;
      } catch {
        dirty = false;
      }
    }
    const thumbFile =
      this.dataDir && !dirty
        ? path.join(
            this.dataDir,
            'thumbs',
            `${createHash('sha1')
              .update(isWin ? key.toLowerCase() : key)
              .digest('hex')}-${width}.png`,
          )
        : undefined;
    if (thumbFile && st) {
      try {
        const ts = await fs.promises.stat(thumbFile);
        if (ts.mtimeMs >= st.mtimeMs) return await fs.promises.readFile(thumbFile);
      } catch {
        /* no cache */
      }
    }
    const jobKey = `${key}|${width}|${open ? this.store.getRevision(open.docId) : 'disk'}`;
    const running = this.thumbJobs.get(jobKey);
    if (running) return running;
    const job = this.renderThumb(key, width, render, open?.docId, thumbFile).finally(() =>
      this.thumbJobs.delete(jobKey),
    );
    this.thumbJobs.set(jobKey, job);
    return job;
  }

  private async renderThumb(
    key: string,
    width: number,
    render: RenderProvider,
    openId: string | undefined,
    thumbFile: string | undefined,
  ): Promise<Buffer> {
    let doc: Document;
    if (openId) {
      doc = this.store.get(openId);
    } else {
      try {
        doc = parseDocument(await fs.promises.readFile(key, 'utf8'));
      } catch (e) {
        throw new FilesError(
          400,
          `Could not read ${key}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const page = doc.pages.find((pg) => pg.frames.length > 0);
    const frame = page ? (page.frames.find((f) => !f.hidden) ?? page.frames[0]) : undefined;
    if (!frame) throw new FilesError(404, 'The document has no frames for the thumbnail.');
    const assetsDir = path.join(path.dirname(key), 'assets');
    let target = doc;
    if (!openId) {
      target = structuredClone(doc);
      const f = target.pages.flatMap((pg) => pg.frames).find((x) => x.id === frame.id)!;
      inlineAssets(f, assetsDir);
    }
    const r = await render.capture({
      doc: target,
      docId: doc.id,
      nodeId: frame.id,
      assetsDir: fs.existsSync(assetsDir) ? assetsDir : null,
      scale: 1,
      format: 'png',
      maxWidth: width,
    });
    if (thumbFile) {
      try {
        await fs.promises.mkdir(path.dirname(thumbFile), { recursive: true });
        const tmp = `${thumbFile}.${process.pid}.${tmpCounter++}.tmp`;
        await fs.promises.writeFile(tmp, r.data);
        await fs.promises.rename(tmp, thumbFile);
      } catch {
        /* cache is optional */
      }
    }
    return r.data;
  }
}

const MAX_INLINE_BYTES = 20 * 1024 * 1024;
const STYLE_URL = /url[(]\s*(["']?)((?:\.\/)?assets[/][^"')]+)\1\s*[)]/g;

/** Replaces, in the (already cloned) frame, relative `src` and `url(assets/...)` with data URLs from `assets/`. */
function inlineAssets(root: Node, assetsDir: string): void {
  let budget = MAX_INLINE_BYTES;
  const memo = new Map<string, string | undefined>();
  const load = (rel: string): string | undefined => {
    if (memo.has(rel)) return memo.get(rel);
    let url = assetDataUrl(assetsDir, rel);
    if (url && url.length * 0.75 > budget) url = undefined;
    if (url) budget -= url.length * 0.75;
    memo.set(rel, url);
    return url;
  };
  const visit = (n: Node): void => {
    const rel = assetPathOf(n.src);
    if (rel) {
      const url = load(rel);
      if (url) n.src = url;
    }
    for (const [k, v] of Object.entries(n.style)) {
      if (!v.includes('assets/')) continue;
      n.style[k] = v.replace(STYLE_URL, (m, _q: string, full: string) => {
        const url = load(full.replace(/^(\.\/)?assets\//, ''));
        return url ? `url("${url}")` : m;
      });
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
}

const indexes = new WeakMap<DocumentStore, FileIndex>();

/** File index of the store (one per store; subscribes to the events only once). */
export function getFileIndex(store: DocumentStore, dataDir?: string): FileIndex {
  let idx = indexes.get(store);
  if (!idx) {
    idx = new FileIndex(store, dataDir);
    indexes.set(store, idx);
  } else {
    idx.useDataDir(dataDir);
  }
  return idx;
}
