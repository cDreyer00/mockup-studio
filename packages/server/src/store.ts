import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  History,
  assertPublicOps,
  createDocument,
  parseDocument,
  serializeDocument,
  walk,
  type Document,
  type Op,
  type OpSource,
  type HistoryState,
  type OpenDocumentInfo,
} from '@mockup/core';
import { addRecent, normalizeDocumentPath } from './paths.js';

let tmpCounter = 0;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OpenDoc {
  id: string;
  name: string;
  path: string | null;
  history: History;
  dirty: boolean;
  saveTimer: NodeJS.Timeout | null;
  /** Cadeia de gravações do documento: nunca há duas gravações simultâneas no mesmo arquivo. */
  saveChain: Promise<void>;
}

export interface StoreEvents {
  'doc:opened': [
    { type: 'doc:opened'; info: OpenDocumentInfo; doc: Document; history: HistoryState },
  ];
  'doc:changed': [
    {
      type: 'doc:changed';
      docId: string;
      ops: Op[];
      source: OpSource;
      revision: number;
      doc: Document;
      history: HistoryState;
    },
  ];
  'doc:saved': [{ type: 'doc:saved'; docId: string; path: string }];
  'doc:closed': [{ type: 'doc:closed'; docId: string }];
  'selection:changed': [
    { type: 'selection:changed'; docId: string; nodeIds: string[]; source: OpSource },
  ];
  'active:changed': [{ type: 'active:changed'; docId: string | null }];
  'agent:finished': [{ type: 'agent:finished'; docId: string; nodeIds: string[] }];
}

export const STORE_EVENT_NAMES = [
  'doc:opened',
  'doc:changed',
  'doc:saved',
  'doc:closed',
  'selection:changed',
  'active:changed',
  'agent:finished',
] as const;

export interface ApplyOutcome {
  doc: Document;
  results: (Record<string, unknown> | undefined)[];
  appliedOps: Op[];
  revision: number;
}

export const AUTOSAVE_MS = 800;

/**
 * Erro causado pelo pedido do usuário (arquivo inexistente, já existe, documento desconhecido).
 * `expose` e `status` permitem que a camada HTTP devolva 4xx com a mensagem em vez de 500.
 */
async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Copia `from` para `to` sem sobrescrever: arquivo idêntico no destino é reaproveitado; de conteúdo
 * diferente ganha nome novo (-1, -2...). Devolve o mapa origem -> destino só dos renomeados.
 */
async function copyAssetsNoClobber(from: string, to: string): Promise<Map<string, string>> {
  const renamed = new Map<string, string>();
  for (const rel of await listFiles(from)) {
    const bytes = await fs.promises.readFile(path.join(from, rel));
    const ext = path.posix.extname(rel);
    const base = rel.slice(0, rel.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const target = i === 0 ? rel : `${base}-${i}${ext}`;
      const file = path.join(to, target);
      let existing: Buffer | null = null;
      try {
        existing = await fs.promises.readFile(file);
      } catch {
        existing = null;
      }
      if (existing && existing.equals(bytes)) {
        if (i > 0) renamed.set(rel, target);
        break;
      }
      if (!existing) {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, bytes, { flag: 'wx' });
        if (i > 0) renamed.set(rel, target);
        break;
      }
    }
  }
  return renamed;
}

/** Ops que apontam nós image, estilos url(assets/...) e fontes para os arquivos renomeados. */
function renameOps(doc: Document, renamed: Map<string, string>): Op[] {
  const srcs: { nodeId: string; src: string }[] = [];
  const styles: { nodeId: string; set: Record<string, string> }[] = [];
  walk(doc, (n) => {
    const to = n.src ? renamed.get(n.src) : undefined;
    if (n.src && to) srcs.push({ nodeId: n.id, src: to });
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.style)) {
      const nv = v.replace(
        /url[(] *(["']?)assets[/]([^"')]+)["']? *[)]/g,
        (m, q: string, rel: string) =>
          renamed.has(rel) ? `url(${q}assets/${renamed.get(rel)}${q})` : m,
      );
      if (nv !== v) set[k] = nv;
    }
    if (Object.keys(set).length) styles.push({ nodeId: n.id, set });
  });
  const ops: Op[] = [];
  if (srcs.length) ops.push({ type: 'setSrc', changes: srcs });
  if (styles.length) ops.push({ type: 'updateStyles', changes: styles });
  if (doc.fonts.some((f) => f.files?.some((x) => renamed.has(x)))) {
    ops.push({
      type: 'setFonts',
      fonts: doc.fonts.map((f) => ({ ...f, files: f.files?.map((x) => renamed.get(x) ?? x) })),
    });
  }
  return ops;
}

