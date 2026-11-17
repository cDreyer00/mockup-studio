/**
 * Memos compartilhados do relatório de tokens e do escopo de variáveis por nó. Durante arrastes o
 * `doc` muda a cada quadro, mas o store é imutável: `tokens`, `tokenMeta`, `themes` e `pages`
 * mantêm a identidade quando nada neles mudou, então basta comparar as referências.
 */
import { getTokenReport, scopeVarsFor } from '@mockup/core';
import type { Document, TokenReport } from '@mockup/core';

interface Entry {
  tokens: Document['tokens'];
  tokenMeta: Document['tokenMeta'];
  themes: Document['themes'];
  pages: Document['pages'] | null;
  report: TokenReport;
}

const same = (e: Entry | null, doc: Document, pages: Document['pages'] | null): e is Entry =>
  e !== null &&
  e.tokens === doc.tokens &&
  e.tokenMeta === doc.tokenMeta &&
  e.themes === doc.themes &&
  e.pages === pages;

let full: Entry | null = null;
let list: Entry | null = null;

/** Relatório completo (uso, quebrados, temas); reaproveitado enquanto tokens, metas, temas e páginas forem os mesmos. */
export function tokenReportFor(doc: Document): TokenReport {
  if (same(full, doc, doc.pages)) return full.report;
  const { tokens, tokenMeta, themes, pages } = doc;
  const report = getTokenReport(doc);
  full = { tokens, tokenMeta, themes, pages, report };
  return report;
}

/**
 * Relatório sem varrer os nós (`usage`, `unused`, `broken` e `frames` ficam vazios): serve a quem só
 * precisa da lista de tokens (seletor). Depende só de tokens, metas e temas, não de `pages`.
 */
export function tokenListFor(doc: Document): TokenReport {
  if (same(list, doc, null)) return list.report;
  const { tokens, tokenMeta, themes } = doc;
  const report = getTokenReport({ ...doc, pages: [] });
  list = { tokens, tokenMeta, themes, pages: null, report };
  return report;
}

const scopes = new WeakMap<Document, Map<string, Record<string, string>>>();

/** Variáveis vistas por um nó, em cache por documento e nó (vários campos ligados partilham o cálculo). */
export function nodeScopeVars(doc: Document, nodeId: string): Record<string, string> {
  let byNode = scopes.get(doc);
  if (!byNode) scopes.set(doc, (byNode = new Map()));
  let vars = byNode.get(nodeId);
  if (!vars) byNode.set(nodeId, (vars = scopeVarsFor(doc, nodeId)));
  return vars;
}
