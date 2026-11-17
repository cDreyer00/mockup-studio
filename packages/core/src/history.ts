import { applyOps } from './apply.js';
import type { Op } from './ops.js';
import type { Document } from './types.js';

type Results = (Record<string, unknown> | undefined)[];

export interface HistoryEntry {
  ops: Op[];
  inverse: Op[];
  label?: string;
  at: string;
  /**
   * Grupo de undo (ex.: um turno do assistente ou uma execução de script). Aplicações seguidas com
   * o mesmo grupo viram uma única entrada: um undo desfaz todas.
   */
  group?: string;
}

export interface HistoryApplyOptions {
  /** Funde com a entrada do topo se ela for do mesmo grupo e nada tiver acontecido entre as duas. */
  group?: string;
}

export class History {
  private current: Document;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private rev = 0;
  private readonly limit: number;
  /** Grupo da última aplicação, enquanto ela continuar no topo da pilha (undo/redo zeram). */
  private openGroup: string | undefined;

  constructor(doc: Document, opts: { limit?: number } = {}) {
    this.current = doc;
    this.limit = opts.limit ?? 200;
  }

  get doc(): Document {
    return this.current;
  }

  get revision(): number {
    return this.rev;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  apply(
    ops: Op[],
    label?: string,
    opts: HistoryApplyOptions = {},
  ): { doc: Document; results: Results; inverse: Op[]; appliedOps: Op[]; merged: boolean } {
    const r = applyOps(this.current, ops);
    // Versão com idMap preenchido (duplicateNodes) para que o redo seja determinístico.
    const appliedOps = ops.map((op, i) => {
      const filled = r.results[i]?.op as Op | undefined;
      return filled ?? op;
    });
    this.current = r.doc;
    const top = this.undoStack[this.undoStack.length - 1];
    const merged =
      opts.group !== undefined &&
      top !== undefined &&
      top.group === opts.group &&
      this.openGroup === opts.group;
    if (merged) {
      // Redo reaplica na ordem; undo desfaz do mais recente para o mais antigo.
      top.ops = [...top.ops, ...appliedOps];
      top.inverse = [...r.inverse, ...top.inverse];
    } else {
      this.undoStack.push({
        ops: appliedOps,
        inverse: r.inverse,
        label,
        at: new Date().toISOString(),
        ...(opts.group !== undefined ? { group: opts.group } : {}),
      });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.openGroup = opts.group;
    this.redoStack = [];
    this.rev++;
    return { doc: r.doc, results: r.results, inverse: r.inverse, appliedOps, merged };
  }

  undo(): { doc: Document; ops: Op[] } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.openGroup = undefined;
    const r = applyOps(this.current, entry.inverse);
    this.current = r.doc;
    this.redoStack.push(entry);
    this.rev++;
    return { doc: r.doc, ops: entry.inverse };
  }

  redo(): { doc: Document; ops: Op[] } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.openGroup = undefined;
    const r = applyOps(this.current, entry.ops);
    this.current = r.doc;
    this.undoStack.push(entry);
    this.rev++;
    return { doc: r.doc, ops: entry.ops };
  }

  /** Substitui o documento (ex.: carregar arquivo) e limpa as pilhas. */
  replace(doc: Document): void {
    this.current = doc;
    this.clear();
    this.rev++;
  }

  /** Encerra o grupo aberto: a próxima aplicação, mesmo com o mesmo grupo, vira entrada nova. */
  closeGroup(group?: string): void {
    if (group === undefined || this.openGroup === group) this.openGroup = undefined;
  }

  /** Entrada do topo da pilha de undo (somente leitura). */
  get top(): Readonly<HistoryEntry> | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  clear(): void {
    this.openGroup = undefined;
    this.undoStack = [];
    this.redoStack = [];
  }
}
