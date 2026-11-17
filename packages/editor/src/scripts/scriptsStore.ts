/**
 * Draft and output of the scripts panel, per document (survives tab/document switches).
 * The code only goes to the daemon when run or saved to the library.
 */
import { create } from 'zustand';
import type { ScriptRunResult } from '@mockup/core';

export const DEFAULT_SCRIPT = `// API: doc.select('text'), doc.selection(), doc.frames(), doc.apply(op), doc.screenshot()...
// Ctrl+Enter runs; the 'return' value becomes the result.
return doc.selection().map((n) => n.name);
`;

export interface ScriptDraft {
  code: string;
  /** Name of the open library file (with .js) or null. */
  name: string | null;
  /** Code was changed since it was opened/saved. */
  dirty: boolean;
  output: ScriptRunResult | null;
}

export const NEW_DRAFT: ScriptDraft = {
  code: DEFAULT_SCRIPT,
  name: null,
  dirty: false,
  output: null,
};

interface ScriptsState {
  drafts: Record<string, ScriptDraft>;
}

export const useScripts = create<ScriptsState>(() => ({ drafts: {} }));

export const scriptsStore = {
  patch(docId: string, patch: Partial<ScriptDraft>): void {
    useScripts.setState((s) => ({
      drafts: { ...s.drafts, [docId]: { ...(s.drafts[docId] ?? NEW_DRAFT), ...patch } },
    }));
  },
  setCode(docId: string, code: string): void {
    const cur = useScripts.getState().drafts[docId] ?? NEW_DRAFT;
    if (cur.code === code) return;
    scriptsStore.patch(docId, { code, dirty: true });
  },
  /** Replaces the code with a loaded/generated/example one. */
  load(docId: string, code: string, name: string | null, dirty = false): void {
    scriptsStore.patch(docId, { code, name, dirty });
  },
};
