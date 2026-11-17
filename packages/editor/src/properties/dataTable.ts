/** Lógica pura da tabela de dados do repetidor: edita a lista e monta as ops `setData`. */
import { dataColumns, templateFields } from '@mockup/core';
import type { DataSource, Node, Op } from '@mockup/core';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** Colunas da tabela: as dos dados e, depois, os campos usados pelo template que faltam nelas. */
export function tableColumns(node: Node): string[] {
  const data = Array.isArray(node.data) ? node.data : [];
  const cols = dataColumns(data);
  for (const f of templateFields(node.children)) {
    if (f.startsWith('$') || f.includes('.')) continue;
    if (!cols.includes(f)) cols.push(f);
  }
  return cols;
}

/** Campos do template que não existem nos dados nem no mapeamento (candidatos a mapear). */
export function unmappedFields(node: Node): string[] {
  const data = Array.isArray(node.data) ? node.data : [];
  const cols = new Set(dataColumns(data));
  const mapping = node.dataSource?.mapping ?? {};
  return templateFields(node.children).filter(
    (f) => !f.startsWith('$') && !f.includes('.') && !cols.has(f) && mapping[f] === undefined,
  );
}

/** Texto mostrado numa célula (objetos e listas viram JSON). */
export function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Converte o texto digitado de volta ao tipo do valor anterior (número, booleano, JSON). */
export function parseCell(text: string, previous: unknown): unknown {
  if (typeof previous === 'number') {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : text;
  }
  if (typeof previous === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  if (previous !== null && typeof previous === 'object') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function setCell(data: unknown[], row: number, column: string, text: string): unknown[] {
  const cur = data[row];
  const base: Row = isRow(cur) ? cur : {};
  const next = [...data];
  next[row] = { ...base, [column]: parseCell(text, base[column]) };
  return next;
}

/** Linha nova com todas as colunas vazias. */
export function addRow(data: unknown[], columns: string[]): unknown[] {
  return [...data, Object.fromEntries(columns.filter((c) => c !== '$item').map((c) => [c, '']))];
}

export function removeRow(data: unknown[], row: number): unknown[] {
  return data.filter((_, i) => i !== row);
}

/** Coluna nova: entra vazia em todas as linhas (se já existir, não muda nada). */
export function addColumn(data: unknown[], column: string): unknown[] {
  return data.map((r) =>
    isRow(r) ? (column in r ? r : { ...r, [column]: '' }) : { [column]: '' },
  );
}

export function removeColumn(data: unknown[], column: string): unknown[] {
  return data.map((r) => {
    if (!isRow(r)) return r;
    const { [column]: _drop, ...rest } = r;
    return rest;
  });
}

/** Op `setData` (uma entrada de undo) com a lista nova e, opcionalmente, a origem. */
export function setDataOp(
  nodeId: string,
  change: { data?: unknown[]; source?: DataSource | null },
): Op {
  return { type: 'setData', changes: [{ nodeId, ...change }] };
}

/** Origem com o mapeamento `campo → coluna` alterado (`column` vazio remove). */
export function withMapping(
  source: DataSource | undefined,
  field: string,
  column: string,
): DataSource {
  const mapping = { ...source?.mapping };
  if (column) mapping[field] = column;
  else delete mapping[field];
  const next: DataSource = { kind: 'inline', ...source };
  if (Object.keys(mapping).length) next.mapping = mapping;
  else delete next.mapping;
  return next;
}

/** Descrição curta da origem para o painel. */
export function describeSource(source: DataSource | undefined): string {
  if (!source || source.kind === 'inline') return 'Dados inline';
  if (source.kind === 'url') return `URL: ${source.url ?? ''}`;
  return `Arquivo ${source.kind.toUpperCase()}: ${source.path ?? ''}`;
}
