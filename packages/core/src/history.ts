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
   * Undo group (e.g. an assistant turn or a script run). Consecutive applications with
   * the same group become a single entry: one undo reverts them all.
   */
  group?: string;
}

export interface HistoryApplyOptions {
  /** Merges with the top entry if it has the same group and nothing happened between the two. */
  group?: string;
}

export class History {
  private current: Document;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private rev = 0;
  private readonly limit: number;
  /** Group of the last application, while it stays on top of the stack (undo/redo reset it). */
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
    // Version with idMap filled in (duplicateNodes) so that redo is deterministic.
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
      // Redo reapplies in order; undo reverts from the most recent to the oldest.
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

  /** Replaces the document (e.g. loading a file) and clears the stacks. */
  replace(doc: Document): void {
    this.current = doc;
    this.clear();
    this.rev++;
  }

  /** Closes the open group: the next application, even with the same group, becomes a new entry. */
  closeGroup(group?: string): void {
    if (group === undefined || this.openGroup === group) this.openGroup = undefined;
  }

  /** Top entry of the undo stack (read-only). */
  get top(): Readonly<HistoryEntry> | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  clear(): void {
    this.openGroup = undefined;
    this.undoStack = [];
    this.redoStack = [];
  }
}
