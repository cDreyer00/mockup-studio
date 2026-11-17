/**
 * Serviço de scripts: executa JavaScript do usuário na sandbox (um grupo de undo por execução),
 * mantém a biblioteca `scripts/*.js` ao lado do documento e gera scripts com o assistente.
 * Ver docs/SCRIPTS.md.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getDocumentSummary,
  type ClientMessage,
  type ScriptFileInfo,
  type ScriptRunResult,
} from '@mockup/core';
import type { RenderProvider } from '../render.js';
import type { AssistantServiceApi, ScriptRunOptions, ScriptServiceApi } from '../services.js';
import type { DocumentStore } from '../store.js';
import { ScriptHost } from './host.js';
import { SCRIPT_SYSTEM_PROMPT, extractScriptCode } from './prompt.js';
import { SANDBOX_LIMITS, runInSandbox, type SandboxOutcome } from './sandbox.js';

export interface ScriptServiceOptions {
  render?: RenderProvider;
  assistant?: AssistantServiceApi;
  /** Execuções simultâneas (cada uma é um worker com heap próprio). Padrão 4. */
  maxConcurrent?: number;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Nome de arquivo da biblioteca: letras, números, espaço, `_`, `.` e `-`; sem barras nem `..`;
 * `.js` é acrescentado. Lança `Error` em português se o nome for recusado.
 */
export function normalizeScriptName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Informe o nome do script (ex.: "renomear-botoes").');
  }
  let n = name.trim();
  if (/[\\/\0]/.test(n) || n.includes('..')) {
    throw new Error(`Nome de script inválido: "${name}". Não use "/", "\\" nem "..".`);
  }
  if (!/\.js$/i.test(n)) n += '.js';
  const base = n.slice(0, -3);
  if (
    !base ||
    n.length > 100 ||
    !/^[\p{L}\p{N}_ .-]+$/u.test(base) ||
    base.startsWith('.') ||
    /[ .]$/.test(base) ||
    RESERVED_NAMES.test(base)
  ) {
    throw new Error(
      `Nome de script inválido: "${name}". Use só letras, números, espaço, "_", "." e "-" (até 100 caracteres).`,
    );
  }
  return `${base}.js`;
}

