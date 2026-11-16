import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  History,
  createDocument,
  parseDocument,
  serializeDocument,
  type Document,
  type Op,
  type OpSource,
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
  'doc:opened': [{ type: 'doc:opened'; info: OpenDocumentInfo; doc: Document }];
  'doc:changed': [
    {
      type: 'doc:changed';
      docId: string;
      ops: Op[];
      source: OpSource;
      revision: number;
      doc: Document;
    },
  ];
  'doc:saved': [{ type: 'doc:saved'; docId: string; path: string }];
  'doc:closed': [{ type: 'doc:closed'; docId: string }];
  'selection:changed': [
    { type: 'selection:changed'; docId: string; nodeIds: string[]; source: OpSource },
  ];
  'active:changed': [{ type: 'active:changed'; docId: string | null }];
}

export const STORE_EVENT_NAMES = [
  'doc:opened',
  'doc:changed',
  'doc:saved',
  'doc:closed',
  'selection:changed',
  'active:changed',
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
    this.emit('doc:opened', { type: 'doc:opened', info, doc });
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
    };
    const next = d.saveChain.then(run, run);
    d.saveChain = next.catch(() => undefined);
    await next;
    return file;
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
