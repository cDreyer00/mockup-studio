/**
 * Índice de arquivos do Mockup Studio (`files.json` na pasta de dados): pastas virtuais aninhadas,
 * tags, favoritos e busca (nome, tag e conteúdo) dos documentos conhecidos, mais as miniaturas.
 * Um índice por `DocumentStore` (`getFileIndex`), que acompanha os eventos do store.
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
  /** Pasta (`Clientes/Acme`); vazio/ausente = todos; `/` = só os sem pasta. */
  folder?: string | null;
  tag?: string;
  query?: string;
  favorites?: boolean;
  /** Inclui os arquivos das subpastas de `folder`. */
  recursive?: boolean;
}

export interface FileMetaChange {
  folder?: string | null;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  favorite?: boolean;
}

/** Erro causado pelo pedido (caminho inválido, pasta inexistente...): a camada HTTP devolve o 4xx. */
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

/** Normaliza o caminho de uma pasta virtual: barras normais, sem vazios nem `.`/`..`. `''` = raiz. */
export function normalizeFolder(input: string): string {
  const parts = input
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..')) {
    throw new FilesError(
      400,
      `Caminho de pasta inválido: "${input}". Use nomes separados por "/", sem "." nem "..". Ex.: "Clientes/Acme".`,
    );
  }
  return parts.join('/');
}

