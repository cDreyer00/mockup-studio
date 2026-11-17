/**
 * Shared memos for the token report and the per-node variable scope. During drags the
 * `doc` changes every frame, but the store is immutable: `tokens`, `tokenMeta`, `themes` and `pages`
 * keep their identity when nothing in them changed, so comparing the references is enough.
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

/** Full report (usage, broken, themes); reused as long as tokens, metas, themes and pages stay the same. */
export function tokenReportFor(doc: Document): TokenReport {
  if (same(full, doc, doc.pages)) return full.report;
  const { tokens, tokenMeta, themes, pages } = doc;
  const report = getTokenReport(doc);
  full = { tokens, tokenMeta, themes, pages, report };
  return report;
}

/**
 * Report without scanning the nodes (`usage`, `unused`, `broken` and `frames` stay empty): serves callers that only
 * need the token list (picker). Depends only on tokens, metas and themes, not on `pages`.
 */
export function tokenListFor(doc: Document): TokenReport {
  if (same(list, doc, null)) return list.report;
  const { tokens, tokenMeta, themes } = doc;
  const report = getTokenReport({ ...doc, pages: [] });
  list = { tokens, tokenMeta, themes, pages: null, report };
  return report;
}

const scopes = new WeakMap<Document, Map<string, Record<string, string>>>();

/** Variables seen by a node, cached per document and node (several bound fields share the computation). */
export function nodeScopeVars(doc: Document, nodeId: string): Record<string, string> {
  let byNode = scopes.get(doc);
  if (!byNode) scopes.set(doc, (byNode = new Map()));
  let vars = byNode.get(nodeId);
  if (!vars) byNode.set(nodeId, (vars = scopeVarsFor(doc, nodeId)));
  return vars;
}
