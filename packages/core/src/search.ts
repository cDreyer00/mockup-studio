/**
 * Busca de nós num documento (texto, nome, tag HTML, classe exportada, id e atributos) e texto
 * pesquisável do documento (para a busca de arquivos). Sem acento e sem diferenciar caixa.
 */
import { classNameFor } from './html.js';
import type { Document, Node, Page } from './types.js';

export type SearchField = 'text' | 'name' | 'tag' | 'class' | 'id' | 'attr' | 'data';

export interface NodeMatch {
  nodeId: string;
  name: string;
  type: Node['type'];
  tag: string;
  pageId: string;
  pageName: string;
  /** Frame raiz que contém o nó. */
  frameId: string;
  /** Campo que casou primeiro. */
  field: SearchField;
  /** Trecho do valor que casou (até ~80 caracteres). */
  snippet: string;
}

/** Minúsculas e sem acentos/diacríticos. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase();
}

interface ParsedQuery {
  /** Termos livres (todos precisam aparecer em algum campo). */
  terms: string[];
  /** Filtros por campo: `tag:button`, `name:hero`, `text:preço`, `class:card`, `id:tx_`. */
  fields: Partial<Record<SearchField, string[]>>;
}

const FIELD_ALIASES: Record<string, SearchField> = {
  text: 'text',
  texto: 'text',
  name: 'name',
  nome: 'name',
  tag: 'tag',
  class: 'class',
  classe: 'class',
  id: 'id',
  attr: 'attr',
  data: 'data',
  dados: 'data',
};

/** Divide a consulta em termos (aspas agrupam) e filtros `campo:valor`. */
export function parseSearchQuery(query: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], fields: {} };
  const re = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g;
  for (const m of query.matchAll(re)) {
    const key = (m[1] ?? m[3])?.toLowerCase();
    const value = m[2] ?? m[4];
    if (key && value !== undefined && FIELD_ALIASES[key]) {
      const f = FIELD_ALIASES[key];
      (out.fields[f] ??= []).push(foldText(value));
      continue;
    }
    const term = m[5] ?? m[6] ?? (key && value !== undefined ? `${key}:${value}` : '');
    if (term) out.terms.push(foldText(term));
  }
  return out;
}

function snippetOf(value: string, folded: string, term: string): string {
  const i = term ? folded.indexOf(term) : 0;
  const start = Math.max(0, i - 30);
  const s = value.slice(start, start + 80).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + s + (start + 80 < value.length ? '…' : '');
}

function dataText(node: Node): string {
  if (node.type !== 'repeater' || !node.data || node.data.length === 0) return '';
  try {
    return JSON.stringify(node.data).slice(0, 20000);
  } catch {
    return '';
  }
}

function nodeFields(node: Node): [SearchField, string][] {
  const f: [SearchField, string][] = [];
  if (node.text) f.push(['text', node.text]);
  f.push(['name', node.name]);
  f.push(['tag', node.tag]);
  f.push(['class', classNameFor(node)]);
  f.push(['id', node.id]);
  for (const [k, v] of Object.entries(node.attrs)) f.push(['attr', `${k}=${v}`]);
  const dt = dataText(node);
  if (dt) f.push(['data', dt]);
  return f;
}

function matchNode(node: Node, q: ParsedQuery): { field: SearchField; snippet: string } | null {
  const fields = nodeFields(node).map(([k, v]) => ({ k, v, folded: foldText(v) }));
  for (const [key, wanted] of Object.entries(q.fields) as [SearchField, string[]][]) {
    for (const w of wanted) {
      const ok = fields.some(
        (x) => x.k === key && (key === 'tag' ? x.folded === w : x.folded.includes(w)),
      );
      if (!ok) return null;
    }
  }
  let first: { field: SearchField; snippet: string } | null = null;
  for (const t of q.terms) {
    const hit = fields.find((x) => x.folded.includes(t));
    if (!hit) return null;
    first ??= { field: hit.k, snippet: snippetOf(hit.v, hit.folded, t) };
  }
  if (first) return first;
  // Só filtros: o trecho é o do primeiro filtro.
  const [key, wanted] = (Object.entries(q.fields)[0] ?? []) as [SearchField?, string[]?];
  if (!key) return null;
  const hit = fields.find((x) => x.k === key && x.folded.includes(wanted?.[0] ?? ''));
  return hit ? { field: key, snippet: snippetOf(hit.v, hit.folded, wanted?.[0] ?? '') } : null;
}

export interface SearchNodesOptions {
  /** Máximo de resultados (padrão 50). */
  limit?: number;
  /** Restringe a uma página. */
  pageId?: string;
}

/**
 * Busca nós por texto, nome, tag, classe exportada (`classNameFor`), id, atributos e dados de
 * repetidores. Termos livres precisam aparecer todos (em qualquer campo); `tag:button`,
 * `name:hero`, `text:"fale conosco"`, `class:card`, `id:tx_`, `attr:href` filtram por campo.
 */
export function searchNodes(
  doc: Document,
  query: string,
  opts: SearchNodesOptions = {},
): NodeMatch[] {
  const q = parseSearchQuery(query);
  if (q.terms.length === 0 && Object.keys(q.fields).length === 0) return [];
  const limit = opts.limit ?? 50;
  const out: NodeMatch[] = [];
  const visit = (node: Node, page: Page, frameId: string): boolean => {
    const m = matchNode(node, q);
    if (m) {
      out.push({
        nodeId: node.id,
        name: node.name,
        type: node.type,
        tag: node.tag,
        pageId: page.id,
        pageName: page.name,
        frameId,
        field: m.field,
        snippet: m.snippet,
      });
      if (out.length >= limit) return false;
    }
    for (const c of node.children) if (!visit(c, page, frameId)) return false;
    return true;
  };
  for (const page of doc.pages) {
    if (opts.pageId && page.id !== opts.pageId) continue;
    for (const frame of page.frames) if (!visit(frame, page, frame.id)) return out;
  }
  return out;
}

/** Texto pesquisável do documento: nome, páginas, nomes e textos dos nós (limitado a `max`). */
export function documentText(doc: Document, max = 200_000): string {
  const parts: string[] = [doc.name];
  let size = doc.name.length;
  const push = (s: string | undefined): boolean => {
    if (!s) return true;
    parts.push(s);
    size += s.length + 1;
    return size < max;
  };
  const visit = (n: Node): boolean => {
    if (!push(n.name) || !push(n.text)) return false;
    if (n.attrs.alt && !push(n.attrs.alt)) return false;
    for (const c of n.children) if (!visit(c)) return false;
    return true;
  };
  for (const page of doc.pages) {
    if (!push(page.name)) break;
    for (const f of page.frames) if (!visit(f)) return parts.join('\n').slice(0, max);
  }
  return parts.join('\n').slice(0, max);
}
