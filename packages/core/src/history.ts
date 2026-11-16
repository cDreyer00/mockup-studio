import { applyOps } from './apply.js';
import type { Op } from './ops.js';
import type { Document } from './types.js';

type Results = (Record<string, unknown> | undefined)[];

export interface HistoryEntry {
  ops: Op[];
  inverse: Op[];
  label?: string;
  at: string;
}

export class History {
  private current: Document;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private rev = 0;
  private readonly limit: number;

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
  ): { doc: Document; results: Results; inverse: Op[]; appliedOps: Op[] } {
    const r = applyOps(this.current, ops);
    // Versão com idMap preenchido (duplicateNodes) para que o redo seja determinístico.
    const appliedOps = ops.map((op, i) => {
      const filled = r.results[i]?.op as Op | undefined;
      return filled ?? op;
    });
    this.current = r.doc;
    this.undoStack.push({
      ops: appliedOps,
      inverse: r.inverse,
      label,
      at: new Date().toISOString(),
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.rev++;
    return { doc: r.doc, results: r.results, inverse: r.inverse, appliedOps };
  }

  undo(): { doc: Document; ops: Op[] } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const r = applyOps(this.current, entry.inverse);
    this.current = r.doc;
    this.redoStack.push(entry);
    this.rev++;
    return { doc: r.doc, ops: entry.inverse };
  }

  redo(): { doc: Document; ops: Op[] } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
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

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
