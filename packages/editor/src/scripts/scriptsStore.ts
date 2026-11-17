/**
 * Rascunho e saída do painel de scripts, por documento (sobrevive à troca de aba/documento).
 * O código só vai ao daemon ao executar ou salvar na biblioteca.
 */
import { create } from 'zustand';
import type { ScriptRunResult } from '@mockup/core';

export const DEFAULT_SCRIPT = `// API: doc.select('text'), doc.selection(), doc.frames(), doc.apply(op), doc.screenshot()...
// Ctrl+Enter executa; o valor de 'return' vira o resultado.
return doc.selection().map((n) => n.name);
`;

export interface ScriptDraft {
  code: string;
  /** Nome do arquivo da biblioteca aberto (com .js) ou null. */
  name: string | null;
  /** Código foi alterado desde que abriu/salvou. */
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
  /** Substitui o código por um carregado/gerado/exemplo. */
  load(docId: string, code: string, name: string | null, dirty = false): void {
    scriptsStore.patch(docId, { code, name, dirty });
  },
};