/** Tags sem espaços nas pontas, sem vazias e sem duplicatas (sem diferenciar caixa/acento). */
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
  /** Revisão do documento aberto (arquivos fechados usam -1). */
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

  /** Passa a usar `dataDir` (lê o `files.json`); só vale se ainda não havia pasta de dados. */
  useDataDir(dataDir?: string): void {
    if (!dataDir || this.dataDir) return;
    this.dataDir = dataDir;
    const loaded = this.readDisk();
    // o que já estava em memória (arquivos abertos antes da pasta de dados) vence
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
          /* pasta inválida ignorada */
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

  /** Grava o estado atual (temporário + rename, em fila: nenhuma escrita se perde). */
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
          '[mockup-daemon] falha ao gravar o files.json:',
          e instanceof Error ? e.message : e,
        );
      }
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  /** Espera as gravações pendentes. */
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

  /** Registra o arquivo (aberto/criado/salvo). `opened` atualiza `lastOpenedAt`. */
  private touch(p: string, opened: boolean): void {
    if (!p.toLowerCase().endsWith(DOCUMENT_EXT)) return;
    const { meta, created } = this.ensure(p);
    if (opened) meta.lastOpenedAt = new Date().toISOString();
    if (created || opened) void this.persist();
  }

  /* ---------- pastas ---------- */

  /** Pastas existentes: as criadas e as ancestrais das usadas por arquivos. */
  folders(): string[] {
    const set = new Set<string>();
    for (const f of this.data.folders) for (const a of ancestorsOf(f)) set.add(a);
    for (const m of Object.values(this.data.files)) {
      if (m.folder) for (const a of ancestorsOf(m.folder)) set.add(a);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  async createFolder(p: string): Promise<string[]> {
    const f = normalizeFolder(p);
    if (!f) throw new FilesError(400, 'Informe o nome da pasta. Ex.: "Clientes/Acme".');
    for (const a of ancestorsOf(f)) if (!this.data.folders.includes(a)) this.data.folders.push(a);
    await this.persist();
    return this.folders();
  }

  async renameFolder(from: string, to: string): Promise<string[]> {
    const src = normalizeFolder(from);
    const dst = normalizeFolder(to);
    if (!src || !dst) throw new FilesError(400, 'Informe a pasta de origem e o novo caminho (to).');
    if (!this.folders().includes(src))
      throw new FilesError(404, `Pasta não encontrada: "${src}". Veja as pastas com list_files.`);
    if (src === dst) return this.folders();
    if (inside(dst, src))
      throw new FilesError(400, `Não dá para mover "${src}" para dentro dela mesma ("${dst}").`);
    if (this.folders().includes(dst))
      throw new FilesError(
        409,
        `Já existe a pasta "${dst}". Escolha outro nome ou mova os arquivos com move_files.`,
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
    if (!f) throw new FilesError(400, 'Informe a pasta a excluir. Ex.: "Clientes/Acme".');
    if (!this.folders().includes(f))
      throw new FilesError(404, `Pasta não encontrada: "${f}". Veja as pastas com list_files.`);
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

  /* ---------- arquivos ---------- */

  /** Caminho absoluto de um `.mockup.json` (400 caso contrário). */
  static requireDocPath(p: unknown): string {
    if (typeof p !== 'string' || !p.trim())
      throw new FilesError(400, 'Informe o caminho absoluto do arquivo (path).');
    if (!path.isAbsolute(p))
      throw new FilesError(
        400,
        `O caminho precisa ser absoluto: "${p}". Ex.: "C:/projetos/site.mockup.json".`,
      );
    if (!p.toLowerCase().endsWith(DOCUMENT_EXT))
      throw new FilesError(400, `O arquivo precisa terminar em ${DOCUMENT_EXT}: "${p}".`);
    return path.resolve(p);
  }

  async setMeta(p: string, change: FileMetaChange): Promise<FileEntry> {
    const abs = FileIndex.requireDocPath(p);
    const known = this.find(abs) !== undefined;
    const isOpen = this.store.list().some((d) => d.path && sameKey(path.resolve(d.path), abs));
    if (!known && !isOpen && !fs.existsSync(abs))
      throw new FilesError(404, `Arquivo não encontrado: ${abs}`);
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

  /** Registra um arquivo `.mockup.json` ou os que estiverem numa pasta (até 2 níveis). */
  async add(p: string): Promise<FileEntry[]> {
    if (typeof p !== 'string' || !path.isAbsolute(p))
      throw new FilesError(
        400,
        `Informe um caminho absoluto de arquivo ou pasta. Recebido: "${p}".`,
      );
    const abs = path.resolve(p);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      throw new FilesError(404, `Caminho não encontrado: ${abs}`);
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
      throw new FilesError(400, `Use um arquivo ${DOCUMENT_EXT} ou uma pasta: "${abs}".`);
    }
    let changed = false;
    for (const f of found) if (this.ensure(f).created) changed = true;
    if (changed) await this.persist();
    return this.entries(found);
  }

  /* ---------- leitura ---------- */

  /** Se o caminho está no índice, nos recentes ou aberto (o que a tela inicial mostra). */
  isKnown(p: string): boolean {
    const abs = path.resolve(p);
    if (this.find(abs)) return true;
    if (readRecent(this.dataDir).some((r) => sameKey(path.resolve(r), abs))) return true;
    return !!this.openDocFor(abs);
  }

  /** Entrada do arquivo, se o caminho estiver no índice, aberto ou nos recentes. */
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

  /** Monta as entradas dos caminhos dados (sem filtro). */
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

  /** Lista os arquivos conhecidos (índice, recentes e abertos) com os filtros. */
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
      return a.name.localeCompare(b.name, 'pt-BR');
    });

    const allTags = new Map<string, string>();
    for (const m of Object.values(this.data.files)) {
      for (const t of m.tags) if (!allTags.has(foldText(t))) allTags.set(foldText(t), t);
    }
    return {
      files,
      folders: this.folders(),
      tags: [...allTags.values()].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    };
  }

  /* ---------- miniaturas ---------- */

  /**
   * PNG do primeiro frame visível da primeira página com frames. Documento fechado: imagens e
   * `url(assets/...)` do frame viram data URLs (a página de render só serve `/assets/<docId>/`
   * de documentos abertos; limite de ~20 MB no total). Limitação: fontes embutidas
   * (`source: 'file'`) de documentos fechados não são carregadas (a miniatura usa a fonte de
   * reserva). Cache em `<dataDir>/thumbs/<sha1(path)>-<w>.png`, invalidado pelo mtime do arquivo.
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
    if (!open && !st) throw new FilesError(404, `Arquivo não encontrado: ${abs}`);

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
        /* sem cache */
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
          `Não foi possível ler ${key}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const page = doc.pages.find((pg) => pg.frames.length > 0);
    const frame = page ? (page.frames.find((f) => !f.hidden) ?? page.frames[0]) : undefined;
    if (!frame) throw new FilesError(404, 'O documento não tem frames para a miniatura.');
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
        /* cache é opcional */
      }
    }
    return r.data;
  }
}

const MAX_INLINE_BYTES = 20 * 1024 * 1024;
const STYLE_URL = /url[(]\s*(["']?)((?:\.\/)?assets[/][^"')]+)\1\s*[)]/g;

/** Troca, no frame (já clonado), `src` relativos e `url(assets/...)` por data URLs de `assets/`. */
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

/** Índice de arquivos do store (um por store; assina os eventos uma única vez). */
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