export class ScriptService implements ScriptServiceApi {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly store: DocumentStore,
    readonly opts: ScriptServiceOptions = {},
  ) {}

  /* ---------- WebSocket ---------- */

  async handle(msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'script:run': {
        const sel = msg.selection;
        if (sel !== undefined && !(Array.isArray(sel) && sel.every((s) => typeof s === 'string'))) {
          throw new Error('script:run: "selection" deve ser um array de ids.');
        }
        return this.run(
          this.needString(msg.docId, 'docId'),
          this.needString(msg.code, 'code', true),
          {
            selection: sel,
            source: 'editor',
          },
        );
      }
      case 'script:list':
        return this.list(this.needString(msg.docId, 'docId'));
      case 'script:read':
        return this.read(this.needString(msg.docId, 'docId'), msg.name);
      case 'script:save':
        return this.save(
          this.needString(msg.docId, 'docId'),
          msg.name,
          this.needString(msg.code, 'code', true),
        );
      case 'script:delete':
        await this.remove(this.needString(msg.docId, 'docId'), msg.name);
        return {};
      case 'script:generate':
        return this.generate(
          this.needString(msg.docId, 'docId'),
          this.needString(msg.prompt, 'prompt'),
        );
      default:
        throw new Error(
          `Mensagem de script desconhecida: ${String((msg as { type?: unknown }).type)}`,
        );
    }
  }

  private needString(v: unknown, field: string, allowEmpty = false): string {
    if (typeof v !== 'string' || (!allowEmpty && !v.trim())) {
      throw new Error(`"${field}" é obrigatório (string).`);
    }
    return v;
  }

  /* ---------- execução ---------- */

  private async acquire(): Promise<void> {
    const max = Math.max(1, this.opts.maxConcurrent ?? 4);
    if (this.active < max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  async run(docId: string, code: string, opts: ScriptRunOptions = {}): Promise<ScriptRunResult> {
    const id = this.store.resolveDocId(docId || undefined);
    const ownsGroup = opts.group === undefined;
    const group = opts.group ?? `script:${randomUUID()}`;
    const { signal } = opts;
    const alive = (): boolean => {
      if (signal?.aborted) return false;
      try {
        return opts.alive ? opts.alive() !== false : true;
      } catch {
        return false;
      }
    };
    const host = new ScriptHost({
      store: this.store,
      docId: id,
      selection: opts.selection,
      group,
      source: opts.source ?? 'editor',
      render: this.opts.render,
      alive,
    });
    const started = Date.now();
    let out: SandboxOutcome;
    await this.acquire();
    try {
      out = await runInSandbox(typeof code === 'string' ? code : '', (m, a) => host.call(m, a), {
        timeoutMs: opts.timeoutMs,
        signal,
        alive: opts.alive ? alive : undefined,
      });
    } finally {
      host.closed = true;
      this.release();
      // Só fecha o grupo que esta execução abriu: o de um turno do assistente continua dele.
      if (ownsGroup) this.store.closeGroup(id, group);
    }
    let result: unknown;
    if (out.resultJson !== undefined) {
      try {
        result = JSON.parse(out.resultJson);
      } catch {
        result = undefined;
      }
    }
    return {
      ok: out.ok,
      logs: out.logs,
      ...(result !== undefined ? { result } : {}),
      ...(out.error !== undefined ? { error: out.error } : {}),
      images: host.images,
      opsCount: host.opsCount,
      durationMs: Date.now() - started,
    };
  }

  /* ---------- biblioteca scripts/*.js ---------- */

  /** Pasta `scripts/` ao lado do arquivo do documento (`null` se o documento não tem caminho). */
  private dirOf(docId: string): string | null {
    const info = this.store.getInfo(this.store.resolveDocId(docId || undefined));
    return info.path ? path.join(path.dirname(info.path), 'scripts') : null;
  }

  private needDir(docId: string): string {
    const dir = this.dirOf(docId);
    if (!dir) {
      throw new Error(
        'O documento ainda não tem um arquivo: salve-o (dê um caminho) para usar a biblioteca de scripts (pasta scripts/ ao lado dele).',
      );
    }
    return dir;
  }

  private fileOf(dir: string, name: unknown): { name: string; file: string } {
    const n = normalizeScriptName(name);
    const file = path.join(dir, n);
    const rel = path.relative(dir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel !== n) {
      throw new Error(`Nome de script inválido: "${String(name)}".`);
    }
    return { name: n, file };
  }

  async list(docId: string): Promise<{ dir: string | null; scripts: ScriptFileInfo[] }> {
    const dir = this.dirOf(docId);
    if (!dir) return { dir: null, scripts: [] };
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { dir, scripts: [] };
      throw e;
    }
    const scripts: ScriptFileInfo[] = [];
    for (const n of names) {
      if (!/\.js$/i.test(n)) continue;
      try {
        if (normalizeScriptName(n) !== n) continue;
      } catch {
        continue;
      }
      const st = await fs.stat(path.join(dir, n)).catch(() => null);
      if (st?.isFile()) scripts.push({ name: n, size: st.size, updatedAt: st.mtime.toISOString() });
    }
    scripts.sort((a, b) => a.name.localeCompare(b.name, 'pt'));
    return { dir, scripts };
  }

  async read(docId: string, name: string): Promise<{ name: string; code: string }> {
    const { name: n, file } = this.fileOf(this.needDir(docId), name);
    try {
      return { name: n, code: await fs.readFile(file, 'utf8') };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Script "${n}" não encontrado. Veja a lista com list_scripts.`);
      }
      throw e;
    }
  }

  async save(docId: string, name: string, code: string): Promise<{ name: string }> {
    const dir = this.needDir(docId);
    if (typeof code !== 'string') throw new Error('O código do script deve ser uma string.');
    if (code.length > SANDBOX_LIMITS.maxCodeChars) {
      throw new Error(
        `O script é grande demais (limite ${SANDBOX_LIMITS.maxCodeChars} caracteres).`,
      );
    }
    const { name: n, file } = this.fileOf(dir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, code, 'utf8');
    return { name: n };
  }

  async remove(docId: string, name: string): Promise<void> {
    const { name: n, file } = this.fileOf(this.needDir(docId), name);
    try {
      await fs.unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Script "${n}" não encontrado.`);
      }
      throw e;
    }
  }

  /* ---------- gerar com IA ---------- */

  async generate(docId: string, prompt: string): Promise<{ code: string }> {
    const assistant = this.opts.assistant;
    if (!assistant) {
      throw new Error(
        'Gerar scripts com IA exige o assistente, que não está disponível neste daemon.',
      );
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Descreva o que o script deve fazer.');
    }
    const id = this.store.resolveDocId(docId || undefined);
    const doc = this.store.get(id);
    const summary = getDocumentSummary(doc, 2);
    const selection = this.store.getSelection(id);
    const context = [
      'Documento atual (resumo):',
      summary.length > 6000 ? `${summary.slice(0, 6000)}\n…` : summary,
      selection.length ? `Seleção no editor: ${selection.join(', ')}` : 'Nada selecionado.',
    ].join('\n');
    const text = await assistant.generateText(`${prompt.trim()}\n\n${context}`, {
      system: SCRIPT_SYSTEM_PROMPT,
    });
    const code = extractScriptCode(text);
    if (!code)
      throw new Error('O assistente não devolveu código. Tente descrever o pedido de outro jeito.');
    return { code };
  }
}
