import type { Document } from '../types.js';

export interface TailwindExportOptions {
  /** Nós a exportar (padrão: frames da página `pageId` ou da primeira página). */
  nodeIds?: string[];
  pageId?: string;
  title?: string;
  /** `true`: só o markup (sem `<!doctype>`/`<head>`). Padrão `false` (documento completo). */
  fragment?: boolean;
}

export interface TailwindMapping {
  /** Classes Tailwind v4 equivalentes. */
  classes: string[];
  /** Propriedades sem classe equivalente (já cobertas por `[prop:valor]` em `classes` quando possível). */
  rest: Record<string, string>;
}

/** Converte um objeto de estilo CSS (kebab-case) em classes Tailwind v4. */
export function cssToTailwind(
  _style: Record<string, string>,
  _opts: { tokens?: Record<string, string> } = {},
): TailwindMapping {
  throw new Error('cssToTailwind: não implementado');
}

/** HTML com `class` Tailwind v4 (documento completo ou fragmento). */
export function exportTailwind(_doc: Document, _options: TailwindExportOptions = {}): string {
  throw new Error('exportTailwind: não implementado');
}