export class StoreError extends Error {
  readonly expose = true;
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export class DocumentStore extends EventEmitter<StoreEvents> {
  private docs = new Map<string, OpenDoc>();
  private selection = new Map<string, string[]>();
  activeDocId: string | null = null;

  constructor(private readonly opts: { dataDir?: string; autosaveMs?: number } = {}) {
    super();
  }

  private info(d: OpenDoc): OpenDocumentInfo {
    return {
      docId: d.id,
      name: d.history.doc.name,
      path: d.path,
      dirty: d.dirty,
      revision: d.history.revision,
    };
  }

  historyState(d: OpenDoc): HistoryState {
    return { canUndo: d.history.canUndo, canRedo: d.history.canRedo };
  }

  private entry(docId: string): OpenDoc {
    const d = this.docs.get(docId);
    if (!d)
      throw new StoreError(
        404,
        `Documento não encontrado: ${docId}. Use list_documents para ver os abertos.`,
      );
    return d;
  }

  private register(doc: Document, filePath: string | null): OpenDocumentInfo & { doc: Document } {
    if (this.docs.has(doc.id)) {
      throw new StoreError(
        409,
        `Já existe outro documento aberto com o id ${doc.id}. Feche-o antes de abrir esta cópia.`,
      );
    }
    const d: OpenDoc = {
      id: doc.id,
      name: doc.name,
      path: filePath,
      history: new History(doc, { limit: 200 }),
      dirty: false,
      saveTimer: null,
      saveChain: Promise.resolve(),
    };
    this.docs.set(d.id, d);
    this.selection.set(d.id, []);
    const info = this.info(d);
    this.emit('doc:opened', {
      type: 'doc:opened',
      info,
      doc,
      history: this.historyState(d),
    });
    this.setActive(d.id);
    if (filePath) addRecent(filePath, this.opts.dataDir);
    return { ...info, doc };
  }

  async open(p: string): Promise<OpenDocumentInfo & { doc: Document }> {
    const abs = path.resolve(p);
    for (const d of this.docs.values()) {
      if (d.path && path.resolve(d.path) === abs) {
        this.setActive(d.id);
        return { ...this.info(d), doc: d.history.doc };
      }
    }
    let raw: string;
    try {
      raw = await fs.promises.readFile(abs, 'utf8');
    } catch {
      throw new StoreError(404, `Não foi possível ler o arquivo: ${abs}`);
    }
    let doc: Document;
    try {
      doc = parseDocument(raw);
    } catch (e) {
      throw new StoreError(400, `${abs}: ${(e as Error).message}`);
    }
    return this.register(doc, abs);
  }

  async create(p: string, name: string): Promise<OpenDocumentInfo & { doc: Document }> {
    const abs = normalizeDocumentPath(p);
    const doc = createDocument(name);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(abs, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new StoreError(
          409,
          `O arquivo já existe: ${abs}. Abra-o em vez de criar (open_document ou \`mockup open\`).`,
        );
      throw new StoreError(
        400,
        `Não foi possível criar o arquivo ${abs}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
      );
    }
    try {
      await fh.writeFile(serializeDocument(doc), 'utf8');
    } finally {
      await fh.close();
    }
    return this.register(doc, abs);
  }

  async close(docId: string): Promise<void> {
    const d = this.entry(docId);
    if (d.saveTimer) clearTimeout(d.saveTimer);
    d.saveTimer = null;
    if (d.dirty && d.path) await this.save(docId);
    this.docs.delete(docId);
    this.selection.delete(docId);
    this.emit('doc:closed', { type: 'doc:closed', docId });
    if (this.activeDocId === docId) {
      const next = [...this.docs.keys()].pop() ?? null;
      this.activeDocId = next;
      this.emit('active:changed', { type: 'active:changed', docId: next });
    }
  }

  private async writeFile(file: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const rand = Math.random().toString(36).slice(2, 8);
    const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.${rand}.tmp`;
    try {
      await fs.promises.writeFile(tmp, content, 'utf8');
      const delays = [50, 100, 200];
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.promises.rename(tmp, file);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code ?? '';
          if (!RENAME_RETRY_CODES.has(code) || attempt >= delays.length) throw e;
          await sleep(delays[attempt]!);
        }
      }
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async save(docId?: string): Promise<string> {
    const d = this.entry(this.resolveDocId(docId));
    if (!d.path)
      throw new StoreError(400, 'Documento sem caminho em disco; não é possível salvar.');
    if (d.saveTimer) {
      clearTimeout(d.saveTimer);
      d.saveTimer = null;
    }
    const file = d.path;
    const run = async (): Promise<void> => {
      // o snapshot é tomado quando chega a vez na fila, para gravar o estado mais recente
      const revision = d.history.revision;
      await this.writeFile(file, serializeDocument(d.history.doc));
      if (d.history.revision === revision) d.dirty = false;
      this.emit('doc:saved', { type: 'doc:saved', docId: d.id, path: file });
      addRecent(file, this.opts.dataDir);
    };
    const next = d.saveChain.then(run, run);
    d.saveChain = next.catch(() => undefined);
    await next;
    return file;
  }

  /**
   * "Salvar como": grava em outro caminho (sobrescreve; o diálogo nativo já confirmou), copia o
   * conteúdo de `assets/` para ao lado do novo arquivo (sem apagar o antigo nem sobrescrever
   * arquivos existentes no destino) e passa a apontar o documento para o novo caminho.
   */
  async saveAs(docId: string | undefined, newPath: string): Promise<OpenDocumentInfo> {
    const d = this.entry(this.resolveDocId(docId));
    const abs = normalizeDocumentPath(newPath);
    const same = (a: string, b: string): boolean =>
      process.platform === 'win32'
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
        : path.resolve(a) === path.resolve(b);
    for (const other of this.docs.values()) {
      if (other.id !== d.id && other.path && same(other.path, abs)) {
        throw new StoreError(
          409,
          `Já há outro documento aberto neste caminho: ${abs}. Feche-o antes de salvar por cima.`,
        );
      }
    }
    if (d.saveTimer) {
      clearTimeout(d.saveTimer);
      d.saveTimer = null;
    }
    const oldAssets = d.path ? path.join(path.dirname(d.path), 'assets') : null;
    const newAssets = path.join(path.dirname(abs), 'assets');
    const run = async (): Promise<void> => {
      const revision = d.history.revision;
      await this.writeFile(abs, serializeDocument(d.history.doc));
      let renamed: Map<string, string> | null = null;
      if (oldAssets && !same(oldAssets, newAssets) && fs.existsSync(oldAssets)) {
        renamed = await copyAssetsNoClobber(oldAssets, newAssets);
      }
      d.path = abs;
      if (renamed && renamed.size > 0) {
        // Referências reescritas numa única entrada de histórico, e o arquivo é regravado com elas.
        const ops = renameOps(d.history.doc, renamed);
        if (ops.length > 0) {
          d.history.apply(ops, 'Salvar como: assets renomeados');
          this.markChanged(d, ops, 'system');
          if (d.saveTimer) {
            clearTimeout(d.saveTimer);
            d.saveTimer = null;
          }
          await this.writeFile(abs, serializeDocument(d.history.doc));
          d.dirty = false;
        }
      }
      if (d.history.revision === revision) d.dirty = false;
      this.emit('doc:saved', { type: 'doc:saved', docId: d.id, path: abs });
      addRecent(abs, this.opts.dataDir);
    };
    const next = d.saveChain.then(run, run);
    d.saveChain = next.catch(() => undefined);
    await next;
    return this.info(d);
  }

  list(): OpenDocumentInfo[] {
    return [...this.docs.values()].map((d) => this.info(d));
  }

  get(docId: string): Document {
    return this.entry(docId).history.doc;
  }

  getInfo(docId: string): OpenDocumentInfo {
    return this.info(this.entry(docId));
  }

  getActive(): OpenDoc | null {
    return this.activeDocId ? (this.docs.get(this.activeDocId) ?? null) : null;
  }

  setActive(docId: string): void {
    this.entry(docId);
    if (this.activeDocId === docId) return;
    this.activeDocId = docId;
    this.emit('active:changed', { type: 'active:changed', docId });
  }

  resolveDocId(docId?: string): string {
    if (docId) {
      this.entry(docId);
      return docId;
    }
    if (this.activeDocId && this.docs.has(this.activeDocId)) return this.activeDocId;
    throw new StoreError(
      400,
      'Nenhum documento aberto. Use open_document(path) ou create_document(path, name).',
    );
  }

  private markChanged(d: OpenDoc, ops: Op[], source: OpSource): void {
    d.dirty = true;
    this.scheduleSave(d);
    this.emit('doc:changed', {
      type: 'doc:changed',
      docId: d.id,
      ops,
      source,
      revision: d.history.revision,
      doc: d.history.doc,
      history: this.historyState(d),
    });
  }

  private scheduleSave(d: OpenDoc): void {
    if (!d.path) return;
    if (d.saveTimer) clearTimeout(d.saveTimer);
    d.saveTimer = setTimeout(() => {
      d.saveTimer = null;
      this.save(d.id).catch((e: unknown) => {
        console.error(
          '[mockup-daemon] falha no salvamento automático:',
          e instanceof Error ? e.message : e,
        );
      });
    }, this.opts.autosaveMs ?? AUTOSAVE_MS);
    d.saveTimer.unref();
  }

  applyOps(docId: string, ops: Op[], opts: { source: OpSource; label?: string }): ApplyOutcome {
    const d = this.entry(docId);
    // Entrada pública (editor pelo WS, ferramentas do MCP): sem campos internos (ex. `force`).
    assertPublicOps(ops);
    const r = d.history.apply(ops, opts.label);
    this.markChanged(d, r.appliedOps, opts.source);
    return {
      doc: r.doc,
      results: r.results,
      appliedOps: r.appliedOps,
      revision: d.history.revision,
    };
  }

  undo(
    docId: string | undefined,
    source: OpSource,
  ): { doc: Document; ops: Op[]; revision: number } | null {
    const d = this.entry(this.resolveDocId(docId));
    const r = d.history.undo();
    if (!r) return null;
    this.markChanged(d, r.ops, source);
    return { doc: r.doc, ops: r.ops, revision: d.history.revision };
  }

  redo(
    docId: string | undefined,
    source: OpSource,
  ): { doc: Document; ops: Op[]; revision: number } | null {
    const d = this.entry(this.resolveDocId(docId));
    const r = d.history.redo();
    if (!r) return null;
    this.markChanged(d, r.ops, source);
    return { doc: r.doc, ops: r.ops, revision: d.history.revision };
  }

  getSelection(docId: string): string[] {
    this.entry(docId);
    return this.selection.get(docId) ?? [];
  }

  setSelection(docId: string, nodeIds: string[], source: OpSource): void {
    this.entry(docId);
    this.selection.set(docId, [...nodeIds]);
    this.emit('selection:changed', {
      type: 'selection:changed',
      docId,
      nodeIds: [...nodeIds],
      source,
    });
  }

  /** O agente terminou de editar estes nós (vazio = documento inteiro); o editor apaga o badge. */
  finishWorking(docId: string, nodeIds: string[]): void {
    this.entry(docId);
    this.emit('agent:finished', { type: 'agent:finished', docId, nodeIds: [...nodeIds] });
  }

  getRevision(docId: string): number {
    return this.entry(docId).history.revision;
  }

  assetsDir(docId: string): string | null {
    const d = this.entry(docId);
    return d.path ? path.join(path.dirname(d.path), 'assets') : null;
  }

  async closeAll(): Promise<void> {
    for (const d of [...this.docs.values()]) {
      if (d.saveTimer) {
        clearTimeout(d.saveTimer);
        d.saveTimer = null;
      }
      if (d.dirty && d.path) {
        try {
          await this.save(d.id);
        } catch (e) {
          console.error(
            '[mockup-daemon] falha ao salvar',
            d.path,
            e instanceof Error ? e.message : e,
          );
        }
      }
    }
  }
}
